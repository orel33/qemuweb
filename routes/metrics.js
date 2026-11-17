'use strict';

// Per-host CPU and memory metrics (runner command nodes.metrics).

function register({app, handle}) {
  app.get('/api/metrics', handle('nodes.metrics', () => ({}), 500, {noStore: true}));
}

module.exports = {register};
