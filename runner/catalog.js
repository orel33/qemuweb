'use strict';

// System catalog helpers: image lookup, launch settings, QEMU options, engine selection.
const path = require('path');
const {validateQemuOptions, validateLaunchSettings} = require('../common/launch-settings');
const {readCatalog, selectedProfile, serialConsoleLimit} = require('../common/system-config');

function createCatalog(ctx) {
  function requireSessionEngine(engine) {
    if (!ctx.availableEngines.includes(engine)) throw new Error(`${engine === 'vbox' ? 'VirtualBox' : 'QEMU'} is unavailable on this server.`);
    if (engine !== ctx.session.engine) throw new Error(`Engine ${engine} differs from this session's ${ctx.session.engine} engine. Change General Settings before adding hosts.`);
  }

  function imageById(id) {
    const catalog = readConfig();
    if (!catalog.systems[id] || id === 'default') return null;
    const qemu = selectedProfile(catalog, id, 'qemu');
    const vbox = selectedProfile(catalog, id, 'vbox');
    const active = selectedProfile(catalog, id, ctx.session.engine);
    return {id, label: active.label, startupDiskEnabled: active.startupDiskEnabled, serialConsoles: serialConsoleLimit(active),
      images: {raw: qemu.image, vdi: vbox.image},
      virtualbox: {osType: 'Linux_64', networkModel: vbox.networkModel === 'virtio' ? 'virtio' : '82540EM',
        firmware: vbox.firmware, diskBus: vbox.diskInterface,
        diskController: 'IntelAhci', cdromBus: vbox.cdromInterface,
        cdromController: 'PIIX4'}};
  }

  function allocateName(prefix) {
    const used = new Set([...ctx.session.nodes.values()].map(node => node.hostname).filter(Boolean));
    for (let n = 1; n <= 99; n++) {
      const name = `${prefix}${n}`;
      if (!used.has(name)) return name;
    }
    throw new Error(`All 99 ${prefix === 'h' ? 'host' : 'switch'} names have been used.`);
  }

  function readConfig() {
    return readCatalog(ctx.configPath);
  }

  function qemuOptionsFor(imageId, overrides = {}) {
    const p = selectedProfile(readConfig(), imageId, 'qemu');
    const settings = validateLaunchSettings({memory: p.memory, cpus: p.cpus, clock: p.clock, serialConsoles: serialConsoleLimit(p), ...overrides});
    const extra = Object.fromEntries([0, 2, 4].map(index => [p.extraOptions[index], p.extraOptions[index + 1]]));
    return validateQemuOptions({machine: extra['-machine'], cpuKvm: extra['-cpu'], display: p.mode === 'text' ? 'none' : null,
      diskInterface: p.diskInterface, networkModel: p.networkModel === 'virtio' ? 'virtio-net-pci' : 'e1000',
      bootDisk: 'c', nic: extra['-nic'], extraOptions: [...p.extraOptions],
      memory: settings.memory, smp: settings.cpus, rtcBase: settings.clock});
  }

  function launchSettingsFor(imageId, overrides = {}) {
    const p = selectedProfile(readConfig(), imageId, ctx.session.engine);
    return limitSerialConsoles(validateLaunchSettings({memory: p.memory, cpus: p.cpus, clock: p.clock, serialConsoles: serialConsoleLimit(p), ...overrides}), imageId);
  }

  // Rejects more consoles than the system exposes on the session engine.
  function limitSerialConsoles(settings, imageId) {
    const limit = serialConsoleLimit(selectedProfile(readConfig(), imageId, ctx.session.engine));
    if (settings.serialConsoles > limit) throw new Error(`This system exposes only ${limit} console(s).`);
    return settings;
  }

  function imagePath(file) { return path.resolve(ctx.root, file); }

  return {requireSessionEngine, imageById, allocateName, readConfig, qemuOptionsFor, launchSettingsFor, limitSerialConsoles, imagePath};
}

module.exports = {createCatalog};
