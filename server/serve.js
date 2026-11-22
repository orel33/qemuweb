'use strict';

// The web stack of the server: HTTP server, Socket.IO, sessions, runners and routes. Started by
// server/main.js once the command line and the startup checks have passed (these modules, and
// express above all, are only loaded then, so --help and a bad option answer at once).
const http = require('http');
const path = require('path');
const express = require('express');
const {Server: SocketIoServer} = require('socket.io');
const {RunnerRegistry} = require('./runner-registry');
const {ensureLocalRunnerToken} = require('./local-runner-token');
const {createRemoteGateway} = require('./remote-gateway');
const {createRunnerStore, LOCAL_ID} = require('./runner-store');
const {createRegistrationTokens} = require('./runner-registration');
const {createRegisterRouter} = require('./routes/runner-register');
const {ServerInstance} = require('./server-instance');
const {createSessionBindings} = require('./session-bindings');
const {removeEmptyDefaultRuntime} = require('../common/runtime-dir');
const {SessionManager} = require('./session-manager');
const {attachSockets} = require('./sockets');
const {attachWsTest} = require('./ws-test');
const {createSessionRouter} = require('./routes');
const {createAuth} = require('./auth');
const {ADMIN_LOG, USERS_LOG, createAudit, createUserLog} = require('./audit');
const {createAdminRouter, observationGate, adminPage} = require('./routes/admin');
const {connectHint} = require('./routes/admin-runners');

// The token file and the record of the local runner (--local-runner). Throws when the token file can neither be read nor created.
function startLocalRunner({runtime, store, audit}) {
  const token = ensureLocalRunnerToken(runtime);
  if (token.created) console.log(`Local runner token file ${token.file} created${token.reason ? ` (${token.reason})` : ''}.`);
  else if (token.mode & 0o077) console.warn(`Local runner token file ${token.file} can be read by other users: chmod 600 it, or remove it and restart the server.`);
  const known = store.get(LOCAL_ID);
  const record = store.ensureLocal();
  if (!known) audit.record('server', 'register-local-runner', {runnerId: record.id}, 'ok');
  if (record.revoked) console.log('The local runner is revoked: it stays refused (forget it in /admin, then restart the server, to allow it again).');
  return token;
}

