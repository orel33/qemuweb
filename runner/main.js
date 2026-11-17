'use strict';

// Runner process entry point. A runner is an ordinary unprivileged process: every path is a
// parameter, nothing is written outside them.
//   node runner/main.js [--port <n> | --connect <socket>] [--runtime <dir>] [--config <file>] [--exit-on-disconnect]
//   --port                the server on that port (default 3002): --connect <this project>/runtime/runner-<n>.sock
//   --connect             Unix socket of the control plane, which the runner dials, instead of --port
//   --runtime             sessions directory root of this runner (default runtime/ of this project,
//                         which the server shares: a runner with another directory is never cleaned by it)
//   --config              system catalog (default config.json of this project)
//   --exit-on-disconnect  the loss of the control connection ends the runner: every node is
//                         destroyed and the process exits (scripts/start.sh, which ends with
//                         its server). Without it, the runner keeps its sessions and reconnects.
// Started by scripts/runner.sh (also through scripts/start.sh, with a [runner] prefix) it prints
// its own checks: dependencies, configuration warnings and the state of the connection.
const net = require('net');
const path = require('path');
const fs = require('fs');
const {createRunnerService, serveConnection, resolveCommands} = require('./index');
const {Connection} = require('../common/runner-protocol');

const root = path.join(__dirname, '..');
const DEFAULT_PORT = 3002;
const RECONNECT_MS = 2000;
// A connection the server closes within this delay was refused (a runner is already connected).
const REFUSED_MS = 500;

// `--help`: the options and variables, repeated in README.md ("Server and runner command line").
const HELP = `Usage: node runner/main.js [options]
       ./scripts/runner.sh [options]

The QemuWeb runner: the process that runs the machines (QEMU, VDE) of the sessions. It dials the
server, keeps its sessions if the connection drops, and reconnects. Run it as your normal user.

Options (default in brackets):
  --port N               reach the server of port N on runtime/runner-N.sock of the project   [3002]
  --connect SOCKET       Unix socket of the server, instead of --port (not with --port)
  --runtime DIR          where the runner keeps the sessions (DIR/sessions/<id>/); the server
                         cleans only the runtime/ of the project      [runtime/ of the project]
  --config FILE          system catalog (images, memory, QEMU options)   [config.json of the project]
  --exit-on-disconnect   stop every machine and exit when the server connection is lost
                         [keep the sessions and reconnect every 2 seconds]
  -h, --help             this text

Environment variables:
  QEMU_SYSTEM_X86_64, QEMU_IMG, VDE_SWITCH, VDETERM, GENISOIMAGE, NODE, PYTHON3, VBOXMANAGE
                         names or paths of the external programs: .env.local, then the environment,
                         then the default of .env

At startup it prints its options and dependency check, with where each value comes from.
`;

function parseArguments(argv) {
  const options = {port: null, connect: null, runtime: null, config: path.join(root, 'config.json'), exitOnDisconnect: false, given: new Set()};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    options.given.add(name);
    if (name === '--help' || name === '-h') { console.log(HELP); process.exit(0); }
    if (name === '--exit-on-disconnect') { options.exitOnDisconnect = true; continue; }
    if (name === '--port' && index + 1 < argv.length) {
      const port = argv[++index];
      if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error(`Invalid port: ${port}`);
      options.port = Number(port);
      continue;
    }
    const key = {'--connect': 'connect', '--runtime': 'runtime', '--config': 'config'}[name];
    if (!key || index + 1 >= argv.length) throw new Error(`Unknown or incomplete option: ${name} (--help lists the options)`);
    options[key] = path.resolve(argv[++index]);
  }
  if (options.port && options.connect) throw new Error('Use --port or --connect, not both.');
  if (!options.runtime) options.runtime = path.join(root, 'runtime');
  if (!options.connect) {
    options.port = options.port || DEFAULT_PORT;
    options.connect = path.join(root, 'runtime', `runner-${options.port}.sock`);
  }
  return options;
}

// The options and where each value comes from, printed before the dependency check.
function printOptions() {
  const rows = [
    ['Server', options.given.has('--connect') ? `${options.connect}  (--connect)` : `${options.connect}  (port ${options.port}, ${options.given.has('--port') ? '--port' : 'default'})`],
    ['Runtime directory', `${options.runtime}  (${options.given.has('--runtime') ? '--runtime' : 'default'})`],
    ['System catalog', `${options.config}  (${options.given.has('--config') ? '--config' : 'default'})`],
    ['On disconnect', options.exitOnDisconnect ? 'stop every machine and exit  (--exit-on-disconnect)' : `keep the sessions and reconnect every ${RECONNECT_MS / 1000} s  (default)`]
  ];
  const width = Math.max(...rows.map(([name]) => name.length));
  console.log(`Options\n${rows.map(([name, value]) => `  ${name.padEnd(width)}  ${value}`).join('\n')}\n`);
}

let options, commands;
try {
  options = parseArguments(process.argv.slice(2));
  printOptions();
  commands = resolveCommands(root);
  fs.mkdirSync(path.join(options.runtime, 'sessions'), {recursive: true});
} catch (error) {
  console.error(`Runner: ${error.message}`);
  process.exit(1);
}

const service = createRunnerService({commands, root, runtimeRoot: options.runtime, configPath: options.config});
let stopping = false;

// What this machine and config.json allow, printed once at startup (also announced in hello).
function printConfigurationChecks() {
  const {warnings, images} = service.capabilities();
  console.log('Checking configuration…');
  if (!warnings.length) console.log(`  \x1b[32m✓\x1b[0m ${path.basename(options.config)}  ${Object.keys(images).length} systems`);
  for (const warning of warnings) console.warn(`  \x1b[33m⚠\x1b[0m ${warning}`);
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
  const socket = net.createConnection(options.connect);
  let connected = false;
  socket.once('connect', () => {
    connected = true;
    const connectedAt = Date.now();
    const announce = setTimeout(() => report('connected', 'Connected to the server.'), REFUSED_MS);
    const connection = new Connection(socket);
    connection.on('close', error => {
      clearTimeout(announce);
      if (stopping) return;
      if (error) console.error(`Runner: control connection failed: ${error.message}`);
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
      console.error(`Runner: cannot reach ${options.connect}: ${error.message}`);
      stop(1);
    } else {
      report('waiting', `Waiting for the server at ${options.connect}…`);
      setTimeout(connect, RECONNECT_MS);
    }
  });
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(0));
printConfigurationChecks();
connect();
