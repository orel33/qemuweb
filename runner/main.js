'use strict';

// Runner process entry point. A runner is an ordinary unprivileged process: every path is a
// parameter, nothing is written outside them. Three forms (runner/options.js, node runner/main.js
// --help, docs/reference.md "Server and runner command line"), started by scripts/runner.sh:
//   runner.sh [options]            local runner on the server's Unix socket (also through
//                                  scripts/start.sh, with a [runner] prefix)
//   runner.sh run [options]        remote runner: outbound WebSocket to the server of the runner file
//   runner.sh register [options]   one-time registration (runner/register-command.js)
// It prints a banner, its options, its own checks (dependencies, configuration warnings) and the
// state of the connection. Without --exit-on-disconnect (and a remote runner never has it) it keeps
// its sessions when the server goes away and reconnects; with it (scripts/start.sh) the loss of the
// connection destroys every node and ends the process.
const net = require('net');
const path = require('path');
const fs = require('fs');
const cli = require('../common/cli');
const {runnerSpec, runSpec, serverSocket, RECONNECT_MS} = require('./options');
const {takeRunnerLock, pruneRuntime} = require('./runtime-tidy');
const {defaultRuntime, prepareRuntime, removeEmptyDefaultRuntime} = require('../common/runtime-dir');

const root = path.join(__dirname, '..');
// A connection the server closes within this delay was refused (a runner is already connected).
const REFUSED_MS = 500;

const subcommand = ['register', 'run'].includes(process.argv[2]) ? process.argv[2] : null;
if (subcommand === 'register') require('./register-command').run({root, argv: process.argv.slice(3)});
else main(subcommand === 'run');

function main(remote) {
  // Startup, the same sequence as the server (server/main.js): the command line first (--help and
  // mistakes answer before anything else is loaded), the banner, the Options block, then the checks.
  const spec = remote ? runSpec(root) : runnerSpec(root);
  const options = cli.commandLine(spec, process.argv.slice(remote ? 3 : 2));
  // A remote runner takes its server, runtime and certificate authority from the runner file unless an option says otherwise.
  const identity = remote ? require('./remote-identity').load(options) : null;
  if (!options.runtime) options.runtime = defaultRuntime('runner');
  options.socket = remote ? null : serverSocket(options);
  cli.printBanner('runner');
  const derived = remote ? identity.derivedRows() : [['Server socket', options.socket]];
  cli.printOptions(cli.startupRows(spec, options, derived).filter(([name]) => !(name === '--port' && options.given.has('--connect'))));

  const {createRunnerService, serveConnection, resolveCommands} = require('./index');
  const {Connection} = require('../common/runner-protocol');

  let commands;
  let runtimeWarning = null;
  let runtimeLock = null;
  try {
    commands = resolveCommands(root);
    // Before any session exists: the private default directory is created or refused, a --runtime too long for the sockets is refused.
    runtimeWarning = prepareRuntime(options.runtime).warning;
    // The directory belongs to this runner alone (a live one refuses a second); what an earlier runner left empty is removed.
    runtimeLock = takeRunnerLock(options.runtime);
    pruneRuntime(options.runtime);
  } catch (error) {
    cli.abort('runner', error.message);
  }

  const service = createRunnerService({commands, root, runtimeRoot: options.runtime, configPath: options.config, limits: identity?.config?.limits || null, requireImages: remote});
  let stopping = false;
  let remoteLink = null;

  // What this machine and config.json allow, printed once at startup (also announced in hello).
  function printConfigurationChecks() {
    const {warnings, images} = service.capabilities();
    cli.heading('Checking configuration…');
    const ok = remote ? identity.printChecks() : true;
    cli.pass(`runtime directory  ${options.runtime}  (writable)`);
    if (runtimeWarning) cli.warning(runtimeWarning);
    if (!warnings.length) cli.pass(`${path.basename(options.config)}  ${Object.keys(images).length} systems`);
    for (const warning of warnings) cli.warning(warning);
    cli.end();
    return ok;
  }

  async function stop(code) {
    if (stopping) return;
    stopping = true;
    if (remoteLink) remoteLink.stop();
    const forceExit = setTimeout(() => process.exit(1), 30000);
    forceExit.unref();
    await service.shutdown();
    // Empty once this runner's sessions are gone (a server that ended earlier left it to us).
    try { fs.rmdirSync(path.join(options.runtime, 'sessions')); } catch (_) {}
    runtimeLock.release();
    removeEmptyDefaultRuntime(options.runtime);
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

  // The remote runner dials the server of its runner file over a WebSocket and keeps the link.
  function connectRemote() {
    const {startRemote} = require('./remote');
    const {config} = identity;
    remoteLink = startRemote({url: identity.urls.connectUrl, runnerId: config.runnerId, authToken: config.authToken, ca: options.ca, report,
      onConnection: connection => serveConnection(connection, service),
      fatal: message => { console.error(`runner: ${message}`); stop(1); }});
  }

  process.on('exit', () => runtimeLock.release());
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(0));
  if (!printConfigurationChecks()) cli.abort('runner', 'Startup aborted: a check failed (see above).');
  if (remote) connectRemote(); else connect();
}
