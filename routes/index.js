'use strict';

// HTTP API of one session. Each session gets its own router, built when the session is
// created, whose handlers close over that session and its runner handle only
// (lib/runner-client.js session()): a request reaches the router of its user's session
// (req.workspace) and can never name a node of another one. Node routes send one runner
// command each; the runner answers 404 for a node ID that is not in the session.
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

// runner: the session's runner handle. userLog (lib/audit.js createUserLog) receives the
// owner's node and archive actions, written once the response is sent, with "ok" or the HTTP
// error status.
function createSessionRouter({session, runner, userLog = {record() {}}}) {
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
  // A route that sends one runner command: args(req) builds its arguments; the result is the
  // JSON response, an error answers with the runner's status or `status`.
  const handle = (command, args, status = 400, {noStore = false} = {}) => async (req, res) => {
    try {
      const result = await runner.request(command, args(req));
      if (noStore) res.set('Cache-Control', 'no-store');
      res.json(result);
    } catch (error) { res.status(error.status || status).json({error: error.message}); }
  };
  const context = {app: router, session, runner, handle};
  for (const name of ROUTE_MODULES) require(`./${name}`).register(context);
  return router;
}

module.exports = {createSessionRouter, userEvent};
