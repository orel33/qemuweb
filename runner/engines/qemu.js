'use strict';

// QEMU engine: acceleration check, command line, launch.
const fs = require('fs');
const {spawn} = require('child_process');
const {shellQuote} = require('../../common/shell-quote');

function createQemu(ctx) {
  const {tempFile, appendLog, publishState, execLogged, removeConsoleSockets} = ctx.runtime;
  const {qemuOverlayArgs} = ctx.disks;

  function qemuArgs(node, image, overlay) {
    const settings = node.qemuOptions;
    const common = [
      ...settings.extraOptions, '-accel', node.qemuAcceleration,
      '-display', settings.display, '-m', String(settings.memory), '-smp', String(settings.smp),
      '-rtc', `base=${settings.rtcBase}`, '-monitor', `unix:${node.monitorPath},server=on,wait=off`,
      '-serial', `unix:${node.socketPath},server=on,wait=off`
    ];
    // The next -serial is COM2, ttyS1 in the guest.
    if (node.launchSettings.serialPorts.length >= 2) common.push('-serial', `unix:${node.socketPath1},server=on,wait=off`);
    // The QEMU guest agent channel (docs/guest-agent.md): only for a system whose image carries the agent. It
    // must be declared at boot (a PCI device cannot be hot-added on q35). The socket is read by
    // runner/guest-agent.js, which sends one fixed read-only command.
    if (image?.guestAgent) {
      common.push('-chardev', `socket,id=qga,path=${node.guestAgentPath},server=on,wait=off`,
        '-device', 'virtio-serial-pci', '-device', 'virtserialport,chardev=qga,name=org.qemu.guest_agent.0');
    }
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
    // Only this user may connect to the agent socket (the mode of a socket follows the umask).
    if (image?.guestAgent) fs.chmodSync(node.runtimeDir, 0o700);
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
        ctx.guestAgent.unwatch(node);
        removeConsoleSockets(node);
        ctx.capture.hostStopped(node, child);
        publishState(node, `QEMU error: ${error.message}`);
      }
    });
    child.once('exit', code => {
      removeConsoleSockets(node);
      if (node.machine === child) { node.machine = null; node.activeConfig = null; ctx.guestAgent.unwatch(node); }
      ctx.capture.hostStopped(node, child);
      if (node.stopping || node.action === 'reboot' || node.action === 'reset' || node.action === 'destroy') return;
      publishState(node, `QEMU stopped (${code})`);
    });
  }

  return {qemuArgs, qemuAcceleration, spawnQemu};
}

module.exports = {createQemu};
