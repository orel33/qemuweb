'use strict';

// Host lifecycle: start, stop, reboot, reset, deletion.
const fs = require('fs');
const {validateLaunchSettings} = require('../common/launch-settings');
const {selectedProfile, profileHash} = require('../common/system-config');
const {readStartupFiles} = require('./media/guest-media');
const {waitForChildExit} = require('./engines/child-exit');

function createLifecycle(ctx) {
  const {requireSessionEngine, imageById, allocateName, readConfig, qemuOptionsFor, launchSettingsFor, imagePath} = ctx.catalog;
  const {tempFile, startupDirectory, getNode, setNodeHostname, removeHostnameAlias, activeConfiguration, publishState, appendLog} = ctx.runtime;
  const {buildGuestIso, cleanupGuestIsoFiles} = ctx.guestIso;
  const {cleanupRunFiles} = ctx.disks;
  const {connectSerial} = ctx.serial;
  const {validateNetworkInterfaces, assignNetworkInterfaces, linkedHosts} = ctx.nics;
  const {stopSwitch} = ctx.vde;
  const {qemuAcceleration, spawnQemu} = ctx.qemu;
  const {sendMonitorCommand} = ctx.monitor;
  const {vbox, virtualBoxNetworkArgs, spawnVirtualBox, virtualBoxState, waitForVirtualBoxPowerOff} = ctx.vbox;

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
    if (selectedEngine === 'vbox') {
      const qemuWithKvm = ctx.hostNodes().some(other => other.kind === 'host' && other.machine && other.engine.startsWith('qemu') && other.qemuAcceleration === 'kvm');
      if (qemuWithKvm) throw new Error('VirtualBox cannot start while a QEMU/KVM host is running. Stop that host first.');
    }
    const image = resume ? node.selectedImage : imageById(imageId);
    if (!image) throw new Error('Unknown system in config.json.');
    if (node.profileHash && node.profileHash !== profileHash(selectedProfile(readConfig(), image.id, selectedEngine))) {
      throw new Error(`System profile changed for ${node.hostname}; restore its original config.json or recreate the host.`);
    }
    if (!fs.existsSync(imagePath(image.images.raw))) throw new Error(`RAW image for ${image.label} is missing; run bash scripts/prepare.sh.`);
    if (selectedEngine === 'vbox' && !fs.existsSync(imagePath(image.images.vdi))) throw new Error(`VirtualBox base for ${image.label} is missing; run bash scripts/prepare.sh.`);
    node.guestMedia = readStartupFiles(startupDirectory(node));
    if (options.startupDiskEnabled !== undefined) {
      if (typeof options.startupDiskEnabled !== 'boolean') throw new Error('Invalid startup CD-ROM option.');
      node.guestIsoAttached = options.startupDiskEnabled;
    }
    const launchSettings = resume
      ? validateLaunchSettings({...node.launchSettings, ...(options.settings || {})})
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
    if (fs.existsSync(node.socketPath)) fs.unlinkSync(node.socketPath);
    node.stopping = false;
    node.generation += 1;
    if (!options.reset && !resume) node.runLog = [];
    node.serialBuffer = '';
    node.serialFilterPending = '';
    node.serialFilterPassThrough = false;
    node.lastMessage = 'Starting…';
    if (!options.reset && !resume) ctx.events.emit('logs-reset', {nodeId: node.id});
    ctx.events.emit('serial-reset', {nodeId: node.id});
    appendLog(node, `${options.reset ? '# Reset from base image' : resume ? '# Resuming from current disk' : '# Starting'} · ${selectedEngine} · ${image.label}`);
    node.engine = selectedEngine;
    node.qemuAcceleration = acceleration;
    node.selectedImage = image;
    setNodeHostname(node, displayName);
    node.qemuOptions = qemuOptions;
    node.launchSettings = launchSettings;
    if (node.guestIsoAttached) buildGuestIso(node, tempFile(node, `startup-${node.generation}.iso`));
    if (selectedEngine === 'vbox' && resume) {
      if (!['poweroff', 'aborted'].includes(virtualBoxState(node))) throw new Error('VirtualBox must be powered off before replacing guest startup media.');
      if (node.activeGuestIso) vbox(node, ['storageattach', node.vmName, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', 'none']);
    }
    if (node.guestIsoAttached) appendLog(node, `# Guest setup ISO attached: ${node.guestIso} (read-only)`);
    if (selectedEngine.startsWith('qemu')) spawnQemu(node, image, resume);
    else if (resume) {
      vbox(node, ['modifyvm', node.vmName, '--memory', String(launchSettings.memory), '--cpus', String(launchSettings.cpus), '--rtcuseutc', launchSettings.clock === 'utc' ? 'on' : 'off', ...virtualBoxNetworkArgs(node, image)]);
      if (node.guestIsoAttached) vbox(node, ['storageattach', node.vmName, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', node.guestIso]);
      vbox(node, ['startvm', node.vmName, '--type', 'headless']);
      node.machine = {kind: 'vbox', vmDir: tempFile(node, 'vbox-vm')};
    } else spawnVirtualBox(node, image);
    node.activeGuestIso = node.guestIsoAttached ? node.guestIso : null;
    for (const file of node.guestIsoFiles) if (file !== node.guestIso && file !== node.activeGuestIso) { fs.rmSync(file, {force: true}); node.guestIsoFiles.delete(file); }
    node.everStarted = true;
    node.activeConfig = activeConfiguration(node);
    publishState(node, selectedEngine === 'qemu' ? `QEMU/${node.qemuAcceleration.toUpperCase()} · ${image.label} starting…` : `VirtualBox · ${image.label} starting…`);
    connectSerial(node);
    return node;
  }

  function validateRestartPrerequisites(node) {
    requireSessionEngine(node.engine);
    if (node.engine.startsWith('qemu')) qemuAcceleration(node.engine);
    else if (ctx.hostNodes().some(other => other !== node && other.machine && other.engine === 'qemu' && other.qemuAcceleration === 'kvm')) {
      throw new Error('VirtualBox cannot start while a QEMU/KVM host is running. Stop that host first.');
    }
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
    const launchSettings = settings ? validateLaunchSettings({...node.launchSettings, ...settings}) : node.launchSettings;
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
      vbox(node, ['unregistervm', node.vmName]);
      for (const file of image.runFiles || []) {
        try { vbox(node, ['closemedium', 'disk', file, '--delete']); }
        catch (error) { appendLog(node, `# VirtualBox medium already unregistered: ${error.message}`); }
      }
      fs.rmSync(tempFile(node, 'vbox-vm'), {recursive: true, force: true});
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
      if (node.serial) { node.serial.destroy(); node.serial = null; }
      if (node.machine === current) node.machine = null;
      node.activeConfig = null;
      try { fs.unlinkSync(node.socketPath); } catch (_) {}
      try { fs.unlinkSync(node.monitorPath); } catch (_) {}
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
    if (node.serial) { node.serial.destroy(); node.serial = null; }
    const current = node.machine;
    const image = node.selectedImage || {};
    node.machine = null;
    node.activeConfig = null;
    if (node.engine === 'vbox' && node.everStarted && node.selectedImage) {
      if (current) { try { vbox(node, ['controlvm', node.vmName, 'poweroff']); } catch (_) {} }
      try { vbox(node, ['unregistervm', node.vmName]); } catch (_) {}
      for (const file of image.runFiles || []) {
        try { vbox(node, ['closemedium', 'disk', file, '--delete']); } catch (_) {}
      }
      fs.rmSync(tempFile(node, 'vbox-vm'), {recursive: true, force: true});
    } else if (current) {
      appendLog(node, '$ force kill qemu-system-x86_64: SIGKILL');
      current.kill('SIGKILL');
      try { await waitForChildExit(current, 5000); } catch (_) {}
    }
    cleanupRunFiles(node, image);
    try { fs.unlinkSync(node.socketPath); } catch (_) {}
    try { fs.unlinkSync(node.monitorPath); } catch (_) {}
    cleanupGuestIsoFiles(node);
    node.runLog = [];
    node.serialBuffer = '';
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
