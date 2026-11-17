'use strict';

// Administration: the /admin page, the /api/admin/* API and the observation gate.
// Every route of the API lives in one router whose first middleware checks the role, so that
// a non-admin gets 403 on any path under /api/admin, even an unknown one. server.js mounts it
// before the middleware that opens the caller's own session: an admin call never opens one.
// Every action that changes something is written to logs/admin.log (lib/audit.js); reading the
// session list is not.
const path = require('path');
const express = require('express');
const {LOG_NAMES, readLogTail} = require('../lib/audit');
const {runnersHandler} = require('./admin-runners');
const {LOGIN_PATTERN, readUsers, createAccount, setPassword, setRole, setDisabled, removeAccount} = require('../lib/auth/users-store');

// Summary of one session for the supervision table: the control plane's own fields, and the
// counts the session's runner reports (runner/commands/consoles.js session.summary).
// browsers: the owner's connected browser tabs (sockets.js).
async function sessionSummary({owner, session, runner}, adminLogin, browsers = 0) {
  const counts = await runner.request('session.summary');
  return {
    login: owner, own: owner === adminLogin, browsers, sessionId: session.id, createdAt: session.createdAt,
    lastActivity: session.lastActivityAt, nodes: counts.nodes, hosts: counts.hosts, switches: counts.switches,
    runningHosts: counts.runningHosts, runningSwitches: counts.runningSwitches, reservedRamMb: counts.reservedRamMb,
    cpuPercent: counts.cpuPercent, active: counts.active
  };
}

// HTTP status of a users-store error.
function accountErrorStatus(error) {
  if (/^Unknown user/.test(error.message)) return 404;
  if (/already exists/.test(error.message)) return 409;
  return 400;
}

// Requests carrying "X-Observe: <login>" read another user's session instead of the caller's:
// admins only, GET and HEAD only, never creating a session. Observing your own login is
// just your own session. Sets req.observed to the observed workspace.
function observationGate(manager) {
  return (req, res, next) => {
    const login = req.get('X-Observe');
    if (!login || login === req.user.login) return next();
    if (req.user.role !== 'admin') return res.status(403).json({error: 'Administrator role required to observe a session.'});
    if (!['GET', 'HEAD'].includes(req.method)) return res.status(403).json({error: 'Read-only observation: this action is not allowed.'});
    const workspace = LOGIN_PATTERN.test(login) ? manager.get(login) : null;
    if (!workspace) return res.status(404).json({error: `No session for ${login}.`});
    req.observed = workspace;
    next();
  };
}

// The /admin page, for admins only.
function adminPage(root) {
  const file = path.join(root, 'public', 'admin.html');
  return (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.user?.role !== 'admin') return res.status(403).type('text').send('Administrator role required.');
    res.sendFile(file);
  };
}

