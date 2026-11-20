'use strict';

// Host lifecycle: start, stop, reboot, reset, deletion.
const fs = require('fs');
const os = require('os');
const {validateLaunchSettings} = require('../common/launch-settings');
const {consoleId} = require('../common/console-id');
const {readStartupFiles} = require('./media/guest-media');
const {waitForChildExit} = require('./engines/child-exit');
const {memoryWarning} = require('./config-warnings');
const {kvmExclusion} = require('./engines/kvm-exclusion');

function createLifecycle(ctx) {
  const {requireSessionEngine, imageById, allocateName, qemuOptionsFor, launchSettingsFor, limitSerialPorts, imagePath} = ctx.catalog;
  const {tempFile, startupDirectory, getNode, setNodeHostname, removeHostnameAlias, activeConfiguration, publishState, appendLog, removeConsoleSockets} = ctx.runtime;
  const {buildGuestIso, cleanupGuestIsoFiles} = ctx.guestIso;
  const {cleanupRunFiles} = ctx.disks;
  const {connectSerial, closeSerial} = ctx.serial;
  const {validateNetworkInterfaces, assignNetworkInterfaces, linkedHosts} = ctx.nics;
  const {stopSwitch} = ctx.vde;
  const {qemuAcceleration, spawnQemu} = ctx.qemu;
  const {sendMonitorCommand} = ctx.monitor;
  const {vbox, removeVirtualBoxMachine, ensureVirtualBoxMachine, guestMediumCommand, virtualBoxNetworkArgs, spawnVirtualBox, virtualBoxState, waitForVirtualBoxPowerOff} = ctx.vbox;

  // Refuses a start that would share VT-x with a running host of the other engine. The user reads
  // a sentence that names only hosts of their own session; the details go to the runner's journal.
  function refuseKvmConflict(node, engine, acceleration) {
    const conflict = kvmExclusion(ctx.hostNodes(), ctx.session.nodes.values(), node, engine, acceleration);
    if (!conflict) return;
    console.error(`[runner] admin diagnostics: ${conflict.diagnostics}`);
    appendLog(node, `# ${conflict.message}`);
    throw new Error(conflict.message);
  }

  function start(nodeId, selectedEngine, imageId, options = {}) {
    const node = getNode(nodeId);
    if (!node) throw new Error('Unknown host configuration.');
    if (node.kind !== 'host') throw new Error('This tab is a VDE switch.');
    if (node.action && !options.reset && !(options.resume && node.action === 'reboot')) throw new Error('An action is already in progress for this host.');
    if (node.machine) throw new Error('This host is already running.');
    const resume = node.everStarted && !options.reset;
    if (resume && (selectedEngine !== node.engine || imageId !== node.selectedImage?.id)) throw new Error('Resume must use the original system and engine.');
    if (resume && (!node.runDisk || !fs.existsSync(node.runDisk))) throw new Error('The current host disk was not found.');
    if (!['qemu', 'vbox'].includes(selectedEngine)) throw new Error('Unknown engine.');
    requireSessionEngine(selectedEngine);
    const acceleration = selectedEngine.startsWith('qemu') ? qemuAcceleration(selectedEngine) : null;
    refuseKvmConflict(node, selectedEngine, acceleration);
    const image = resume ? node.selectedImage : imageById(imageId);
    if (!image) throw new Error('Unknown system in config.json.');
    if (!fs.existsSync(imagePath(image.images.raw))) throw new Error(`RAW image for ${image.label} is missing; run bash scripts/prepare.sh.`);
    if (selectedEngine === 'vbox' && !fs.existsSync(imagePath(image.images.vdi))) throw new Error(`VirtualBox base for ${image.label} is missing; run bash scripts/prepare.sh.`);
    node.guestMedia = readStartupFiles(startupDirectory(node));
    if (options.startupDiskEnabled !== undefined) {
      if (typeof options.startupDiskEnabled !== 'boolean') throw new Error('Invalid startup CD-ROM option.');
      node.guestIsoAttached = options.startupDiskEnabled;
    }
    const launchSettings = resume
      ? limitSerialPorts(validateLaunchSettings({...node.launchSettings, ...(options.settings || {})}), image.id)
      : launchSettingsFor(image.id, options.settings || {});
    const qemuOptions = selectedEngine.startsWith('qemu')
      ? resume ? {...node.qemuOptions, memory: launchSettings.memory, smp: launchSettings.cpus, rtcBase: launchSettings.clock} : qemuOptionsFor(image.id, launchSettings)
      : null;
    if (resume || options.reset) {
      for (const nic of node.networkInterfaces) validateNetworkInterfaces([nic.switchId], selectedEngine);
    } else {
      const switches = validateNetworkInterfaces(options.interfaces, selectedEngine);
      const saved = node.networkInterfaces.map(nic => nic.switchId);
      node.networkInterfaces = JSON.stringify(options.interfaces) === JSON.stringify(saved)
        ? node.networkInterfaces : assignNetworkInterfaces(node, switches);
    }
    const displayName = node.hostname || allocateName('h');
    removeConsoleSockets(node);
    node.stopping = false;
    node.generation += 1;
    if (!options.reset && !resume) node.runLog = [];
    node.serialBuffer = '';
    node.serialBuffer1 = '';
    node.serialFilterPending = '';
    node.serialFilterPassThrough = false;
    node.lastMessage = 'Starting…';
    if (!options.reset && !resume) ctx.events.emit('logs-reset', {nodeId: node.id});
    ctx.events.emit('serial-reset', {nodeId: node.id});
    ctx.events.emit('serial-reset', {nodeId: consoleId(node.id, 1)});
    appendLog(node, `${options.reset ? '# Reset from base image' : resume ? '# Resuming from current disk' : '# Starting'} · ${selectedEngine} · ${image.label}`);
    // The memory reserved by every running host of this runner (all its sessions) plus this one.
    const runningMb = ctx.hostNodes().reduce((sum, other) => sum + (other !== node && other.kind === 'host' && other.machine ? other.launchSettings?.memory || 0 : 0), 0);
    const warning = memoryWarning({runningMb, hostMb: launchSettings.memory, totalBytes: os.totalmem()});
    if (warning) appendLog(node, `# Warning: ${warning}`);
    node.engine = selectedEngine;
    node.qemuAcceleration = acceleration;
    node.selectedImage = image;
    setNodeHostname(node, displayName);
    node.qemuOptions = qemuOptions;
    node.launchSettings = launchSettings;
    if (node.guestIsoAttached) buildGuestIso(node, tempFile(node, `startup-${node.generation}.iso`));
    let machineCreated = false;
    if (selectedEngine === 'vbox' && resume) {
      machineCreated = ensureVirtualBoxMachine(node, image);
      if (!['poweroff', 'aborted'].includes(virtualBoxState(node))) throw new Error('VirtualBox must be powered off before replacing guest startup media.');
    }
    if (node.guestIsoAttached) appendLog(node, `# Guest setup ISO attached: ${node.guestIso} (read-only)`);
    if (selectedEngine.startsWith('qemu')) spawnQemu(node, image, resume);
    else if (resume) {
      vbox(node, ['modifyvm', node.vmName, '--memory', String(launchSettings.memory), '--cpus', String(launchSettings.cpus), '--rtcuseutc', launchSettings.clock === 'utc' ? 'on' : 'off', ...virtualBoxNetworkArgs(node, image)]);
      // The startup ISO of this start (or an empty drive); a machine just created already has it.
      if (!machineCreated) vbox(node, guestMediumCommand(node));
      vbox(node, ['startvm', node.vmName, '--type', 'headless']);
      node.machine = {kind: 'vbox', vmDir: tempFile(node, 'vbox-vm')};
    } else spawnVirtualBox(node, image);
    node.activeGuestIso = node.guestIsoAttached ? node.guestIso : null;
    for (const file of node.guestIsoFiles) if (file !== node.guestIso && file !== node.activeGuestIso) { fs.rmSync(file, {force: true}); node.guestIsoFiles.delete(file); }
    node.everStarted = true;
    node.activeConfig = activeConfiguration(node);
    publishState(node, selectedEngine === 'qemu' ? `QEMU/${node.qemuAcceleration.toUpperCase()} · ${image.label} starting…` : `VirtualBox · ${image.label} starting…`);
    connectSerial(node);
    ctx.guestAgent.watch(node, image);
    return node;
  }

  function validateRestartPrerequisites(node) {
    requireSessionEngine(node.engine);
    if (node.engine.startsWith('qemu')) qemuAcceleration(node.engine);
    refuseKvmConflict(node, node.engine, node.engine.startsWith('qemu') ? 'kvm' : null);
    const image = node.selectedImage;
    if (!fs.existsSync(imagePath(image.images.raw))) throw new Error(`RAW image for ${image.label} is missing; run bash scripts/prepare.sh.`);
    if (node.engine === 'vbox' && !fs.existsSync(imagePath(image.images.vdi))) throw new Error(`VirtualBox base for ${image.label} is missing; run bash scripts/prepare.sh.`);
    for (const nic of node.networkInterfaces) validateNetworkInterfaces([nic.switchId], node.engine);
  }

  async function reboot(node, startup = {}) {
    if (node?.kind === 'switch') throw new Error('Reboot applies only to hosts.');
    if (!node || !node.everStarted) throw new Error('This host has not started yet.');
    if (!node.machine) throw new Error('The host is stopped; use Play to resume from its current disk.');
    if (node.action) throw new Error('An action is already in progress for this host.');
    if (!node.runDisk || !fs.existsSync(node.runDisk)) throw new Error('The current host disk was not found.');
    validateRestartPrerequisites(node);
    node.action = 'reboot';
    try {
      publishState(node, 'Graceful shutdown before reboot…');
      await stop(node, {publish: false});
      if (node.action !== 'reboot' || !ctx.session.nodes.has(node.id)) throw new Error('The node was deleted during reboot.');
      publishState(node, 'Restarting from the current disk…');
      start(node.id, node.engine, node.selectedImage.id, {resume: true, ...startup});
    } catch (error) {
      publishState(node, error.message);
      throw error;
    } finally {
      node.action = null;
      if (node.machine) publishState(node);
    }
  }

  async function reset(node, settings, startup = {}) {
    if (node?.kind === 'switch') throw new Error('Reset applies only to hosts.');
    if (!node || !node.everStarted || !node.selectedImage) throw new Error('This host has not started yet.');
    if (node.action) throw new Error('An action is already in progress for this host.');
    validateRestartPrerequisites(node);
    const engine = node.engine;
    const imageId = node.selectedImage.id;
    const launchSettings = settings ? limitSerialPorts(validateLaunchSettings({...node.launchSettings, ...settings}), imageId) : node.launchSettings;
    node.action = 'reset';
    try {
      publishState(node, 'Resetting from the base image…');
      if (node.machine) await stop(node, {publish: false});
      if (node.action !== 'reset' || !ctx.session.nodes.has(node.id)) throw new Error('The node was deleted during reset.');
      discardNodeDisk(node);
      node.everStarted = false;
      start(node.id, engine, imageId, {reset: true, settings: launchSettings, ...startup});
    } catch (error) {
      node.everStarted = !!node.runDisk;
      publishState(node, error.message);
      throw error;
    } finally {
      node.action = null;
      if (node.machine) publishState(node);
    }
  }

  function discardNodeDisk(node) {
    const image = node.selectedImage;
    if (node.engine === 'vbox') {
      removeVirtualBoxMachine(node, image);
    }
    cleanupRunFiles(node, image);
    node.activeGuestIso = null;
    for (const file of node.guestIsoFiles) if (file !== node.guestIso) { fs.rmSync(file, {force: true}); node.guestIsoFiles.delete(file); }
  }

  async function stop(node, options = {}) {
    if (!node || !node.machine) return;
    const ownAction = !node.action;
    if (ownAction) node.action = 'stop';
    node.stopping = true;
    const current = node.machine;
    try {
      if (current.kind === 'vbox') {
        try {
          vbox(node, ['controlvm', node.vmName, 'acpipowerbutton']);
          await waitForVirtualBoxPowerOff(node, 10000);
        } catch (error) {
          const state = virtualBoxState(node);
          if (!['poweroff', 'aborted', 'saved'].includes(state)) {
            if (options.forceOnTimeout === false) throw new Error(`Host did not power off gracefully: ${error.message}`);
            appendLog(node, `# Graceful VirtualBox shutdown failed: ${error.message}; forcing power off`);
            vbox(node, ['controlvm', node.vmName, 'poweroff']);
          }
        }
      } else {
        try {
          appendLog(node, '$ QEMU monitor: system_powerdown');
          await sendMonitorCommand(node, 'system_powerdown');
          await waitForChildExit(current, 10000);
        } catch (error) {
          if (options.forceOnTimeout === false) throw new Error(`Host did not power off gracefully: ${error.message}`);
          appendLog(node, `# Graceful QEMU shutdown failed: ${error.message}; sending SIGTERM`);
          current.kill('SIGTERM');
          try { await waitForChildExit(current, 2000); }
          catch (_) {
            appendLog(node, '$ signal sent to qemu-system-x86_64: SIGKILL');
            current.kill('SIGKILL');
            await waitForChildExit(current, 5000);
          }
        }
      }
      closeSerial(node);
      ctx.guestAgent.unwatch(node);
      if (node.machine === current) node.machine = null;
      node.activeConfig = null;
      removeConsoleSockets(node);
      if (options.publish !== false && node.action !== 'destroy') publishState(node, 'Host stopped; current disk kept');
    } finally {
      node.stopping = false;
      if (ownAction && node.action === 'stop') node.action = null;
    }
  }

  async function destroyNode(node) {
    if (!node) return;
    if (node.kind === 'switch') {
      if (linkedHosts(node.id).length) throw new Error('Remove connected host tabs before deleting this switch.');
      await stopSwitch(node, true);
      removeHostnameAlias(node);
      ctx.session.nodes.delete(node.id);
      fs.rmSync(node.runtimeDir, {recursive: true, force: true});
      ctx.session.saveMetadata();
      return;
    }
    node.action = 'destroy';
    node.stopping = true;
    node.generation += 1;
    ctx.captureLive.stopNode(node.id);
    ctx.capture.nodeRemoved(node);
    closeSerial(node);
    ctx.guestAgent.unwatch(node);
    const current = node.machine;
    const image = node.selectedImage || {};
    node.machine = null;
    node.activeConfig = null;
    if (current && current.kind !== 'vbox') {
      appendLog(node, '$ force kill qemu-system-x86_64: SIGKILL');
      current.kill('SIGKILL');
      try { await waitForChildExit(current, 5000); } catch (_) {}
    }
    // The node may hold a VirtualBox machine and disk even when the session engine is QEMU now.
    const vdi = tempFile(node, 'disk.vdi');
    if (current?.kind === 'vbox' || fs.existsSync(vdi) || fs.existsSync(tempFile(node, 'vbox-vm'))) {
      removeVirtualBoxMachine(node, image, {poweroff: current?.kind === 'vbox', files: [vdi]});
    }
    cleanupRunFiles(node, image);
    removeConsoleSockets(node);
    cleanupGuestIsoFiles(node);
    node.runLog = [];
    node.serialBuffer = '';
    node.serialBuffer1 = '';
    node.selectedImage = null;
    node.qemuOptions = null;
    node.everStarted = false;
    removeHostnameAlias(node);
    ctx.session.nodes.delete(node.id);
    fs.rmSync(node.runtimeDir, {recursive: true, force: true});
    ctx.session.saveMetadata();
  }

  async function exitAllNodes() {
    const removed = [];
    try {
      for (const kind of ['host', 'switch']) {
        for (const node of [...ctx.session.nodes.values()].filter(item => item.kind === kind)) {
          await destroyNode(node);
          removed.push(node.id);
        }
      }
      return removed;
    } finally {
      if (removed.length) ctx.events.emit('nodes-removed', {ids: removed});
    }
  }

  return {start, reboot, reset, stop, destroyNode, exitAllNodes};
}

module.exports = {createLifecycle};
