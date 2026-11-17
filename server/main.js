'use strict';

// Startup and wiring only: HTTP server, Socket.IO, sessions, runners and routes.
//   node server/main.js [options]   the server only (see --help): it waits for a runner (./scripts/runner.sh), which keeps
//                    its VMs if the server restarts. ./scripts/start.sh (npm start) runs both.
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const {Server: SocketIoServer} = require('socket.io');
const {RunnerRegistry} = require('./runner-registry');
const {createRunnerGateway} = require('./runner-gateway');
const {ServerInstance} = require('./server-instance');
const {SessionManager} = require('./session-manager');
const {attachSockets} = require('./sockets');
const {createSessionRouter} = require('./routes');
const {readCatalog} = require('../common/system-config');
const {createAuth} = require('./auth');
const {ADMIN_LOG, USERS_LOG, createLogDir, createAudit, createUserLog} = require('./audit');
const {createAdminRouter, observationGate, adminPage} = require('./routes/admin');
const {startupReport, helpText} = require('./startup-report');
const {parseServerArguments} = require('./options');
const packageInfo = require('../package.json');

const RUNNER_HINT = './scripts/runner.sh';

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  console.log(helpText({root}));
  process.exit(0);
}
let settings;
try { settings = parseServerArguments(args, {root}); }
catch (error) {
  console.error(`${error.message}. Usage: node server/main.js [options] (--help lists them)`);
  process.exit(2);
}
const {runtime, port} = settings;
console.log(`QemuWeb ${packageInfo.version}\n`);
console.log(`${startupReport({root, settings}).join('\n')}\n`);
const configPath = path.join(root, 'config.json');
fs.mkdirSync(path.join(runtime, 'sessions'), {recursive: true});
const instance = new ServerInstance({runtimeRoot: runtime, port, ephemeral: settings.ephemeral});

const app = express();
const server = http.createServer(app);
const io = new SocketIoServer(server);

// --logs (default logs/): admin.log (administrator actions) and users.log (user events).
let logDir;
try { logDir = createLogDir(settings.logDir); }
catch (error) { console.error(`Cannot create the log directory: ${error.message}`); process.exit(1); }
const audit = createAudit({file: path.join(logDir, ADMIN_LOG)});
const userLog = createUserLog({file: path.join(logDir, USERS_LOG)});

// One session per user, each with its own HTTP router, executed by a runner that dials
// <runtime>/runner-<port>.sock (server/runner-gateway.js), started by ./scripts/runner.sh.
const registry = new RunnerRegistry();
const manager = new SessionManager({runtimeRoot: runtime, registry});
const gateway = createRunnerGateway({root, runtimeRoot: runtime, port, registry});
registry.on('online', (entry, hello) => {
  const engines = Array.isArray(hello.engines) ? hello.engines.join(', ') : '';
  console.log(`Runner connected (engines: ${engines || 'none'}).`);
  // The server cleans the empty sessions that earlier servers left only in a runtime/ it shares
  // with the runner (same runtimeRoot in the hello); the sessions the runner reports stay.
  if (entry.runtimeRoot === path.resolve(runtime)) instance.pruneEmptyRuntimeSessions({keep: (hello.sessions || []).map(item => item?.sessionId)});
});
registry.on('lost', () => console.log(`Runner disconnected. Start one with ${RUNNER_HINT}.`));
manager.on('created', (workspace, {adopted}) => {
  const {session, runner} = workspace;
  workspace.router = createSessionRouter({session, runner, userLog});
  userLog.record(workspace.owner, adopted ? 'session-adopted' : 'session-created', {sessionId: session.id});
  console.log(`Session ${session.id} ${adopted ? 'adopted from the runner' : 'opened'} for ${workspace.owner}.`);
});
manager.on('removed', (workspace, by, reason) => {
  userLog.record(workspace.owner, 'session-deleted', {sessionId: workspace.session.id, by, ...(reason ? {reason} : {})});
  if (reason) console.log(`Session ${workspace.session.id} of ${workspace.owner} dropped: ${reason}.`);
});
for (const event of ['created', 'removed']) manager.on(event, () => { if (server.listening) instance.updateSessions(manager.sessionIds()); });
readCatalog(configPath);

let auth;
try { auth = createAuth({settings, userLog}); }
catch (error) { console.error(error.message); process.exit(1); }
if (auth.mode === 'off') {
  console.warn('WARNING: authentication is disabled (--no-auth). Every visitor uses one shared local session.');
  console.warn('         Use it only for single-user local work, never on a shared or exposed server.');
} else if (!auth.userCount()) {
  console.warn(`No user account in ${auth.usersFile}: nobody can log in. Add one with ./scripts/user.sh add <login>.`);
}
// Express trust proxy (e.g. "loopback" behind nginx), so that req.secure follows X-Forwarded-Proto.
if (settings.trustProxy !== null) app.set('trust proxy', settings.trustProxy);
io.use(auth.socketMiddleware);
const sockets = attachSockets(io, manager, {audit, currentUser: auth.currentUser});

app.use(auth.identify);
auth.register(app);
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
app.use('/api', observationGate(manager));
app.use('/api/admin', createAdminRouter({manager, auth, audit, disconnectUser: sockets.disconnectUser, browsers: sockets.browsers, logDir, port, runtime: settings.given.has('--runtime') ? runtime : null}));
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
  req.workspace.router(req, res, next);
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Stop the existing server or choose another port with --listen.`);
    gateway.close();
    process.exit(1);
    return;
  }
  console.error('Server error:', error);
  process.exitCode = 1;
});
// HTTP opens at once; a runner may connect at any time (session routes answer 503 until then).
async function startup() {
  try { await gateway.start(); }
  catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  server.listen(port, '127.0.0.1', onListening);
}
startup();

function onListening() {
  manager.pruneUserAliases();
  instance.writeRecords(manager.sessionIds());
  console.log('\nQemuWeb is ready.');
  console.log(`  Web interface      http://127.0.0.1:${port}`);
  console.log(`  Sessions           ${path.join(runtime, 'sessions')} (<runtime>/users/<login> links)`);
  console.log('  Stop               Ctrl+C or ./scripts/stop.sh\n');
  console.log(`No runner connected. Start one with ${RUNNER_HINT}, or run ./scripts/start.sh for the server and a runner.\n`);
}

process.on('exit', () => {
  instance.removeRecords();
  manager.removeUserAliases();
  // Empty only when the runner has removed its sessions (whichever of the two ends last tidies up).
  try { fs.rmdirSync(path.join(runtime, 'sessions')); } catch (_) {}
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(1), 10000);
  gateway.close();
  io.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
