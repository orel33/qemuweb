'use strict';

// The session itself: Reset session (UXS02), the one destructive action of a user. It stops and
// removes every node; the session stays, empty and no longer placed on a runner
// (server/session-manager.js reset). The owner, or the administrator holding the control lock of
// the session (the observation gate lets nobody else write here). Audited as session-reset
// (server/routes/index.js userEvent).

function register({app, session, lifecycle}) {
  app.post('/api/session/reset', async (req, res) => {
    try { res.json(await lifecycle.reset(req.observedControl ? req.user.login : session.owner)); }
    catch (error) { res.status(error.status || 409).json({error: error.message}); }
  });
}

module.exports = {register};
