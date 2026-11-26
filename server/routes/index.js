'use strict';

// HTTP API of one session. Each session gets its own router, built when the session is
// created, whose handlers close over that session and its runner handle only
// (server/runner-client.js session()): a request reaches the router of its user's session
// (req.workspace) and can never name a node of another one. Node routes send one runner
// command each; the runner answers 404 for a node ID that is not in the session.
// The session may not be placed on a runner yet (server/session-manager.js): its handle then
// answers as an empty session. The routes that create nodes (a host, a switch, a load) first
// place it (`placed`, 503 when no runner is available), and those that may leave it empty (a node
// removed, a load) release it afterwards (`release`, a no-op while it still has nodes).
const express = require('express');
const {isCaptureId, interfaceIndex} = require('../../common/capture');
const {kindOfName, isExampleName} = require('../examples');

const ROUTE_MODULES = ['session', 'settings', 'nodes', 'hosts', 'topology', 'archives', 'examples', 'metrics', 'captures'];
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
  const capture = /^(POST|DELETE|GET) \/api\/nodes\/([^/]+)\/captures(?:\/([^/]+)(?:\/(stop|download))?)?$/.exec(key);
  if (capture) {
    const [, method, id, captureId, action] = capture;
    const event = method === 'POST' && !captureId ? 'capture-started' : method === 'POST' && action === 'stop' ? 'capture-stopped'
      : method === 'DELETE' && captureId && !action ? 'capture-deleted' : method === 'GET' && action === 'download' ? 'capture-downloaded' : null;
    if (event) {
      const iface = interfaceIndex(req.body?.interface);
      return {event, target: {nodeId: nodeId(id), ...(isCaptureId(captureId) ? {captureId} : {}), ...(event === 'capture-started' && iface !== null ? {interface: `eth${iface}`} : {})}};
    }
  }
  switch (key) {
    case 'POST /api/switches': return {event: 'node-created', target: {nodeId: nodeId(req.body?.id), kind: 'switch'}};
    case 'POST /api/hosts': return {event: 'node-created', target: {nodeId: nodeId(req.body?.id), kind: 'host'}};
    case 'POST /api/session/reset': return {event: 'session-reset', target: {}};
    case 'POST /api/nodes/stop-all': return {event: 'node-stopped', target: {all: true}};
    case 'POST /api/nodes/resume-all': return {event: 'node-started', target: {all: true}};
    case 'POST /api/topology': return {event: 'archive-loaded', target: {kind: 'topology'}};
    case 'GET /api/topology': return {event: 'archive-saved', target: {kind: 'topology'}};
    case 'POST /api/examples/load': return isExampleName(req.body?.name) ? {event: 'archive-loaded', target: {kind: kindOfName(req.body.name), example: req.body.name}} : null;
    case 'POST /api/session-archive/import': return {event: 'archive-loaded', target: {kind: 'session'}};
    case 'POST /api/session-archive/export': return {event: 'archive-saved', target: {kind: 'session'}};
    default: return null;
  }
}

// The log entries of a request, written once the response is sent with "ok" or the HTTP error
// status: [log ('user' or 'admin'), login, event, target] each. The owner's user events go to
// users.log. The admin holding the control lock of the session (req.observedControl) acts as
// the owner: each of its user events goes to admin.log (who, on whose session: {login: owner})
// and to the owner's users.log ({by: admin}); any other write of the admin goes to admin.log as
// controlled-request {login, method, path}. Other observers write nothing (they only read).
function auditEntries(req, owner) {
  const logged = userEvent(req);
  if (!req.observed) return logged ? [['user', owner, logged.event, logged.target]] : [];
  if (!req.observedControl) return [];
  if (logged) return [['admin', req.user.login, logged.event, {login: owner, ...logged.target}], ['user', owner, logged.event, {...logged.target, by: req.user.login}]];
  if (['GET', 'HEAD'].includes(req.method)) return [];
  return [['admin', req.user.login, 'controlled-request', {login: owner, method: req.method, path: String(req.path).slice(0, 200)}]];
}

// runner: the session's runner handle. userLog (server/audit.js createUserLog) and audit
// (admin.log) receive the entries of auditEntries. examplesDir is the --examples directory
// (none: no example). lifecycle: {begin(), place(), release(), reset(by)} of this session
// (server/session-manager.js beginCreation, place, release and reset).
const NO_LIFECYCLE = {begin: () => () => {}, place: async () => {}, release: async () => {}, reset: async () => ({reset: true})};
function createSessionRouter({session, runner, userLog = {record() {}}, audit = {record() {}}, examplesDir = null, lifecycle = NO_LIFECYCLE}) {
  const router = express.Router();
  router.use((req, res, next) => {
    for (const [log, ...entry] of auditEntries(req, session.owner)) {
      res.once('finish', () => (log === 'admin' ? audit : userLog).record(...entry, res.statusCode < 400 ? 'ok' : `error: HTTP ${res.statusCode}`));
    }
    next();
  });
  router.use('/api', (req, res, next) => {
    if (session.archiveBusy && !['GET', 'HEAD'].includes(req.method)) return res.status(409).json({error: 'Session archive operation in progress.'});
    next();
  });
  // Middleware of the routes that create nodes: the session is placed on a runner first, and no release
  // runs until the creation ends (req.endCreation, called before the route's own release, else when
  // the response is over).
  const placed = (req, res, next) => {
    const end = lifecycle.begin();
    req.endCreation = end;
    res.once('finish', end);
    res.once('close', end);
    lifecycle.place().then(() => next(), error => {
      end();
      res.status(error.status || 503).json({error: error.message});
    });
  };
  // The release that follows a command which may have left the session empty.
  const releaseAfter = async req => {
    req.endCreation?.();
    await lifecycle.release();
  };
  // A route that sends one runner command: args(req) builds its arguments; the result is the
  // JSON response, an error answers with the runner's status or `status`. With `release`, the
  // session is released before the answer if the command left it empty.
  const handle = (command, args, status = 400, {noStore = false, release = false} = {}) => async (req, res) => {
    let result, failure = null;
    try { result = await runner.request(command, args(req)); }
    catch (error) { failure = error; }
    if (release) await releaseAfter(req);
    if (failure) return res.status(failure.status || status).json({error: failure.message});
    if (noStore) res.set('Cache-Control', 'no-store');
    res.json(result);
  };
  const context = {app: router, session, runner, handle, placed, releaseAfter, lifecycle, examplesDir};
  for (const name of ROUTE_MODULES) require(`./${name}`).register(context);
  return router;
}

module.exports = {createSessionRouter, userEvent, auditEntries};
