'use strict';

// Administration: the /admin page, the /api/admin/* API and the observation gate.
// Every route of the API lives in one router whose first middleware checks the role, so that
// a non-admin gets 403 on any path under /api/admin, even an unknown one. server.js mounts it
// before the middleware that opens the caller's own session: an admin call never opens one.
// Every action that changes something is written to the audit log (lib/audit.js); reading the
// session list is not.
const path = require('path');
const express = require('express');
const {LOGIN_PATTERN, readUsers, createAccount, setPassword, setRole, setDisabled} = require('../lib/auth/users-store');

// Summary of one session for the supervision table.
function sessionSummary({owner, session, runner}, adminLogin) {
  const nodes = [...session.nodes.values()];
  const hosts = nodes.filter(node => node.kind === 'host');
  const runningHosts = hosts.filter(node => node.machine);
  const runningSwitches = nodes.filter(node => node.kind === 'switch' && node.machine);
  const metrics = runner.metricsSnapshot();
  const cpu = runningHosts.map(node => metrics[node.id]?.cpuPercent).filter(Number.isFinite);
  return {
    login: owner, own: owner === adminLogin, sessionId: session.id, createdAt: session.createdAt,
    lastActivity: session.lastActivityAt, nodes: nodes.length, hosts: hosts.length, switches: nodes.length - hosts.length,
    runningHosts: runningHosts.length, runningSwitches: runningSwitches.length,
    reservedRamMb: runningHosts.reduce((sum, node) => sum + (node.launchSettings?.memory || 0), 0),
    cpuPercent: cpu.length ? Math.round(cpu.reduce((sum, value) => sum + value, 0) * 10) / 10 : null,
    active: runningHosts.length + runningSwitches.length > 0
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

// disconnectUser(login) closes the user's Socket.IO connections (sockets.js).
function createAdminRouter({manager, auth, audit, disconnectUser}) {
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
        if (await manager.remove(login)) deleted.push(login);
        else failed.push({login, error: 'No session.'});
      } catch (error) { failed.push({login, error: error.message}); }
    }
    return {deleted, failed};
  }

  router.get('/sessions', (req, res) => {
    res.json(manager.list().map(workspace => sessionSummary(workspace, req.user.login))
      .sort((a, b) => a.login.localeCompare(b.login)));
  });

  // Preview of a cleanup: sessions without activity for `hours`, the caller's own excluded.
  router.get('/sessions/inactive', (req, res) => {
    const hours = Number(req.query.hours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 365) return res.status(400).json({error: 'Give a number of hours between 0 and 8760.'});
    const limit = Date.now() - hours * 3600 * 1000;
    const logins = manager.list().filter(({owner, session}) => owner !== req.user.login && Date.parse(session.lastActivityAt) <= limit)
      .map(workspace => workspace.owner).sort();
    res.json({hours, logins});
  });

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

  router.post('/sessions/:login/observe', (req, res) => {
    const {login} = req.params;
    audited(req, res, 'observe', {login}, () => {
      const {session} = workspaceOf(login);
      return {login, sessionId: session.id};
    });
  });

  router.post('/sessions/:login/stop', (req, res) => {
    const {login} = req.params;
    audited(req, res, 'stop-all', {login}, async () => ({stopped: await workspaceOf(login).runner.stopAllNodes()}), () => 409);
  });

  router.delete('/sessions/:login', (req, res) => {
    const {login} = req.params;
    audited(req, res, 'delete-session', {login}, async () => {
      workspaceOf(login);
      return {deleted: await manager.remove(login)};
    }, () => 409);
  });

  router.get('/users', (_req, res) => {
    res.json(readUsers(usersFile).map(user => ({login: user.login, role: user.role, disabled: !!user.disabled,
      session: !!manager.get(user.login)})));
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

  router.use((_req, res) => res.status(404).json({error: 'Unknown administration route.'}));
  return router;
}

module.exports = {createAdminRouter, observationGate, adminPage, sessionSummary};
