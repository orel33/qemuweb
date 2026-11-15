'use strict';

// QEMU engine: acceleration check, command line, launch.
const fs = require('fs');
const {spawn} = require('child_process');
const {ctx} = require('../context');
const {shellQuote} = require('../../common/shell-quote');
const {tempFile, appendLog, publishState, execLogged} = require('../session-runtime');
const {qemuOverlayArgs} = require('../media/disks');

function qemuArgs(node, image, overlay) {
  const settings = node.qemuOptions;
  const common = [
    ...settings.extraOptions, '-accel', node.qemuAcceleration,
    '-display', settings.display, '-m', String(settings.memory), '-smp', String(settings.smp),
    '-rtc', `base=${settings.rtcBase}`, '-monitor', `unix:${node.monitorPath},server=on,wait=off`,
    '-serial', `unix:${node.socketPath},server=on,wait=off`
  ];
  // QEMU PC boot notation: c = first hard disk.
  const args = [...common, '-drive', `file=${overlay},if=${settings.diskInterface},format=qcow2,media=disk`, '-boot', `order=${settings.bootDisk}`];
  if (node.guestIsoAttached && node.guestIso) args.push('-drive', `file=${node.guestIso},if=ide,index=2,media=cdrom,readonly=on,format=raw`);
  // The profile's -nic none disables QEMU's implicit user-network NIC.
  for (const [index, nic] of node.networkInterfaces.entries()) {
    if (nic.switchId === null) {
      args.push('-device', `${settings.networkModel},mac=${nic.mac}`);
      continue;
    }
    const sw = ctx.session.nodes.get(nic.switchId);
    const id = `lan${index}`;
    args.push('-netdev', `vde,id=${id},sock=${sw.socketDir},port=${nic.port}`,
      '-device', `${settings.networkModel},netdev=${id},mac=${nic.mac}`);
  }
  return args;
}

function qemuAcceleration(engine, checkAvailability = true) {
  if (engine !== 'qemu') throw new Error('Unknown QEMU acceleration mode.');
  if (!checkAvailability) return 'kvm';
  const virtualBoxRunning = [...ctx.session.nodes.values()].some(other => other.machine && other.engine === 'vbox');
  if (virtualBoxRunning) throw new Error('QEMU/KVM cannot start while a VirtualBox host is running. Stop that host first.');
  try { fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK); }
  catch (_) { throw new Error('QEMU/KVM is unavailable: /dev/kvm is missing or not accessible. Enable KVM or select VirtualBox if it is installed.'); }
  return 'kvm';
}

function spawnQemu(node, image, reuseDisk = false) {
  const overlay = reuseDisk ? node.runDisk : tempFile(node, 'disk.qcow2');
  if (!overlay || !fs.existsSync(overlay)) {
    if (reuseDisk) throw new Error('The current host disk was not found.');
    execLogged(node, ctx.commands.QEMU_IMG, qemuOverlayArgs(image, overlay), {stdio: 'pipe'});
  }
  image.runFiles = [overlay];
  node.runDisk = overlay;
  const args = qemuArgs(node, image, overlay);
  appendLog(node, `$ ${[ctx.commands.QEMU_SYSTEM_X86_64, ...args].map(shellQuote).join(' ')}`);
  const child = spawn(ctx.commands.QEMU_SYSTEM_X86_64, args, {stdio: ['ignore', 'pipe', 'pipe']});
  node.machine = child;
  child.stdout.on('data', data => { console.log('qemu:', data.toString().trim()); appendLog(node, data.toString()); });
  child.stderr.on('data', data => { console.log('qemu:', data.toString().trim()); appendLog(node, data.toString()); });
  child.once('error', error => {
    if (node.machine === child) {
      node.machine = null;
      node.activeConfig = null;
      node.everStarted = !!node.runDisk;
      try { fs.unlinkSync(node.socketPath); } catch (_) {}
      try { fs.unlinkSync(node.monitorPath); } catch (_) {}
      publishState(node, `QEMU error: ${error.message}`);
    }
  });
  child.once('exit', code => {
    try { fs.unlinkSync(node.socketPath); } catch (_) {}
    try { fs.unlinkSync(node.monitorPath); } catch (_) {}
    if (node.machine === child) { node.machine = null; node.activeConfig = null; }
    if (node.stopping || node.action === 'reboot' || node.action === 'reset' || node.action === 'destroy') return;
    publishState(node, `QEMU stopped (${code})`);
  });
}

module.exports = {qemuArgs, qemuAcceleration, spawnQemu};
