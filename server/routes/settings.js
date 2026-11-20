'use strict';

// General settings, system catalog and startup CD-ROM capability. Each route but the last
// sends one runner command (runner/commands/settings.js).

function register({app, handle}) {
  app.get('/api/general-settings', handle('session.settings', () => ({}), 500, {noStore: true}));
  app.put('/api/general-settings', handle('session.setEngine', req => ({body: req.body})));
  app.get('/api/systems', handle('catalog.systems', () => ({}), 500, {noStore: true}));
  app.get('/api/guest-cdrom-capability', (_req, res) => res.json({autoBuild: true, previewIso: true}));
}

module.exports = {register};
