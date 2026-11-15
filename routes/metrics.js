'use strict';

// Per-host CPU and memory metrics.


function register({app, session, runner, emit}) {


  app.get('/api/metrics', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(runner.metricsSnapshot());
  });
}

module.exports = {register};