function serve({root, settings}) {
  const {runtime, port} = settings;
  const instance = new ServerInstance({runtimeRoot: runtime, port});

  const app = express();
  const server = http.createServer(app);
  const io = new SocketIoServer(server);

  // --logs (default logs/), created by the startup checks: admin.log (administrator actions) and users.log (user events).
  const logDir = settings.logDir;
  const audit = createAudit({file: path.join(logDir, ADMIN_LOG)});
  const userLog = createUserLog({file: path.join(logDir, USERS_LOG)});

  // One session per user, each with its own HTTP router, executed by a runner that dials /runner/connect
  // (server/remote-gateway.js): a registered remote runner, or the local one (--local-runner), started by ./scripts/runner.sh.
  const registry = new RunnerRegistry();
  // The server's own record of which session belongs to whom and to which runner (bindings.json):
  // the only source of the owner of a session adopted after a restart.
  const bindings = createSessionBindings(path.join(runtime, 'bindings.json'));
  const manager = new SessionManager({registry, graceSeconds: settings.runnerGrace, bindings});
  // Every runner has a record in runners.json; the one of the local runner (--local-runner) is created here, with its token file.
  const runnerStore = createRunnerStore(settings.runnersFile);
  let localRunner = null;
  try { if (settings.localRunner) localRunner = startLocalRunner({runtime, store: runnerStore, audit}); }
  catch (error) {
    console.error(`server: Cannot read or create the local runner token file: ${error.message}`);
    process.exit(1);
  }
  // Every runner, the local one included, dials /runner/connect on this HTTP server, with a token.
  const runnerTokens = createRegistrationTokens();
  const remoteGateway = createRemoteGateway({server, registry, store: runnerStore, trustProxy: settings.trustProxy !== null, localRunner});
  // The command that starts the local runner (null without --local-runner), shown while no runner is online.
  const startHint = localRunner ? connectHint({runners: [], port, runtime: settings.given.has('--runtime') ? runtime : null, localRunner: true}) : null;
  const runnerLabel = entry => `Runner ${entry.name} (${entry.id})`;
  registry.on('online', (entry, hello) => {
    const engines = Array.isArray(hello.engines) ? hello.engines.join(', ') : '';
    console.log(`${runnerLabel(entry)} connected${entry.address ? ` from ${entry.address}` : ''} (engines: ${engines || 'none'}).`);
  });
  registry.on('lost', entry => {
    console.log(`${runnerLabel(entry)} disconnected.${registry.list().some(other => other.state === 'online') || !startHint ? '' : ` Start one with ${startHint}.`}`);
    try { runnerStore.change(entry.id, {lastSeenAt: new Date().toISOString()}); } catch (_) { /* Removed meanwhile. */ }
  });
  manager.on('created', (workspace, {adopted}) => {
    const {session, runner} = workspace;
    workspace.router = createSessionRouter({session, runner, userLog, audit, examplesDir: settings.examplesDir});
    userLog.record(workspace.owner, adopted ? 'session-adopted' : 'session-created', {sessionId: session.id});
    console.log(`Session ${session.id} ${adopted ? 'adopted from the runner' : 'opened'} for ${workspace.owner}.`);
  });
  manager.on('removed', (workspace, by, reason) => {
    userLog.record(workspace.owner, 'session-deleted', {sessionId: workspace.session.id, by, ...(reason ? {reason} : {})});
    if (reason) console.log(`Session ${workspace.session.id} of ${workspace.owner} dropped: ${reason}.`);
  });
  const auth = createAuth({settings, userLog});
  // Express trust proxy (e.g. "loopback" behind nginx), so that req.secure follows X-Forwarded-Proto.
  if (settings.trustProxy !== null) app.set('trust proxy', settings.trustProxy);
  io.use(auth.socketMiddleware);
  const sockets = attachSockets(io, manager, {audit, currentUser: auth.currentUser});
  attachWsTest(io, {socketMiddleware: auth.socketMiddleware, currentUser: auth.currentUser});

  app.use(auth.identify);
  auth.register(app);
  // A runner machine registers with a one-time token, not with a login.
  app.use('/api/runner/register', createRegisterRouter({tokens: runnerTokens, store: runnerStore, audit}));
  app.use(auth.requireUser);
  app.use(express.json({limit: '6mb'}));
  app.use('/vendor', express.static(path.join(root, 'node_modules/@xterm/xterm')));
  app.use('/vendor-addon-fit', express.static(path.join(root, 'node_modules/@xterm/addon-fit')));
  app.use((req, res, next) => {
    if (['/', '/index.html', '/login.html'].includes(req.path)) res.set('Cache-Control', 'no-store');
    next();
  });
  app.get(['/admin', '/admin.html'], adminPage(root));
  // Shared with the runner, which cannot require from public/.
  app.get('/console-id.js', (_req, res) => res.sendFile(path.join(root, 'common', 'console-id.js')));
  app.use(express.static(path.join(root, 'public')));
  // X-Observe (admins, read-only) and the admin API come before anything that could open or
  // change the caller's own session.
  app.use('/api', observationGate(manager, {controlHeld: sockets.controlHeld}));
  app.use('/api/admin', createAdminRouter({manager, auth, audit, disconnectUser: sockets.disconnectUser, browsers: sockets.browsers, connections: sockets.connections, logDir, port, runtime: settings.given.has('--runtime') ? runtime : null, localRunner: localRunner !== null,
    runnerStore, runnerTokens, runnerGrace: settings.runnerGrace, trustProxy: settings.trustProxy !== null}));
  // Self-service deletion: stops and removes every node, then the session; the next request
  // opens a new, empty session.
  app.delete('/api/session', async (req, res) => {
    try { res.json({deleted: await manager.remove(req.user.login)}); }
    catch (error) { res.status(409).json({error: error.message}); }
  });
  // API requests go to the router of the user's own session (created at first use), or of the
  // observed session. Only the owner's requests count as activity.
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (req.observed) req.workspace = req.observed;
    else {
      try { req.workspace = manager.open(req.user.login); }
      catch (error) { return res.status(503).json({error: error.message}); }
      req.workspace.session.touch();
    }
    // The runner of a kept session is offline (a network cut): the page stays and recovers.
    if (!manager.available(req.workspace)) return res.status(503).json({error: 'The runner of this session is offline; reconnecting…'});
    req.workspace.router(req, res, next);
  });

  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`server: Port ${port} is already in use. Stop the existing server or choose another port with --listen.`);
      process.exit(1);
      return;
    }
    console.error('server: Server error:', error);
    process.exitCode = 1;
  });
  // HTTP opens at once; a runner may connect at any time (session routes answer 503 until then).
  server.listen(port, '127.0.0.1', onListening);

  function onListening() {
    instance.writeRecords();
    console.log('QemuWeb is ready.');
    console.log(`  Web interface      http://127.0.0.1:${port}`);
    console.log('  Stop               Ctrl+C or ./scripts/stop.sh\n');
    console.log(startHint ? `No runner connected. Start one with ${startHint}, or run ./scripts/start.sh for the server and a runner.\n`
      : 'No runner connected. This server has no local runner (--local-runner): register a remote runner in /admin, Runners.\n');
  }

  process.on('exit', () => {
    instance.removeRecords();
    removeEmptyDefaultRuntime(runtime);
  });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceExit = setTimeout(() => process.exit(1), 10000);
    remoteGateway.close();
    io.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {serve};
