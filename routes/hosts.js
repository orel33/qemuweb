'use strict';

// Host creation, configuration and startup CD-ROM. Each route sends one runner command
// (runner/commands/hosts.js).

function register({app, handle}) {
  const node = req => ({nodeId: req.params.nodeId});
  const withBody = req => ({nodeId: req.params.nodeId, body: req.body});
  app.post('/api/hosts', handle('host.create', req => ({body: req.body})));
  app.get('/api/nodes/:nodeId/config', handle('host.config', node, 400, {noStore: true}));
  app.put('/api/nodes/:nodeId/config', handle('host.configure', withBody));
  app.get('/api/nodes/:nodeId/guest-media', handle('host.guestMedia', node));
  app.put('/api/nodes/:nodeId/guest-media', handle('host.setGuestMedia', withBody));
  app.post('/api/nodes/:nodeId/guest-cdrom', handle('host.buildGuestCdrom', withBody));
  app.patch('/api/nodes/:nodeId/guest-cdrom', handle('host.attachGuestCdrom', req => ({nodeId: req.params.nodeId, attached: req.body?.attached})));
}

module.exports = {register};
