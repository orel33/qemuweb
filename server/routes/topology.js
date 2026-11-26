'use strict';

// Topology (.topo) preview, creation and export. Each route sends one runner command
// (runner/commands/topology.js). A load places the session on a runner first, and releases it
// again when it created nothing.

function register({app, handle, placed, runner}) {
  app.post('/api/topology/preview', handle('topology.preview', req => ({body: req.body})));
  app.post('/api/topology', placed, handle('topology.load', req => ({body: req.body}), 400, {release: true}));
  app.get('/api/topology', async (_req, res) => {
    try {
      const {text} = await runner.request('topology.export');
      res.type('text/plain').send(text);
    } catch (error) { res.status(error.status || 400).json({error: error.message}); }
  });
}

module.exports = {register};
