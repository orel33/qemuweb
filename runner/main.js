'use strict';

// Runner process entry point. A runner is an ordinary unprivileged process: every path is a
// parameter, nothing is written outside them.
//   node runner/main.js --connect <socket> [--runtime <dir>] [--config <file>] [--exit-on-disconnect]
//   --connect             Unix socket of the control plane, which the runner dials
//   --runtime             sessions directory root (default $XDG_DATA_HOME/qemuweb-runner,
//                         else ~/.local/share/qemuweb-runner)
//   --config              system catalog (default config.json of this project)
//   --exit-on-disconnect  the loss of the control connection ends the runner: every node is
//                         destroyed and the process exits (the local runner, a child of the
//                         server). Without it, the runner keeps its sessions and reconnects.
// The local runner is started this way by lib/local-runner.js.
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const {createRunnerService, serveConnection, resolveCommands} = require('./index');
const {Connection} = require('../common/runner-protocol');

const root = path.join(__dirname, '..');
const RECONNECT_MS = 2000;

function parseArguments(argv) {
  const options = {connect: null, runtime: null, config: path.join(root, 'config.json'), exitOnDisconnect: false};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--exit-on-disconnect') { options.exitOnDisconnect = true; continue; }
    const key = {'--connect': 'connect', '--runtime': 'runtime', '--config': 'config'}[name];
    if (!key || index + 1 >= argv.length) throw new Error(`Unknown or incomplete option: ${name}`);
    options[key] = path.resolve(argv[++index]);
  }
  if (!options.connect) throw new Error('Missing --connect <socket>.');
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

async function stop(code) {
  if (stopping) return;
  stopping = true;
  const forceExit = setTimeout(() => process.exit(1), 30000);
  forceExit.unref();
  await service.shutdown();
  process.exit(code);
}

function connect() {
  const socket = net.createConnection(options.connect);
  let connected = false;
  socket.once('connect', () => {
    connected = true;
    const connection = new Connection(socket);
    connection.on('close', error => {
      if (stopping) return;
      if (error) console.error(`Runner: control connection failed: ${error.message}`);
      if (options.exitOnDisconnect) stop(0);
      else setTimeout(connect, RECONNECT_MS);
    });
    serveConnection(connection, service);
  });
  socket.once('error', error => {
    if (connected) return;
    if (options.exitOnDisconnect) {
      console.error(`Runner: cannot reach ${options.connect}: ${error.message}`);
      stop(1);
    } else setTimeout(connect, RECONNECT_MS);
  });
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(0));
connect();
