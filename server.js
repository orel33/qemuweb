'use strict';

// Startup and wiring only: HTTP server, Socket.IO, sessions, runners and routes.
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const {Server: SocketIoServer} = require('socket.io');
const {createRunner, resolveCommands} = require('./runner');
const {ServerInstance} = require('./lib/server-instance');
const {SessionManager} = require('./lib/session-manager');
const {attachSockets, sessionRoom} = require('./sockets');
const {createSessionRouter} = require('./routes');
const {readCatalog} = require('./common/system-config');
const packageInfo = require('./package.json');

const root = __dirname;
console.log(`QemuWeb ${packageInfo.version}\n`);
let commands;
try { commands = resolveCommands(root); }
catch (error) { console.error(error.message); process.exit(1); }
const runtime = path.join(root, 'runtime');
const port = Number(process.env.PORT || 3002);
const configPath = path.join(root, 'config.json');
fs.mkdirSync(path.join(runtime, 'sessions'), {recursive: true});
const instance = new ServerInstance({runtimeRoot: runtime, port, ephemeral: process.env.QEMUWEB_TEST_SERVER === '1'});

const app = express();
const server = http.createServer(app);
const io = new SocketIoServer(server);

// One session and one runner per user, each with its own HTTP router.
const manager = new SessionManager({
  runtimeRoot: runtime,
  createRunner: (session, hostNodes) => createRunner({session, commands, root, runtimeRoot: runtime, configPath, hostNodes})
});
manager.on('created', workspace => {
  const {session, runner} = workspace;
  workspace.router = createSessionRouter({session, runner, commands,
    emit: (event, payload) => io.to(sessionRoom(session)).emit(event, payload)});
  console.log(`Session ${session.id} opened for ${workspace.owner}.`);
});
for (const event of ['created', 'removed']) manager.on(event, () => { if (server.listening) instance.updateSessions(manager.sessionIds()); });
readCatalog(configPath);
try { fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK); }
catch (_) { console.warn('QEMU/KVM unavailable: /dev/kvm is missing or inaccessible.'); }

// Until authentication is wired in, every request belongs to one implicit local user.
const implicitUser = {login: 'local', role: 'admin'};
io.use((socket, next) => { socket.data.user = implicitUser; next(); });
attachSockets(io, manager);

app.use(express.json({limit: '6mb'}));
app.use('/vendor', express.static(path.join(root, 'node_modules/@xterm/xterm')));
app.use('/vendor-addon-fit', express.static(path.join(root, 'node_modules/@xterm/addon-fit')));
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(root, 'public')));
app.use('/api', (req, _res, next) => {
  req.user = implicitUser;
  next();
});
app.use((req, res, next) => {
  if (!req.user) return next();
  try { req.workspace = manager.open(req.user.login); }
  catch (error) { return res.status(503).json({error: error.message}); }
  req.workspace.router(req, res, next);
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Stop the existing server or run PORT=${port + 1} npm start.`);
    process.exitCode = 1;
    return;
  }
  console.error('Server error:', error);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  instance.pruneEmptyRuntimeSessions();
  instance.removeLegacyCurrentLink();
  manager.pruneUserAliases();
  instance.writeRecords(manager.sessionIds());
  console.log('\nQemuWeb is ready.');
  console.log(`  Web interface      http://127.0.0.1:${port}`);
  console.log(`  Sessions           ${path.join(runtime, 'sessions')} (runtime/users/<login> links)`);
  console.log('  Stop               Ctrl+C or ./scripts/stop.sh\n');
});

process.on('exit', () => {
  instance.removeRecords();
  manager.removeEmptyRuntimeSessions();
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(1), 10000);
  await manager.shutdown();
  io.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
