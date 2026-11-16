'use strict';

// HTTP API of one session. Each session gets its own router, built when the session is
// created, whose handlers close over that session and its runner only: a request reaches
// the router of its user's session (req.workspace) and can never name a node of another one.
const express = require('express');

const ROUTE_MODULES = ['settings', 'nodes', 'hosts', 'topology', 'archives', 'metrics'];
const NODE_ID = /^[hs]-[0-9a-f]{16}$/;

// The users.log event of a request of the owner, or null. Only explicit actions on nodes and
// archives: never polling, console traffic or file contents. A node ID from a request body
// is kept only when it has the node ID format.
function userEvent(req) {
  const nodeId = id => (NODE_ID.test(id) ? id : null);
  const key = `${req.method} ${req.path}`;
  const node = /^(POST|DELETE) \/api\/nodes\/([^/]+)(?:\/(start|stop))?$/.exec(key);
  if (node && node[1] === 'POST' && node[3]) return {event: node[3] === 'start' ? 'node-started' : 'node-stopped', target: {nodeId: nodeId(node[2])}};
  if (node && node[1] === 'DELETE' && !node[3]) return {event: 'node-deleted', target: {nodeId: nodeId(node[2])}};
  switch (key) {
    case 'POST /api/switches': return {event: 'node-created', target: {nodeId: nodeId(req.body?.id), kind: 'switch'}};
    case 'POST /api/hosts': return {event: 'node-created', target: {nodeId: nodeId(req.body?.id), kind: 'host'}};
    case 'DELETE /api/nodes': return {event: 'node-deleted', target: {all: true}};
    case 'POST /api/nodes/stop-all': return {event: 'node-stopped', target: {all: true}};
    case 'POST /api/nodes/resume-all': return {event: 'node-started', target: {all: true}};
    case 'POST /api/topology': return {event: 'archive-loaded', target: {kind: 'topology'}};
    case 'GET /api/topology': return {event: 'archive-saved', target: {kind: 'topology'}};
    case 'POST /api/session-archive/import': return {event: 'archive-loaded', target: {kind: 'session'}};
    case 'POST /api/session-archive/export': return {event: 'archive-saved', target: {kind: 'session'}};
    default: return null;
  }
}

// emit(event, payload) sends a per-session event to every browser of this session; userLog
// (lib/audit.js createUserLog) receives the owner's node and archive actions, written once the
// response is sent, with "ok" or the HTTP error status.
function createSessionRouter({session, runner, commands, emit, userLog = {record() {}}}) {
  const router = express.Router();
  router.use((req, res, next) => {
    const logged = !req.observed && userEvent(req);
    if (logged) res.once('finish', () => userLog.record(session.owner, logged.event, logged.target, res.statusCode < 400 ? 'ok' : `error: HTTP ${res.statusCode}`));
    next();
  });
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

module.exports = {createSessionRouter, userEvent};
