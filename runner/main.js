'use strict';

// Runner process entry point. A runner is an ordinary unprivileged process: every path is a
// parameter, nothing is written outside them. Three forms (runner/options.js, node runner/main.js
// --help, docs/reference.md "Server and runner command line"), started by scripts/runner.sh:
//   runner.sh [options]            local runner (id local): WebSocket to ws://HOST:PORT (--host, 127.0.0.1) with the token of a file
//                                  (also through scripts/start.sh, with a [runner] prefix)
//   runner.sh run [options]        remote runner: outbound WebSocket to the server of the runner file
//   runner.sh register [options]   one-time registration (runner/register-command.js)
// It prints a banner, its options, its own checks (dependencies, configuration warnings) and the
// state of the connection. A server that refuses its token ends it with status 78. Without --exit-on-disconnect (and a remote runner never has it) it keeps
// its sessions when the server goes away and reconnects; with it (scripts/start.sh) the loss of the
// connection destroys every node and ends the process.
const path = require('path');
const fs = require('fs');
const cli = require('../common/cli');
const {runnerSpec, runSpec} = require('./options');
const {takeRunnerLock, pruneRuntime} = require('./runtime-tidy');
const {prepareRunnerRuntime, removeEmptyDefaultRuntime} = require('../common/runtime-dir');

const root = path.join(__dirname, '..');
// Exit status of a runner whose token the server refuses (EX_CONFIG): systemd can leave it stopped (RestartPreventExitStatus=78).
const REFUSED_STATUS = 78;

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
  // The local runner: the server of this machine and the token file (runner/local-identity.js).
  const local = remote ? null : require('./local-identity').load(options);
  cli.printBanner('runner');
  cli.printOptions(cli.startupRows(spec, options, (remote ? identity : local).derivedRows()));

  const {createRunnerService, serveConnection, resolveCommands} = require('./index');
  const {Connection} = require('../common/runner-protocol');

  let commands;
  let runtimeWarning = null;
  let runtimeLock = null;
  try {
    commands = resolveCommands(root);
    if (!options.runtime) throw identity.fileError;  // a remote runner without its runner file has no directory to name
    // Before any session exists: the private default directory is created or refused, a runner directory too long for the sockets is refused.
    runtimeWarning = prepareRunnerRuntime(options.runtime).warning;
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
    const ok = (remote ? identity : local).printChecks();
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

  // Connection lines, each printed once per change of state: waiting, token, connected, refused, lost.
  let reported = null;
  function report(state, message) {
    if (reported === state) return;
    reported = state;
    console.log(message);
  }

  // Both forms dial the server over a WebSocket (runner/remote.js): the remote runner with the token of its runner file, the
  // local one with the token read again from its file at every attempt. A server that refuses the token ends the runner with status 78
  // (systemd: RestartPreventExitStatus=78); a server that is not there yet, a missing token file, a network error are retried.
  function connectServer() {
    const {startRemote} = require('./remote');
    const link = remote ? identity : local;
    remoteLink = startRemote({url: link.urls.connectUrl, runnerId: remote ? identity.config.runnerId : local.runnerId,
      authToken: remote ? identity.config.authToken : local.readToken, ca: remote ? options.ca : null, report,
      onConnection: connection => serveConnection(connection, service),
      onLost: () => { if (options.exitOnDisconnect) stop(0); },
      ...(remote ? {} : {refusal: 'The server refused the local runner: its token is wrong, or the record "local" is revoked or forgotten. See /admin, Runners; a server restart creates a new token file.'}),
      fatal: message => { console.error(`runner: ${message}`); stop(REFUSED_STATUS); }});
  }

  process.on('exit', () => runtimeLock.release());
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(0));
  if (!printConfigurationChecks()) cli.abort('runner', 'Startup aborted: a check failed (see above).');
  connectServer();
}
