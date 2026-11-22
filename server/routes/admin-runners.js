'use strict';

// The runners panel of /admin (admins only; the router is mounted by server/routes/admin.js, which
// passes its `audited` helper: every change is written to logs/admin.log, listing is not).
//   GET    /runners                         {runners, connectHint, registrationTokens, runnerGraceSeconds, lifetimes}
//   POST   /runners/registration-tokens     {minutes: 15|60|1440} -> {id, token, expiresAt, command}: shown once
//   DELETE /runners/registration-tokens/:id cancels an unused token
//   POST   /runners/:id/pause | /resume     drain: no new session is placed, the running ones continue
//   POST   /runners/:id/revoke              invalidates the runner and disconnects it (a revoked runner is refused)
//   DELETE /runners/:id                     forgets an offline, revoked runner
// The rows are the same for every runner, "local" included (its record is created at start by --local-runner): there is no flag that tells them apart. A runner summary: {id, name, state, paused,
// lastSeen, address, directory, pid, engines, kvm, cpus, memoryBytes, systems, warnings, sessions,
// maxSessions}; state is online, starting, offline or revoked; directory and pid are what the runner
// announced (text for the administrator, never used). Never a token or a token hash.
// connectHint is the command that starts the local runner, while no runner is online and the server runs with --local-runner; null otherwise.
const express = require('express');
const {LIFETIMES_MINUTES} = require('../runner-registration');
const {RUNNER_ID} = require('../runner-store');
const {tokenFilePath} = require('../../common/local-token');
const DEFAULT_PORT = 3002;

function summarize({entry, record, sessions}) {
  const capabilities = entry?.capabilities || {};
  const live = entry && entry.state !== 'lost';
  const lastSeen = live ? null : (entry?.lostAt ? new Date(entry.lostAt).toISOString() : record.lastSeenAt || null);
  return {
    id: record.id, name: record.name,
    state: record.revoked ? 'revoked' : live ? entry.state : 'offline',
    paused: record.paused === true, lastSeen, address: live ? entry.address ?? null : null,
    directory: live ? entry.runtimeRoot ?? null : null, pid: live ? entry.pid ?? null : null,
    engines: capabilities.engines || [], kvm: capabilities.kvm === true, cpus: capabilities.cpus ?? null,
    memoryBytes: capabilities.memoryBytes ?? null, systems: Object.keys(capabilities.images || {}).sort(),
    warnings: capabilities.warnings || [], sessions, maxSessions: capabilities.limits?.maxSessions ?? null
  };
}

// Every registered runner, in registration order.
function runnerSummaries({registry, manager, store}) {
  const sessionsOf = id => manager.list().filter(workspace => workspace.session.runnerId === id).length;
  return store.list().map(record => summarize({entry: registry.get(record.id), record, sessions: sessionsOf(record.id)}));
}

// The command that starts the local runner, or null when a runner is online or the server has no --local-runner.
// `runtime`: the --runtime of the server when it was given, else null (the runner then finds the token file of the default directory of the port).
function connectHint({runners, port, runtime = null, localRunner = false}) {
  if (!localRunner || runners.some(runner => runner.state === 'online')) return null;
  const options = [port === DEFAULT_PORT ? '' : `--port ${port}`, runtime ? `--token-file ${tokenFilePath(runtime)}` : ''].filter(Boolean);
  return ['./scripts/runner.sh', ...options].join(' ');
}

// The public origin of the request: X-Forwarded-Proto and -Host when the server trusts a proxy
// (--trust-proxy), else the Host header. A host that is not a plain name is not used.
function publicOrigin(req, trustProxy) {
  const forwarded = name => (trustProxy ? String(req.get(name) || '').split(',')[0].trim() : '');
  const host = forwarded('x-forwarded-host') || req.get('host') || '';
  const protocol = forwarded('x-forwarded-proto') || req.protocol;
  return /^[A-Za-z0-9.[\]:-]{1,255}$/.test(host) && ['http', 'https'].includes(protocol) ? `${protocol}://${host}` : '<server URL>';
}

const registerCommand = (origin, token) => `./scripts/runner.sh register --url ${origin} --token ${token}`;

function createRunnersRouter({manager, store, tokens, audited, port, runtime = null, localRunner = false, graceSeconds, trustProxy = false}) {
  const router = express.Router();
  const {registry} = manager;
  const summaryOf = id => runnerSummaries({registry, manager, store}).find(runner => runner.id === id);
  const status = (code, message) => Object.assign(new Error(message), {status: code});

  router.get('/', (_req, res) => {
    const runners = runnerSummaries({registry, manager, store});
    res.json({runners, connectHint: connectHint({runners, port, runtime, localRunner}), registrationTokens: tokens.pending(),
      runnerGraceSeconds: graceSeconds, lifetimes: LIFETIMES_MINUTES});
  });

  router.post('/registration-tokens', (req, res) => {
    const minutes = req.body?.minutes;
    audited(req, res, 'create-runner-token', {minutes}, async () => {
      const created = tokens.create({minutes, by: req.user.login});
      return {...created, command: registerCommand(publicOrigin(req, trustProxy), created.token)};
    });
  });

  router.delete('/registration-tokens/:id', (req, res) => {
    audited(req, res, 'cancel-runner-token', {id: req.params.id}, async () => {
      if (!tokens.cancel(req.params.id)) throw status(404, 'No such registration token.');
      return {cancelled: true};
    });
  });

  // The runner of an ID in the URL, from its record (404 for anything else).
  const recordOf = id => {
    const record = RUNNER_ID.test(id) ? store.get(id) : null;
    if (!record) throw status(404, `Unknown runner ${id}.`);
    return record;
  };

  function setPaused(req, res, paused) {
    const {id} = req.params;
    audited(req, res, paused ? 'pause-runner' : 'resume-runner', {runnerId: id}, async () => {
      store.change(recordOf(id).id, {paused});
      const entry = registry.get(id);
      if (entry) entry.paused = paused;
      return summaryOf(id);
    });
  }
  router.post('/:id/pause', (req, res) => setPaused(req, res, true));
  router.post('/:id/resume', (req, res) => setPaused(req, res, false));

  router.post('/:id/revoke', (req, res) => {
    const {id} = req.params;
    audited(req, res, 'revoke-runner', {runnerId: id}, async () => {
      recordOf(id);
      store.change(id, {revoked: true});
      const entry = registry.get(id);
      if (entry && entry.state !== 'lost') entry.client.close();
      return summaryOf(id);
    });
  });

  router.delete('/:id', (req, res) => {
    const {id} = req.params;
    audited(req, res, 'remove-runner', {runnerId: id}, async () => {
      const record = recordOf(id);
      const entry = registry.get(id);
      if (!record.revoked || (entry && entry.state !== 'lost')) throw status(409, 'Only an offline, revoked runner can be removed: revoke it first.');
      store.remove(id);
      registry.remove(id);
      return {removed: true};
    });
  });

  return router;
}

module.exports = {createRunnersRouter, runnerSummaries, connectHint, publicOrigin, registerCommand};
