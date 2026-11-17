'use strict';

// The command line of the runner, as a table for common/cli.js (which parses it, prints --help and
// the Options block), the counterpart of server/options.js. Settings: {port, connect, runtime,
// config, exitOnDisconnect, given}; runnerOptions() adds the socket to dial.
const path = require('path');
const {parseArguments} = require('../common/cli');

const DEFAULT_PORT = 3002;
const RECONNECT_MS = 2000;

function runnerSpec(root) {
  return {
    program: 'runner',
    node: 'node runner/main.js',
    script: './scripts/runner.sh',
    summary: [
      'The QemuWeb runner: the process that runs the machines (QEMU, VDE) of the sessions. It dials the',
      'server on <runtime>/runner-PORT.sock, keeps its sessions if the connection drops and reconnects.',
      'Run it as your normal user. Any unknown option, or a value that is missing or invalid, is refused',
      '(exit status 2).'
    ].join('\n'),
    environment: [{
      names: 'QEMU_SYSTEM_X86_64, QEMU_IMG, VDE_SWITCH, VDETERM, GENISOIMAGE, NODE, PYTHON3, VBOXMANAGE',
      description: 'names or paths of the external programs: .env.local, then the environment, then the default of .env'
    }],
    options: [
      {flag: '--port', metavar: 'PORT', kind: 'port', key: 'port', default: DEFAULT_PORT, fallback: String(DEFAULT_PORT), exclusive: ['--connect'],
        description: 'port of the server to reach: the runner dials DIR/runner-PORT.sock, DIR being its --runtime'},
      {flag: '--connect', metavar: 'SOCKET', kind: 'path', key: 'connect', default: null, fallback: 'none', showWhenGiven: true,
        description: 'Unix socket of the server, instead of --port (the two exclude each other)'},
      {flag: '--runtime', metavar: 'DIR', kind: 'path', key: 'runtime', default: path.join(root, 'runtime'), fallback: 'runtime/ of the repository',
        description: 'where the runner keeps its sessions (DIR/sessions/<id>/) and looks for the server socket DIR/runner-PORT.sock; the server cleans the empty sessions it leaves there only with the same --runtime'},
      {flag: '--config', metavar: 'FILE', kind: 'path', key: 'config', default: path.join(root, 'config.json'), fallback: 'config.json of the repository',
        description: 'system catalog (images, memory, QEMU options)'},
      {flag: '--exit-on-disconnect', metavar: null, key: 'exitOnDisconnect', default: false, value: true, fallback: 'off',
        description: `stop every machine and exit when the server connection is lost (default: keep the sessions and reconnect every ${RECONNECT_MS / 1000} seconds)`}
    ]
  };
}

// The socket the runner dials: --connect, or <runtime>/runner-<port>.sock.
function serverSocket(settings) {
  return settings.connect || path.join(settings.runtime, `runner-${settings.port}.sock`);
}

// The settings of a command line, or a UsageError (tests; main.js uses commandLine).
function parseRunnerArguments(argv, {root}) {
  return parseArguments(runnerSpec(root), argv).settings;
}

module.exports = {runnerSpec, serverSocket, parseRunnerArguments, DEFAULT_PORT, RECONNECT_MS};
