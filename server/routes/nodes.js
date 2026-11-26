'use strict';

// Node listing, switches, start, stop, Resume all, Stop all, reboot, reset, monitor, rename
// and deletion. Each route sends one runner command (runner/commands/nodes.js). The node
// positions of the Graphic view are read here (runner/commands/layout.js) and written through
// the node-position socket event (server/sockets.js), by the session's driver only.

function register({app, handle}) {
  const node = req => ({nodeId: req.params.nodeId});
  app.get('/api/nodes', handle('nodes.list', () => ({}), 500));
  app.get('/api/graphic-layout', handle('layout.get', () => ({}), 500, {noStore: true}));
  app.get('/api/nodes/:nodeId/options', handle('node.preview', req => ({nodeId: req.params.nodeId, query: req.query})));
  app.post('/api/nodes/stop-all', handle('nodes.stopAll', () => ({}), 409));
  app.post('/api/nodes/resume-all', handle('nodes.startAll', () => ({}), 409));
  app.post('/api/nodes/:nodeId/start', handle('node.start', req => ({...node(req), engine: req.body?.engine, imageId: req.body?.imageId}), 500));
  app.post('/api/switches', handle('switch.create', req => {
    const {id, name, autostart} = req.body || {};
    return {id, name, autostart};
  }));
  app.post('/api/nodes/:nodeId/stop', handle('node.stop', node, 500));
  app.post('/api/nodes/:nodeId/reboot', handle('node.reboot', node, 500));
  app.post('/api/nodes/:nodeId/reset', handle('node.reset', node, 500));
  app.post('/api/nodes/:nodeId/monitor', handle('node.monitor', req => ({...node(req), command: req.body && req.body.command})));
  app.patch('/api/nodes/:nodeId', handle('node.rename', req => ({...node(req), name: req.body && req.body.name})));
  app.delete('/api/nodes', handle('nodes.deleteAll', () => ({}), 500));
  app.delete('/api/nodes/:nodeId', handle('node.delete', node, 500));
}

module.exports = {register};
