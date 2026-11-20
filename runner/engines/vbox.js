'use strict';

// VirtualBox engine: VBoxManage commands, launch, state.
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const {explainVirtualBoxFailure, failureText, firstErrorLine} = require('./vbox-errors');
const {readVdiHeader} = require('../media/vdi');

function createVirtualBox(ctx) {
  const {tempFile, execLogged, appendLog} = ctx.runtime;
  const {imagePath} = ctx.catalog;
  const {cleanupRunFiles} = ctx.disks;

  // Runs VBoxManage. A failure is written to the host's Log (the explanation of a known cause, then
  // the VBoxManage text) and thrown with a short message for the interface.
  function vbox(node, args) {
    try { return execLogged(node, ctx.commands.VBOXMANAGE, args, {stdio: 'pipe'}); }
    catch (error) {
      const text = failureText(error);
      const explanation = explainVirtualBoxFailure(text);
      if (explanation) appendLog(node, `# ${explanation}`);
      appendLog(node, text);
      throw new Error(explanation || `VirtualBox: ${firstErrorLine(text)}`, {cause: error});
    }
  }

  // A cleanup step: its failure is expected (the VM may not exist yet) and is not reported.
  function vboxIgnoringFailure(node, args) {
    try { execLogged(node, ctx.commands.VBOXMANAGE, args, {stdio: 'pipe'}); } catch (_) { /* nothing to clean */ }
  }

  // Unregisters the VM and removes what the node created: its differencing disk(s) and VM folder.
  // Never passes --delete to unregistervm (VirtualBox would also delete the registered parent, the
  // base image), and removes the disk by path, only inside the node's own run directory.
  function removeVirtualBoxMachine(node, image, {poweroff = false, files = image.runFiles || []} = {}) {
    if (poweroff) vboxIgnoringFailure(node, ['controlvm', node.vmName, 'poweroff']);
    vboxIgnoringFailure(node, ['unregistervm', node.vmName]);
    const runDir = path.resolve(node.runtimeDir) + path.sep;
    for (const file of files) {
      if (!path.resolve(file).startsWith(runDir)) { appendLog(node, `# Not removing ${file}: outside the host's run directory`); continue; }
      vboxIgnoringFailure(node, ['closemedium', 'disk', file]);
      fs.rmSync(file, {force: true});
    }
    fs.rmSync(tempFile(node, 'vbox-vm'), {recursive: true, force: true});
  }

  function virtualBoxNetworkArgs(node, image) {
    const args = [];
    for (let index = 0; index < 4; index++) {
      const number = index + 1;
      const nic = node.networkInterfaces[index];
      if (!nic) { args.push(`--nic${number}`, 'none'); continue; }
      args.push(`--nic${number}`, nic.switchId === null ? 'null' : 'generic',
        `--nictype${number}`, image.virtualbox.networkModel,
        `--macaddress${number}`, nic.mac.replaceAll(':', '').toUpperCase(),
        `--cableconnected${number}`, 'on');
      if (nic.switchId !== null) {
        const sw = ctx.session.nodes.get(nic.switchId);
        if (!sw || sw.kind !== 'switch') throw new Error(`Unknown VDE switch for Ethernet ${index}.`);
        args.push(`--nicgenericdrv${number}`, 'VDE',
          `--nicproperty${number}`, `network=${sw.socketDir}[${nic.port}]`);
      }
    }
    return args;
  }

  // The command that puts the startup ISO in the DVD drive (port 1 of 'Guest setup'), or empties the drive. With
  // --type dvddrive it also creates the drive when the slot has none; it never uses `--medium none` (a detach, which
  // fails with "No storage device attached to device slot 0 on port 1" when there is no drive).
  function guestMediumCommand(node) {
    return ['storageattach', node.vmName, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive',
      '--medium', node.guestIsoAttached && node.guestIso ? node.guestIso : 'emptydrive'];
  }

  // existingDisk: the host already has its disk.vdi (loaded from an archive): attach it instead of
  // creating the differencing disk; the VM is not started.
  function virtualBoxCommands(node, image, {existingDisk = false} = {}) {
    const vmDir = tempFile(node, 'vbox-vm');
    const disk = tempFile(node, 'disk.vdi');
    const commands = [
      ['createvm', '--name', node.vmName, '--basefolder', vmDir, '--ostype', image.virtualbox.osType, '--register'],
      ['modifyvm', node.vmName, '--memory', String(node.launchSettings.memory), '--cpus', String(node.launchSettings.cpus), '--rtcuseutc', node.launchSettings.clock === 'utc' ? 'on' : 'off', '--firmware', image.virtualbox.firmware, ...virtualBoxNetworkArgs(node, image), '--uart1', '0x3F8', '4', '--uartmode1', 'server', node.socketPath],
      ...(existingDisk ? [] : [['createmedium', 'disk', '--filename', disk, '--diffparent', imagePath(image.images.vdi), '--format', 'VDI']]),
      ['storagectl', node.vmName, '--name', 'SATA', '--add', image.virtualbox.diskBus, '--controller', image.virtualbox.diskController],
      ['storageattach', node.vmName, '--storagectl', 'SATA', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', disk],
      ['storagectl', node.vmName, '--name', 'Guest setup', '--add', image.virtualbox.cdromBus, '--controller', image.virtualbox.cdromController],
      // The DVD drive always exists (empty when there is no startup ISO), so that a later start can change or
      // empty its medium: VirtualBox cannot detach or replace the medium of a slot that has no drive.
      guestMediumCommand(node),
      ['modifyvm', node.vmName, '--boot1', 'disk', '--boot2', 'dvd', '--boot3', 'none', '--boot4', 'none'],
      ['startvm', node.vmName, '--type', 'headless']
    ];
    return existingDisk ? commands.slice(0, -1) : commands;
  }

  function virtualBoxMachineExists(node) {
    try { execFileSync(ctx.commands.VBOXMANAGE, ['showvminfo', node.vmName, '--machinereadable'], {stdio: 'pipe'}); return true; }
    catch (_) { return false; }
  }

  // The UUIDs of the media in the output of `VBoxManage list hdds`.
  function registeredMediaUuids(output) {
    return [...String(output).matchAll(/^UUID:\s*([0-9a-f-]{36})\s*$/gim)].map(match => match[1].toLowerCase());
  }

  // A disk.vdi loaded from an archive has no VirtualBox machine around it: creates the machine and
  // attaches that disk. VirtualBox resolves the parent of a differencing disk in its global media
  // registry, which forgets a base image once nothing uses it (after Remove all, or in another
  // session), so the base is registered again first: the way that surely works is the one of the
  // first start, a differencing medium of the base (a probe file in the node directory, closed
  // after the attach); the registry is then CHECKED for the parent UUID of the saved disk.
  // The disk file stays untouched on failure (Reset discards it). Only files of the node's own
  // directory are written, no medium is deleted by VirtualBox and the base image is never modified.
  // Returns true when it created the machine (its DVD drive already holds the right medium), false when it existed.
  function ensureVirtualBoxMachine(node, image) {
    if (virtualBoxMachineExists(node)) return false;
    const disk = tempFile(node, 'disk.vdi');
    const base = imagePath(image.images.vdi);
    const probe = tempFile(node, 'parent-probe.vdi');
    if (!fs.existsSync(disk)) throw new Error('The current host disk was not found.');
    const advice = 'Use Reset to start from the base image.';
    let child, parent;
    try { child = readVdiHeader(disk); parent = readVdiHeader(base); }
    catch (error) { throw new Error(`Cannot read the saved VirtualBox disk or its base image: ${error.message} ${advice}`, {cause: error}); }
    if (child.parentUuid !== parent.uuid) {
      throw new Error(`The saved VirtualBox disk belongs to another build of the base image (its parent is ${child.parentUuid}, the base image is ${parent.uuid}). ${advice}`);
    }
    const dropProbe = () => { vboxIgnoringFailure(node, ['closemedium', 'disk', probe]); fs.rmSync(probe, {force: true}); };
    appendLog(node, '# Creating the VirtualBox machine around the saved disk');
    fs.mkdirSync(tempFile(node, 'vbox-vm'), {recursive: true});
    try {
      // A new identity for the loaded disk: another copy of it may be registered already.
      vbox(node, ['internalcommands', 'sethduuid', disk]);
      fs.rmSync(probe, {force: true});
      vbox(node, ['createmedium', 'disk', '--filename', probe, '--diffparent', base, '--format', 'VDI']);
      if (!registeredMediaUuids(vbox(node, ['list', 'hdds'])).includes(parent.uuid)) {
        throw new Error(`VirtualBox did not register the base image ${path.basename(base)} (UUID ${parent.uuid}).`);
      }
      for (const args of virtualBoxCommands(node, image, {existingDisk: true})) vbox(node, args);
      dropProbe();
      return true;
    } catch (error) {
      dropProbe();
      vboxIgnoringFailure(node, ['unregistervm', node.vmName]);
      fs.rmSync(tempFile(node, 'vbox-vm'), {recursive: true, force: true});
      throw new Error(`Cannot attach the saved VirtualBox disk: ${error.message} ${advice}`, {cause: error});
    }
  }

  function spawnVirtualBox(node, image) {
    const vmDir = tempFile(node, 'vbox-vm');
    fs.mkdirSync(vmDir, {recursive: true});
    try {
      const disk = tempFile(node, 'disk.vdi');
      image.runFiles = [disk];
      node.runDisk = disk;
      for (const args of virtualBoxCommands(node, image)) vbox(node, args);
      node.machine = {kind: 'vbox', vmDir};
    } catch (error) {
      removeVirtualBoxMachine(node, image, {poweroff: true});
      cleanupRunFiles(node, image);
      throw error;
    }
  }

  function virtualBoxState(node) {
    const output = execFileSync(ctx.commands.VBOXMANAGE, ['showvminfo', node.vmName, '--machinereadable'], {encoding: 'utf8'});
    const match = output.match(/^VMState="([^"]+)"/m);
    return match ? match[1] : 'unknown';
  }

  async function waitForVirtualBoxPowerOff(node, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = virtualBoxState(node);
      if (state === 'poweroff' || state === 'aborted' || state === 'saved') return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('The host did not respond to the graceful shutdown request.');
  }

  return {vbox, removeVirtualBoxMachine, ensureVirtualBoxMachine, virtualBoxMachineExists, virtualBoxNetworkArgs, virtualBoxCommands, guestMediumCommand, spawnVirtualBox, virtualBoxState, waitForVirtualBoxPowerOff};
}

module.exports = {createVirtualBox};
