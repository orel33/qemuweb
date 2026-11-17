'use strict';

// Startup and wiring only: HTTP server, Socket.IO, sessions, runners and routes.
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const {Server: SocketIoServer} = require('socket.io');
const {RunnerRegistry} = require('./lib/runner-registry');
const {createLocalRunner} = require('./lib/local-runner');
const {ServerInstance} = require('./lib/server-instance');
const {SessionManager} = require('./lib/session-manager');
const {attachSockets} = require('./sockets');
const {createSessionRouter} = require('./routes');
const {readCatalog} = require('./common/system-config');
const {createAuth} = require('./lib/auth');
const {ADMIN_LOG, USERS_LOG, logDirPath, createLogDir, createAudit, createUserLog} = require('./lib/audit');
const {createAdminRouter, observationGate, adminPage} = require('./routes/admin');
const packageInfo = require('./package.json');

const root = __dirname;
console.log(`QemuWeb ${packageInfo.version}\n`);
const runtime = path.join(root, 'runtime');
const port = Number(process.env.PORT || 3002);
const configPath = path.join(root, 'config.json');
fs.mkdirSync(path.join(runtime, 'sessions'), {recursive: true});
const instance = new ServerInstance({runtimeRoot: runtime, port, ephemeral: process.env.QEMUWEB_TEST_SERVER === '1'});

const app = express();
const server = http.createServer(app);
const io = new SocketIoServer(server);

// logs/ (or QEMUWEB_LOG_DIR): admin.log (administrator actions) and users.log (user events).
let logDir;
try { logDir = createLogDir(logDirPath(root)); }
catch (error) { console.error(`Cannot create the log directory: ${error.message}`); process.exit(1); }
const audit = createAudit({file: path.join(logDir, ADMIN_LOG)});
const userLog = createUserLog({file: path.join(logDir, USERS_LOG)});

// One session per user, each with its own HTTP router, executed by a runner: here the local
// runner, a child process reached over runtime/runner-<port>.sock (lib/local-runner.js).
const registry = new RunnerRegistry();
const manager = new SessionManager({runtimeRoot: runtime, registry});
const localRunner = createLocalRunner({root, runtimeRoot: runtime, configPath, port, registry,
  boundSessions: () => manager.list().filter(workspace => workspace.session.runnerId === 'local').map(workspace => workspace.session.id),
  onFatal: error => { console.error(error.message); localRunner.kill(); process.exit(1); }});
manager.on('created', workspace => {
  const {session, runner} = workspace;
  workspace.router = createSessionRouter({session, runner, userLog});
  userLog.record(workspace.owner, 'session-created', {sessionId: session.id});
  console.log(`Session ${session.id} opened for ${workspace.owner}.`);
});
manager.on('removed', (workspace, by, reason) => {
  userLog.record(workspace.owner, 'session-deleted', {sessionId: workspace.session.id, by, ...(reason ? {reason} : {})});
  if (reason) console.log(`Session ${workspace.session.id} of ${workspace.owner} dropped: ${reason}.`);
});
for (const event of ['created', 'removed']) manager.on(event, () => { if (server.listening) instance.updateSessions(manager.sessionIds()); });
readCatalog(configPath);

let auth;
try { auth = createAuth({root, userLog}); }
catch (error) { console.error(error.message); process.exit(1); }
if (auth.mode === 'off') {
  console.warn('WARNING: authentication is disabled (QEMUWEB_AUTH=off). Every visitor uses one shared local session.');
  console.warn('         Use it only for single-user local work, never on a shared or exposed server.');
} else if (!auth.userCount()) {
  console.warn(`No user account in ${auth.usersFile}: nobody can log in. Add one with ./scripts/user.sh add <login>.`);
}
// Express trust proxy (e.g. "loopback" behind nginx), so that req.secure follows X-Forwarded-Proto.
if (process.env.QEMUWEB_TRUST_PROXY) {
  const value = process.env.QEMUWEB_TRUST_PROXY;
  app.set('trust proxy', value === 'true' ? true : /^\d+$/.test(value) ? Number(value) : value);
}
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
app.use('/api/admin', createAdminRouter({manager, auth, audit, disconnectUser: sockets.disconnectUser, browsers: sockets.browsers, logDir}));
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
    console.error(`Port ${port} is already in use. Stop the existing server or run PORT=${port + 1} npm start.`);
    localRunner.stop().finally(() => process.exit(1));
    return;
  }
  console.error('Server error:', error);
  process.exitCode = 1;
});
// Browsers are served once the local runner said hello; a runner that cannot start stops the server.
localRunner.start().then(hello => {
  // The runner checks config.json against its machine and announces what is worth a warning.
  console.log('Checking configuration…');
  const warnings = Array.isArray(hello.warnings) ? hello.warnings : [];
  if (!warnings.length) console.log(`  \x1b[32m✓\x1b[0m config.json  ${Object.keys(hello.images || {}).length} systems`);
  for (const warning of warnings) console.warn(`  \x1b[33m⚠\x1b[0m ${warning}`);
  server.listen(port, '127.0.0.1', onListening);
}, error => {
  console.error(`Cannot start the local runner: ${error.message}`);
  localRunner.kill();
  process.exit(1);
});
function onListening() {
  instance.pruneEmptyRuntimeSessions();
  manager.pruneUserAliases();
  instance.writeRecords(manager.sessionIds());
  console.log('\nQemuWeb is ready.');
  console.log(`  Web interface      http://127.0.0.1:${port}`);
  console.log(`  Sessions           ${path.join(runtime, 'sessions')} (runtime/users/<login> links)`);
  console.log('  Stop               Ctrl+C or ./scripts/stop.sh\n');
}

process.on('exit', () => {
  localRunner.kill();
  instance.removeRecords();
  manager.pruneUserAliases();
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(1), 10000);
  await localRunner.stop();
  io.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
