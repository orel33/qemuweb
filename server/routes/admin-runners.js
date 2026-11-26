'use strict';

// The runners panel of /admin (admins only; the router is mounted by server/routes/admin.js, which
// passes its `audited` helper: every change is written to logs/admin.log, listing is not).
//   GET    /runners                         {runners, connectHint, registrationTokens, runnerGraceSeconds, lifetimes}
//   POST   /runners/registration-tokens     {minutes: 15|60|1440} -> {id, token, expiresAt, command}: shown once
//   DELETE /runners/registration-tokens/:id cancels an unused token
//   POST   /runners/:id/pause | /resume     drain: no new session is placed, the running ones continue
//   POST   /runners/:id/revoke              invalidates the runner and disconnects it (a revoked runner is refused); its sessions are dropped at once
//   POST   /runners/:id/drop-sessions       forced loss: drops at once the sessions of a runner that is offline (or revoked), without waiting for the grace period; 409 while it is online
//   DELETE /runners/:id                     forgets an offline, revoked runner
//   GET    /runners/:id/status              read-only process view of the runner and its sessions (ADM04): what the runner
//                                           answers to runner.status, checked by server/runner-status.js; 404 unknown
//                                           runner, 503 offline or not ready, 504 no answer within statusTimeoutMs (5 s); not audited
// The rows are the same for every runner, "local" included (its record is created at start by --local-runner): there is no flag that tells them apart. A runner summary: {id, name, state, paused,
// lastSeen, address, directory, pid, engines, kvm, cpus, memoryBytes, systems, warnings, sessions,
// maxSessions, graceLeft}; graceLeft is the number of seconds before the sessions of an offline runner are dropped (null when no grace runs); state is online, starting, offline or revoked; directory and pid are what the runner
// announced (text for the administrator, never used). Never a token or a token hash.
// connectHint is the command that starts the local runner, while no runner is online and the server runs with --local-runner; null otherwise.
const express = require('express');
const {LIFETIMES_MINUTES} = require('../runner-registration');
const {RUNNER_ID} = require('../runner-store');
const {sanitizeRunnerStatus} = require('../runner-status');
const {tokenFilePath} = require('../../common/local-token');
const {DEFAULT_ADDRESS, isLoopbackHostname} = require('../../common/bind');
const DEFAULT_PORT = 3002;

function summarize({entry, record, sessions, graceLeft = null}) {
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
    warnings: capabilities.warnings || [], sessions, maxSessions: capabilities.limits?.maxSessions ?? null, graceLeft: live ? null : graceLeft
  };
}

// Every registered runner, in registration order.
function runnerSummaries({registry, manager, store}) {
  const sessionsOf = id => manager.list().filter(workspace => workspace.session.runnerId === id).length;
  return store.list().map(record => summarize({entry: registry.get(record.id), record, sessions: sessionsOf(record.id), graceLeft: manager.graceLeft(record.id)}));
}

// The command that starts the local runner, or null when a runner is online or the server has no --local-runner.
// `host`: the address the local runner dials (common/bind.js runnerHost of --bind). `runtime`: the --runtime of the server when it was given, else null (the runner then finds the token file of the default directory of the port).
function connectHint({runners, port, host = DEFAULT_ADDRESS, runtime = null, localRunner = false}) {
  if (!localRunner || runners.some(runner => runner.state === 'online')) return null;
  const options = [port === DEFAULT_PORT ? '' : `--port ${port}`, host === DEFAULT_ADDRESS ? '' : `--host ${host}`, runtime ? `--token-file ${tokenFilePath(runtime)}` : ''].filter(Boolean);
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

// A plain http:// origin that is not this machine needs --insecure on the runner's side (runner/remote-url.js refuses it otherwise).
const registerCommand = (origin, token) => {
  const plainRemote = origin.startsWith('http://') && !isLoopbackHostname(new URL(origin).hostname);
  return `./scripts/runner.sh register --url ${origin} --token ${token}${plainRemote ? ' --insecure' : ''}`;
};

function createRunnersRouter({manager, store, tokens, audited, port, host, runtime = null, localRunner = false, graceSeconds, trustProxy = false, statusTimeoutMs = 5000}) {
  const router = express.Router();
  const {registry} = manager;
  const summaryOf = id => runnerSummaries({registry, manager, store}).find(runner => runner.id === id);
  const status = (code, message) => Object.assign(new Error(message), {status: code});

  router.get('/', (_req, res) => {
    const runners = runnerSummaries({registry, manager, store});
    res.json({runners, connectHint: connectHint({runners, port, host, runtime, localRunner}), registrationTokens: tokens.pending(),
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
  router.get('/:id/status', async (req, res) => {
    let timer = null;
    try {
      const {id} = recordOf(req.params.id);
      const entry = registry.get(id);
      if (!entry || entry.state === 'lost') throw status(503, 'Runner offline.');
      if (entry.state !== 'online') throw status(503, 'The runner is not ready; try again in a moment.');
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(status(504, 'The runner did not answer in time.')), statusTimeoutMs);
      });
      res.json(sanitizeRunnerStatus(await Promise.race([entry.client.request('runner.status'), timeout])));
    } catch (error) {
      res.status(error.status || 500).json({error: error.message});
    } finally { clearTimeout(timer); }
  });

  router.post('/:id/pause', (req, res) => setPaused(req, res, true));
  router.post('/:id/resume', (req, res) => setPaused(req, res, false));

  router.post('/:id/revoke', (req, res) => {
    const {id} = req.params;
    audited(req, res, 'revoke-runner', {runnerId: id}, async () => {
      recordOf(id);
      store.change(id, {revoked: true});
      const entry = registry.get(id);
      if (entry && entry.state !== 'lost') entry.client.close();
      // Nothing will return from a revoked runner: its sessions are dropped at once, not after the grace period.
      manager.dropRunnerSessions(id, 'runner lost');
      return summaryOf(id);
    });
  });

  // Forced loss: the administrator knows the runner is not coming back. The audit line names the runner and
  // the number of sessions. A runner that returns anyway is told to delete them (session.delete, never a file removed here).
  router.post('/:id/drop-sessions', (req, res) => {
    const {id} = req.params;
    const count = RUNNER_ID.test(id) ? manager.sessionsOf(id) : 0;
    audited(req, res, 'drop-runner-sessions', {runnerId: id, sessions: count}, async () => {
      recordOf(id);
      const entry = registry.get(id);
      if (entry && entry.state !== 'lost') throw status(409, 'This runner is online: its sessions are not lost. Revoke it first if it must go.');
      return {dropped: manager.dropRunnerSessions(id, 'runner lost'), runner: summaryOf(id)};
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
