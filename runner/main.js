'use strict';

// Runner process entry point. A runner is an ordinary unprivileged process: every path is a
// parameter, nothing is written outside them. The options are described in runner/options.js
// (node runner/main.js --help, README.md "Server and runner command line"). Started by
// scripts/runner.sh (also through scripts/start.sh, with a [runner] prefix) it prints a banner,
// its options, its own checks (dependencies, configuration warnings) and the state of the
// connection. Without --exit-on-disconnect it keeps its sessions when the server goes away and
// reconnects; with it (scripts/start.sh) the loss of the connection destroys every node and ends
// the process.
const net = require('net');
const path = require('path');
const fs = require('fs');
const cli = require('../common/cli');
const {runnerSpec, serverSocket, RECONNECT_MS} = require('./options');

const root = path.join(__dirname, '..');
// A connection the server closes within this delay was refused (a runner is already connected).
const REFUSED_MS = 500;

// Startup, the same sequence as the server (server/main.js): the command line first (--help and
// mistakes answer before anything else is loaded), the banner, the Options block, then the checks.
const spec = runnerSpec(root);
const options = cli.commandLine(spec, process.argv.slice(2));
options.socket = serverSocket(options);
cli.printBanner('runner');
cli.printOptions(cli.startupRows(spec, options, [['Server socket', options.socket]]).filter(([name]) => !(name === '--port' && options.given.has('--connect'))));

const {createRunnerService, serveConnection, resolveCommands} = require('./index');
const {Connection} = require('../common/runner-protocol');

let commands;
try {
  commands = resolveCommands(root);
  fs.mkdirSync(path.join(options.runtime, 'sessions'), {recursive: true});
} catch (error) {
  cli.abort('runner', error.message);
}

const service = createRunnerService({commands, root, runtimeRoot: options.runtime, configPath: options.config});
let stopping = false;

// What this machine and config.json allow, printed once at startup (also announced in hello).
function printConfigurationChecks() {
  const {warnings, images} = service.capabilities();
  cli.heading('Checking configuration…');
  if (!warnings.length) cli.pass(`${path.basename(options.config)}  ${Object.keys(images).length} systems`);
  for (const warning of warnings) cli.warning(warning);
  cli.end();
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  const forceExit = setTimeout(() => process.exit(1), 30000);
  forceExit.unref();
  await service.shutdown();
  // Empty once this runner's sessions are gone (a server that ended earlier left it to us).
  try { fs.rmdirSync(path.join(options.runtime, 'sessions')); } catch (_) {}
  process.exit(code);
}

// Connection lines, each printed once per change of state: waiting, connected, refused, lost.
let reported = null;
function report(state, message) {
  if (reported === state) return;
  reported = state;
  console.log(message);
}

function connect() {
  const socket = net.createConnection(options.socket);
  let connected = false;
  socket.once('connect', () => {
    connected = true;
    const connectedAt = Date.now();
    const announce = setTimeout(() => report('connected', 'Connected to the server.'), REFUSED_MS);
    const connection = new Connection(socket);
    connection.on('close', error => {
      clearTimeout(announce);
      if (stopping) return;
      if (error) console.error(`runner: Control connection failed: ${error.message}`);
      if (options.exitOnDisconnect) stop(0);
      else {
        if (Date.now() - connectedAt < REFUSED_MS) report('refused', 'The server refused the connection (another runner is probably connected). Retrying…');
        else report('lost', 'Connection to the server lost, reconnecting…');
        setTimeout(connect, RECONNECT_MS);
      }
    });
    serveConnection(connection, service);
  });
  socket.once('error', error => {
    if (connected) return;
    if (options.exitOnDisconnect) {
      console.error(`runner: Cannot reach ${options.socket}: ${error.message}`);
      stop(1);
    } else {
      report('waiting', `Waiting for the server at ${options.socket}…`);
      setTimeout(connect, RECONNECT_MS);
    }
  });
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(0));
printConfigurationChecks();
connect();
