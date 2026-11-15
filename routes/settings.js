'use strict';

// General settings, system catalog and startup CD-ROM capability.
const {selectedProfile} = require('../common/system-config');

function register({app, session, runner, emit}) {
  const {readConfig} = runner;

  app.get('/api/general-settings', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({sessionId: session.id, engine: session.engine, availableEngines: runner.availableEngines});
  });

  app.put('/api/general-settings', (req, res) => {
    try {
      const engine = req.body?.engine;
      if (!['qemu', 'vbox'].includes(engine) || Object.keys(req.body || {}).some(key => key !== 'engine')) throw new Error('Invalid session engine.');
      if (!runner.availableEngines.includes(engine)) throw new Error('VirtualBox is unavailable on this server.');
      if (engine !== session.engine) {
        if ([...session.nodes.values()].some(node => node.kind === 'host')) {
          return res.status(409).json({error: 'Delete existing hosts before changing the session engine.'});
        }
        session.saveMetadata(engine);
        session.engine = engine;
        emit('general-settings-changed', {sessionId: session.id, engine});
      }
      res.json({sessionId: session.id, engine: session.engine});
    } catch (error) { res.status(400).json({error: error.message}); }
  });

  app.get('/api/systems', (_req, res) => {
    try {
      const config = readConfig();
      res.json(Object.keys(config.systems).filter(id => id !== 'default').map(id => {
        const p = selectedProfile(config, id, session.engine);
        return {id, label: p.label,
          images: {raw: config.systems[id].qemu.image, vdi: config.systems[id].vbox.image},
          memory: p.memory, cpus: p.cpus, clock: p.clock,
          startupDiskEnabled: p.startupDiskEnabled,
          vboxNetworkModel: p.networkModel === 'virtio' ? 'virtio' : '82540EM',
          hasDifferentialDisk: true};
      }));
    } catch (error) { res.status(500).json({error: error.message}); }
  });

  app.get('/api/guest-cdrom-capability', (_req, res) => res.json({autoBuild: true, previewIso: true}));
}

module.exports = {register};
