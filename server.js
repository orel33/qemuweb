'use strict';

// Startup and wiring only: HTTP server, Socket.IO, session, runner and routes.
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const {Server: SocketIoServer} = require('socket.io');
const {createRunner, resolveCommands} = require('./runner');
const {Session} = require('./lib/session');
const {attachSockets} = require('./sockets');
const packageInfo = require('./package.json');

const root = __dirname;
console.log(`QemuWeb ${packageInfo.version}\n`);
let commands;
try { commands = resolveCommands(root); }
catch (error) { console.error(error.message); process.exit(1); }
const runtime = path.join(root, 'runtime');
const ephemeralServer = process.env.QEMUWEB_TEST_SERVER === '1';
const port = Number(process.env.PORT || 3002);
const serverPidFile = path.join(runtime, `server-${port}.pid`);
const serverSessionFile = path.join(runtime, `server-${port}.session`);

const app = express();
const server = http.createServer(app);
const io = new SocketIoServer(server);

const session = new Session({runtimeRoot: runtime, ephemeral: ephemeralServer});
fs.mkdirSync(path.join(runtime, 'sessions'), {recursive: true});
const runner = createRunner({session, commands, root, runtimeRoot: runtime, configPath: path.join(root, 'config.json')});
runner.readConfig();
try { fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK); }
catch (_) { console.warn('QEMU/KVM unavailable: /dev/kvm is missing or inaccessible.'); }
attachSockets(io, runner);
runner.startResourceSampling();

app.use(express.json({limit: '6mb'}));
app.use('/api', (req, res, next) => {
  if (session.archiveBusy && !['GET', 'HEAD'].includes(req.method)) return res.status(409).json({error: 'Session archive operation in progress.'});
  next();
});
app.use('/vendor', express.static(path.join(root, 'node_modules/@xterm/xterm')));
app.use('/vendor-addon-fit', express.static(path.join(root, 'node_modules/@xterm/addon-fit')));
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(root, 'public')));

const routeContext = {app, session, runner, commands, emit: (event, payload) => io.emit(event, payload)};
for (const name of ['settings', 'nodes', 'hosts', 'topology', 'archives', 'metrics']) {
  require(`./routes/${name}`).register(routeContext);
}

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
  session.pruneEmptyRuntimeSessions();
  fs.mkdirSync(session.runtimeDir, {recursive: true});
  session.saveMetadata();
  fs.writeFileSync(serverPidFile, `${process.pid}\n`, {mode: 0o600});
  fs.writeFileSync(serverSessionFile, `${session.id}\n${ephemeralServer ? 'test' : 'regular'}\n`, {mode: 0o600});
  session.linkCurrentSession();
  console.log('\nQemuWeb is ready.');
  console.log(`  Web interface      http://127.0.0.1:${port}`);
  console.log(`  Session ID         ${session.id}`);
  console.log(`  Session directory  ${session.runtimeDir}`);
  console.log('  Stop               Ctrl+C or ./scripts/stop.sh\n');
});

process.on('exit', () => {
  session.removeCurrentSessionLink();
  try {
    if (fs.readFileSync(serverPidFile, 'utf8').trim() === String(process.pid)) fs.rmSync(serverPidFile, {force: true});
  } catch (_) {}
  try {
    if (fs.readFileSync(serverSessionFile, 'utf8').startsWith(`${session.id}\n`)) fs.rmSync(serverSessionFile, {force: true});
  } catch (_) {}
  session.removeEmptyRuntimeSession();
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(1), 10000);
  await runner.shutdown();
  io.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