// disconnectUser(login) closes the user's Socket.IO connections, browsers(login) counts the
// user's connected browser tabs (sockets.js); logDir holds admin.log and users.log; `local` and
// `port` describe how the server was started (the Runners panel, routes/admin-runners.js).
function createAdminRouter({manager, auth, audit, disconnectUser, browsers, logDir, local = false, port}) {
  const router = express.Router();
  const usersFile = auth.usersFile;
  router.use(auth.requireAdmin);
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // Runs an audited action: answers its result as JSON, or the error with `status(error)`.
  async function audited(req, res, action, target, run, status = () => 400) {
    try {
      const result = await run();
      audit.record(req.user.login, action, target, 'ok');
      res.json(result);
    } catch (error) {
      audit.record(req.user.login, action, target, error);
      res.status(error.status || status(error)).json({error: error.message});
    }
  }

  function workspaceOf(login) {
    const workspace = typeof login === 'string' && LOGIN_PATTERN.test(login) ? manager.get(login) : null;
    if (!workspace) throw Object.assign(new Error(`No session for ${login}.`), {status: 404});
    return workspace;
  }

  // Deletes sessions one after the other (each stops its QEMU/VDE processes and removes
  // runtime/sessions/<id>/). The caller's own session is never part of a bulk deletion.
  async function deleteSessions(adminLogin, logins) {
    const deleted = [], failed = [];
    for (const login of logins) {
      if (login === adminLogin) { failed.push({login, error: 'Your own session is excluded.'}); continue; }
      try {
        if (await manager.remove(login, adminLogin)) deleted.push(login);
        else failed.push({login, error: 'No session.'});
      } catch (error) { failed.push({login, error: error.message}); }
    }
    return {deleted, failed};
  }

  router.get('/sessions', async (req, res) => {
    try {
      const summaries = await Promise.all(manager.list().map(workspace => sessionSummary(workspace, req.user.login, browsers(workspace.owner))));
      res.json(summaries.sort((a, b) => a.login.localeCompare(b.login)));
    } catch (error) { res.status(error.status || 500).json({error: error.message}); }
  });

  router.get('/runners', runnersHandler({manager, local, port}));

  router.post('/sessions/delete', (req, res) => {
    const logins = req.body?.logins;
    if (!Array.isArray(logins) || !logins.length || logins.length > 1000 || logins.some(login => typeof login !== 'string')) {
      return res.status(400).json({error: 'Give the list of sessions to delete.'});
    }
    const unique = [...new Set(logins)];
    audited(req, res, 'bulk-delete', {logins: unique}, async () => {
      const result = await deleteSessions(req.user.login, unique);
      if (result.failed.length) {
        const error = new Error(`Not deleted: ${result.failed.map(item => `${item.login} (${item.error})`).join(', ')}`);
        error.status = 409;
        throw error;
      }
      return result;
    });
  });

  router.post('/sessions/:login/stop', (req, res) => {
    const {login} = req.params;
    audited(req, res, 'stop-all', {login}, async () => workspaceOf(login).runner.request('nodes.stopAll'), () => 409);
  });

  router.delete('/sessions/:login', (req, res) => {
    const {login} = req.params;
    audited(req, res, 'delete-session', {login}, async () => {
      workspaceOf(login);
      return {deleted: await manager.remove(login, req.user.login)};
    }, () => 409);
  });

  router.get('/users', (_req, res) => {
    res.json(readUsers(usersFile).map(user => ({login: user.login, role: user.role, disabled: !!user.disabled})));
  });

  router.post('/users', (req, res) => {
    const {login, password, role = 'student'} = req.body || {};
    audited(req, res, 'create-account', {login, role}, () => createAccount(usersFile, {login, password, role}), accountErrorStatus);
  });

  router.post('/users/:login/password', (req, res) => {
    const {login} = req.params;
    audited(req, res, 'reset-password', {login}, () => setPassword(usersFile, login, req.body?.password), accountErrorStatus);
  });

  // {disabled: true|false} or {role}. An admin cannot disable or demote their own account here.
  router.patch('/users/:login', (req, res) => {
    const {login} = req.params;
    const body = req.body || {};
    const keys = Object.keys(body);
    if (keys.length !== 1 || !['disabled', 'role'].includes(keys[0])) return res.status(400).json({error: 'Change either "disabled" or "role".'});
    if (login === req.user.login) return res.status(403).json({error: 'You cannot disable your own account or change its role.'});
    const action = keys[0] === 'role' ? 'set-role' : body.disabled ? 'disable-account' : 'enable-account';
    audited(req, res, action, {login, ...(keys[0] === 'role' ? {role: body.role} : {})}, () => {
      const user = keys[0] === 'role' ? setRole(usersFile, login, body.role) : setDisabled(usersFile, login, body.disabled);
      // Open sockets were authorized with the previous state: close them.
      disconnectUser(login);
      return user;
    }, accountErrorStatus);
  });

  // Removes the account from users.json (its cookies are refused from the next request on),
  // closes its sockets, then deletes its session if it has one. Not for your own account.
  router.delete('/users/:login', (req, res) => {
    const {login} = req.params;
    if (login === req.user.login) return res.status(403).json({error: 'You cannot remove your own account.'});
    const target = {login, session: !!manager.get(login)};
    audited(req, res, 'remove-account', target, async () => {
      removeAccount(usersFile, login);
      disconnectUser(login);
      const sessionDeleted = await manager.remove(login, req.user.login);
      return {login, removed: true, sessionDeleted};
    }, accountErrorStatus);
  });

  // The last entries of admin.log or users.log (read from the end of the file), and the raw
  // file. Reading the logs is not audited: the /admin page polls them.
  const logFile = name => (Object.hasOwn(LOG_NAMES, name) ? path.join(logDir, LOG_NAMES[name]) : null);
  router.get('/logs/:name', (req, res) => {
    const file = logFile(req.params.name);
    if (!file) return res.status(404).json({error: 'Unknown log.'});
    const lines = req.query.lines === undefined ? 200 : Number(req.query.lines);
    if (!Number.isInteger(lines) || lines < 1 || lines > 1000) return res.status(400).json({error: 'lines must be between 1 and 1000.'});
    try { res.json({name: req.params.name, entries: readLogTail(file, lines)}); }
    catch (error) { res.status(500).json({error: `Cannot read the log: ${error.message}`}); }
  });
  router.get('/logs/:name/download', (req, res) => {
    const file = logFile(req.params.name);
    if (!file) return res.status(404).json({error: 'Unknown log.'});
    res.download(file, LOG_NAMES[req.params.name], error => {
      if (error && !res.headersSent) res.status(error.code === 'ENOENT' ? 404 : 500).json({error: error.code === 'ENOENT' ? 'The log is empty.' : error.message});
    });
  });

  router.use((_req, res) => res.status(404).json({error: 'Unknown administration route.'}));
  return router;
}

module.exports = {createAdminRouter, observationGate, adminPage, sessionSummary};
