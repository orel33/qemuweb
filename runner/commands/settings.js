'use strict';

// Session settings and system catalog commands. Each command receives {session, runner, emit}
// (runner/service.js) and the request arguments; its result is the JSON body of the matching
// HTTP route.
const {selectedProfile, serialConsoleLimit} = require('../../common/system-config');
const {statusError} = require('./errors');

const commands = {
  'session.settings': ({session, runner}) => ({sessionId: session.id, engine: session.engine, availableEngines: runner.availableEngines}),

  'session.setEngine': ({session, runner, emit}, {body}) => {
    const engine = body?.engine;
    if (!['qemu', 'vbox'].includes(engine) || Object.keys(body || {}).some(key => key !== 'engine')) throw new Error('Invalid session engine.');
    if (!runner.availableEngines.includes(engine)) throw new Error('VirtualBox is unavailable on this server.');
    if (engine !== session.engine) {
      if ([...session.nodes.values()].some(node => node.kind === 'host')) {
        throw statusError('Delete existing hosts before changing the session engine.', 409);
      }
      session.saveMetadata(engine);
      session.engine = engine;
      emit('general-settings-changed', {sessionId: session.id, engine});
    }
    return {sessionId: session.id, engine: session.engine};
  },

  'catalog.systems': ({session, runner}) => {
    const config = runner.readConfig();
    return Object.keys(config.systems).filter(id => id !== 'default').map(id => {
      const p = selectedProfile(config, id, session.engine);
      return {id, label: p.label,
        images: {raw: config.systems[id].qemu.image, vdi: config.systems[id].vbox.image},
        memory: p.memory, cpus: p.cpus, clock: p.clock,
        startupDiskEnabled: p.startupDiskEnabled, serialConsoles: serialConsoleLimit(p),
        vboxNetworkModel: p.networkModel === 'virtio' ? 'virtio' : '82540EM',
        hasDifferentialDisk: true};
    });
  }
};

module.exports = {commands};
