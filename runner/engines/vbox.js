'use strict';

// VirtualBox engine: VBoxManage commands, launch, state.
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const {explainVirtualBoxFailure, failureText, firstErrorLine} = require('./vbox-errors');

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
  function removeVirtualBoxMachine(node, image, {poweroff = false} = {}) {
    if (poweroff) vboxIgnoringFailure(node, ['controlvm', node.vmName, 'poweroff']);
    vboxIgnoringFailure(node, ['unregistervm', node.vmName]);
    const runDir = path.resolve(node.runtimeDir) + path.sep;
    for (const file of image.runFiles || []) {
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

  function virtualBoxCommands(node, image) {
    const vmDir = tempFile(node, 'vbox-vm');
    const disk = tempFile(node, 'disk.vdi');
    return [
      ['createvm', '--name', node.vmName, '--basefolder', vmDir, '--ostype', image.virtualbox.osType, '--register'],
      ['modifyvm', node.vmName, '--memory', String(node.launchSettings.memory), '--cpus', String(node.launchSettings.cpus), '--rtcuseutc', node.launchSettings.clock === 'utc' ? 'on' : 'off', '--firmware', image.virtualbox.firmware, ...virtualBoxNetworkArgs(node, image), '--uart1', '0x3F8', '4', '--uartmode1', 'server', node.socketPath],
      ['createmedium', 'disk', '--filename', disk, '--diffparent', imagePath(image.images.vdi), '--format', 'VDI'],
      ['storagectl', node.vmName, '--name', 'SATA', '--add', image.virtualbox.diskBus, '--controller', image.virtualbox.diskController],
      ['storageattach', node.vmName, '--storagectl', 'SATA', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', disk],
      ['storagectl', node.vmName, '--name', 'Guest setup', '--add', image.virtualbox.cdromBus, '--controller', image.virtualbox.cdromController],
      ...(node.guestIsoAttached ? [['storageattach', node.vmName, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', node.guestIso]] : []),
      ['modifyvm', node.vmName, '--boot1', 'disk', '--boot2', 'dvd', '--boot3', 'none', '--boot4', 'none'],
      ['startvm', node.vmName, '--type', 'headless']
    ];
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

  return {vbox, removeVirtualBoxMachine, virtualBoxNetworkArgs, virtualBoxCommands, spawnVirtualBox, virtualBoxState, waitForVirtualBoxPowerOff};
}

module.exports = {createVirtualBox};
