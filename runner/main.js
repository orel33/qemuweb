'use strict';

// Runner process entry point. A runner is an ordinary unprivileged process: every path is a
// parameter, nothing is written outside them.
//   node runner/main.js (--port <n> | --connect <socket>) [--runtime <dir>] [--config <file>] [--exit-on-disconnect]
//   --port                the server on that port: --connect <this project>/runtime/runner-<n>.sock
//   --connect             Unix socket of the control plane, which the runner dials
//   --runtime             sessions directory root (default $XDG_DATA_HOME/qemuweb-runner,
//                         else ~/.local/share/qemuweb-runner)
//   --config              system catalog (default config.json of this project)
//   --exit-on-disconnect  the loss of the control connection ends the runner: every node is
//                         destroyed and the process exits (the local runner, a child of the
//                         server). Without it, the runner keeps its sessions and reconnects.
// Started by hand (scripts/runner.sh) it prints its own checks: dependencies, configuration
// warnings and the state of the connection. With `node server.js --local`, lib/local-runner.js
// starts it as a child and these lines appear on the server's console.
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const {createRunnerService, serveConnection, resolveCommands} = require('./index');
const {Connection} = require('../common/runner-protocol');

const root = path.join(__dirname, '..');
const RECONNECT_MS = 2000;
// A connection the server closes within this delay was refused (a runner is already connected).
const REFUSED_MS = 500;

function parseArguments(argv) {
  const options = {port: null, connect: null, runtime: null, config: path.join(root, 'config.json'), exitOnDisconnect: false};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--exit-on-disconnect') { options.exitOnDisconnect = true; continue; }
    if (name === '--port' && index + 1 < argv.length) {
      const port = argv[++index];
      if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error(`Invalid port: ${port}`);
      options.port = Number(port);
      continue;
    }
    const key = {'--connect': 'connect', '--runtime': 'runtime', '--config': 'config'}[name];
    if (!key || index + 1 >= argv.length) throw new Error(`Unknown or incomplete option: ${name}`);
    options[key] = path.resolve(argv[++index]);
  }
  if (options.port && options.connect) throw new Error('Use --port or --connect, not both.');
  if (options.port) options.connect = path.join(root, 'runtime', `runner-${options.port}.sock`);
  if (!options.connect) throw new Error('Missing --port <n> or --connect <socket>.');
  if (!options.runtime) options.runtime = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'qemuweb-runner');
  return options;
}

let options, commands;
try {
  options = parseArguments(process.argv.slice(2));
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
