'use strict';

// HTTP API of one session. Each session gets its own router, built when the session is
// created, whose handlers close over that session and its runner only: a request reaches
// the router of its user's session (req.workspace) and can never name a node of another one.
const express = require('express');

const ROUTE_MODULES = ['settings', 'nodes', 'hosts', 'topology', 'archives', 'metrics'];
const NODE_ID = /^[hs]-[0-9a-f]{16}$/;

// emit(event, payload) sends a per-session event to every browser of this session.
function createSessionRouter({session, runner, commands, emit}) {
  const router = express.Router();
  router.use('/api', (req, res, next) => {
    if (session.archiveBusy && !['GET', 'HEAD'].includes(req.method)) return res.status(409).json({error: 'Session archive operation in progress.'});
    next();
  });
  // A well-formed node ID that is not in this session is unknown (404). The launch preview
  // also describes host drafts that do not exist yet, so it is the only exception.
  router.param('nodeId', (req, res, next, nodeId) => {
    if (!NODE_ID.test(nodeId) || session.nodes.has(nodeId) || /^\/api\/nodes\/[^/]+\/options$/.test(req.path)) return next();
    res.status(404).json({error: 'Unknown host or switch.'});
  });
  const context = {app: router, session, runner, commands, emit};
  for (const name of ROUTE_MODULES) require(`./${name}`).register(context);
  return router;
}

module.exports = {createSessionRouter};
