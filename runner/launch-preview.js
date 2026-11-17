'use strict';

// Launch preview: the settings, storage paths and commands a host would use, without starting it.
const path = require('path');
const {launchSettingFields, validateLaunchSettings} = require('../common/launch-settings');
const {entityKind} = require('../common/node-id');
const {shellQuote} = require('../common/shell-quote');
const {selectedProfile} = require('../common/system-config');
const {LABEL: GUEST_ISO_LABEL} = require('./media/guest-media');

function createLaunchPreview(ctx) {
  const {requireSessionEngine, imageById, readConfig, qemuOptionsFor, launchSettingsFor, imagePath} = ctx.catalog;
  const {sessionPaths, getNode, tempFile} = ctx.runtime;
  const {validateNetworkInterfaces, assignNetworkInterfaces} = ctx.nics;
  const {qemuArgs, qemuAcceleration} = ctx.qemu;
  const {virtualBoxNetworkArgs, virtualBoxCommands} = ctx.vbox;
  const {qemuOverlayArgs} = ctx.disks;

  function previewLaunch(id, query) {
    if (Object.keys(query).some(key => !['system', 'engine', 'interfaces', 'settings', 'startupDiskEnabled'].includes(key))) {
      throw new Error('Unknown host preview option.');
    }
    if (query.startupDiskEnabled !== undefined && !['true', 'false'].includes(query.startupDiskEnabled)) {
      throw new Error('startupDiskEnabled must be true or false.');
    }
    entityKind(id, 'host');
    const existing = getNode(id);
    const launched = !!(existing && existing.everStarted && existing.selectedImage);
    const image = launched ? existing.selectedImage : imageById(query.system);
    const engine = launched ? existing.engine : query.engine;
    requireSessionEngine(engine);
    if (!image || !['qemu', 'vbox'].includes(engine)) throw new Error('Unknown system or engine.');
    const requestedInterfaces = query.interfaces !== undefined ? JSON.parse(query.interfaces)
      : existing?.networkInterfaces.map(nic => nic.switchId);
    const switches = validateNetworkInterfaces(requestedInterfaces, engine, false);
    const savedInterfaces = existing?.networkInterfaces.map(nic => nic.switchId);
    const previewInterfaces = existing && JSON.stringify(requestedInterfaces) === JSON.stringify(savedInterfaces)
      ? existing.networkInterfaces : assignNetworkInterfaces(existing || {id}, switches);
    const node = launched ? existing : {
      id, ...sessionPaths(id),
      generation: existing?.generation || 0,
      engine, qemuAcceleration: engine.startsWith('qemu') ? qemuAcceleration(engine, false) : null,
      launchSettings: launchSettingsFor(image.id, query.settings ? JSON.parse(query.settings) : {}),
      qemuOptions: null,
      networkInterfaces: previewInterfaces
    };
    const attachGuestCdrom = query.startupDiskEnabled === undefined
      ? (existing?.guestIsoAttached ?? image.startupDiskEnabled) : query.startupDiskEnabled === 'true';
    if (!launched) node.guestIso = existing?.guestIso || null;
    const isQemu = engine.startsWith('qemu');
    const draftSettings = query.settings ? JSON.parse(query.settings) : {};
    const userSettings = launched
      ? validateLaunchSettings({...node.launchSettings, ...draftSettings})
      : launchSettingsFor(image.id, draftSettings);
    const options = isQemu
      ? launched ? {...node.qemuOptions, memory: userSettings.memory, smp: userSettings.cpus, rtcBase: userSettings.clock} : qemuOptionsFor(image.id, userSettings)
      : null;
    if (!launched && isQemu) node.qemuOptions = options;
    const nextGuestIso = tempFile(node, `startup-${node.generation + 1}.iso`);
    const previewNode = {...node, launchSettings: userSettings, networkInterfaces: previewInterfaces, qemuOptions: options,
      guestIsoAttached: attachGuestCdrom,
      guestIso: attachGuestCdrom ? nextGuestIso : null};
    const overlay = launched && node.runDisk ? node.runDisk : tempFile(node, 'disk.qcow2');
    const profile = selectedProfile(readConfig(), image.id, engine);
    const fixed = {
      type: profile.type, arch: profile.arch, mode: profile.mode,
      firmware: profile.firmware, acceleration: profile.acceleration, boot: profile.boot,
      diskInterface: profile.diskInterface, networkModel: profile.networkModel,
      cdromInterface: profile.cdromInterface, extraOptions: profile.extraOptions || []
    };
    const isoCommands = attachGuestCdrom
      ? [[ctx.commands.GENISOIMAGE, '-quiet', '-R', '-J', '-V', GUEST_ISO_LABEL, '-o', nextGuestIso, tempFile(node, '.iso-stage')]]
      : [];
    const vboxDetachCommand = launched && !isQemu && node.activeGuestIso
      ? [[ctx.commands.VBOXMANAGE, 'storageattach', node.vmName, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', 'none']]
      : [];
    const vboxAttachCommand = launched && !isQemu && attachGuestCdrom
      ? [[ctx.commands.VBOXMANAGE, 'storageattach', node.vmName, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', previewNode.guestIso]]
      : [];
    const launchCommands = isQemu
      ? [...(launched ? [] : [[ctx.commands.QEMU_IMG, ...qemuOverlayArgs(image, overlay)]]), [ctx.commands.QEMU_SYSTEM_X86_64, ...qemuArgs(previewNode, image, overlay)]]
      : launched
        ? [...vboxDetachCommand, [ctx.commands.VBOXMANAGE, 'modifyvm', node.vmName, '--memory', String(userSettings.memory), '--cpus', String(userSettings.cpus), '--rtcuseutc', userSettings.clock === 'utc' ? 'on' : 'off', ...virtualBoxNetworkArgs(previewNode, image)], ...vboxAttachCommand, [ctx.commands.VBOXMANAGE, 'startvm', node.vmName, '--type', 'headless']]
        : virtualBoxCommands(previewNode, image).map(args => [ctx.commands.VBOXMANAGE, ...args]);
    const socketLabel = filePath => path.join('runtime', path.relative(ctx.runtimeRoot, filePath));
    const storage = isQemu
      ? [
          {label: 'Base image (RAW)', path: path.relative(ctx.root, imagePath(image.images.raw))},
          {label: 'Working disk (QCOW2 overlay)', path: path.relative(ctx.root, overlay)}
        ]
      : [
          {label: 'Base image (VDI)', path: path.relative(ctx.root, imagePath(image.images.vdi))},
          {label: 'Working disk (VDI differential)', path: path.relative(ctx.root, node.runDisk || tempFile(node, 'disk.vdi'))}
        ];
    storage.push({label: 'Startup disk (cd-rom)', path: attachGuestCdrom ? socketLabel(nextGuestIso) : node.guestIso ? socketLabel(node.guestIso) : 'Not created'});
    return ({launched, engine, settings: userSettings, fields: launchSettingFields, fixed, storage, interfaces: previewInterfaces.map((nic, index) => ({index: index + 1, switch: nic.switchId === null ? 'Disconnected' : `${ctx.session.nodes.get(nic.switchId)?.hostname || nic.switchId} · port ${nic.port}`, port: nic.port, mac: nic.mac})), console: {guest: 'ttyS0 · 115200 baud', socket: socketLabel(node.socketPath)}, console2: isQemu && userSettings.serialPorts.length >= 2 ? {guest: 'ttyS1 · 115200 baud', socket: socketLabel(node.socketPath1)} : null, monitor: isQemu ? socketLabel(node.monitorPath) : null, commands: [...isoCommands, ...launchCommands].map(args => args.map(shellQuote).join(' '))});
  }

  return {previewLaunch};
}

module.exports = {createLaunchPreview};
