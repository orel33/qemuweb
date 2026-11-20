'use strict';

// The command line of the runner, as tables for common/cli.js (which parses them, prints --help and
// the Options block), the counterpart of server/options.js. A runner has three forms:
//   runner.sh [options]            local runner: dials the server on its Unix socket (runnerSpec)
//   runner.sh register [options]   one-time registration with a remote server's token (registerSpec)
//   runner.sh run [options]        remote runner: dials the server over WebSocket, with the
//                                  credentials `register` wrote to the runner file (runSpec)
// Settings: {port, connect, runtime, config, exitOnDisconnect, given} locally (runnerOptions adds the
// socket to dial); {runtime, config, url, ca, insecure, runnerConfig, given} for run; and for register
// {url, token, name, ca, insecure, runtime, runnerConfig, given}.
const os = require('os');
const path = require('path');
const {parseArguments} = require('../common/cli');

const DEFAULT_PORT = 3002;
const RECONNECT_MS = 2000;

// ~/.config/qemuweb-runner/runner.json of the account that runs the runner (no environment variable:
// --runner-config FILE chooses another file).
function defaultRunnerConfig() {
  return path.join(os.homedir(), '.config', 'qemuweb-runner', 'runner.json');
}

const ENVIRONMENT = [{
  names: 'QEMU_SYSTEM_X86_64, QEMU_IMG, VDE_SWITCH, VDETERM, GENISOIMAGE, NODE, PYTHON3, VBOXMANAGE, TCPDUMP',
  description: 'names or paths of the external programs: .env.local, then the environment, then the default of .env'
}];

const REFUSED = 'Any unknown option, or a value that is missing or invalid, is refused (exit status 2).';

function runtimeOption(root, description) {
  return {flag: '--runtime', metavar: 'DIR', kind: 'path', key: 'runtime', default: path.join(root, 'runtime'), fallback: 'runtime/ of the repository', description};
}

const catalogOption = root => ({flag: '--config', metavar: 'FILE', kind: 'path', key: 'config', default: path.join(root, 'config.json'), fallback: 'config.json of the repository',
  description: 'system catalog (images, memory, QEMU options)'});

const caOption = description => ({flag: '--ca', metavar: 'FILE', kind: 'path', key: 'ca', default: null, fallback: 'none', description});
const insecureOption = {flag: '--insecure', metavar: null, key: 'insecure', default: false, value: true, fallback: 'off',
  description: 'accepts a plain http:// or ws:// server URL that is not on this machine (the token and the traffic are then readable on the network)'};
const runnerConfigOption = description => ({flag: '--runner-config', metavar: 'FILE', kind: 'path', key: 'runnerConfig', default: defaultRunnerConfig(),
  fallback: '~/.config/qemuweb-runner/runner.json', description});

function runnerSpec(root) {
  return {
    program: 'runner',
    node: 'node runner/main.js',
    script: './scripts/runner.sh',
    summary: [
      'The QemuWeb runner: the process that runs the machines (QEMU, VDE) of the sessions. It dials the',
      'server on <runtime>/runner-PORT.sock, keeps its sessions if the connection drops and reconnects.',
      'Run it as your normal user. For a server on another machine, register once',
      '(./scripts/runner.sh register --help), then ./scripts/runner.sh run (--help). ' + REFUSED
    ].join('\n'),
    environment: ENVIRONMENT,
    options: [
      {flag: '--port', metavar: 'PORT', kind: 'port', key: 'port', default: DEFAULT_PORT, fallback: String(DEFAULT_PORT), exclusive: ['--connect'],
        description: 'port of the server to reach: the runner dials DIR/runner-PORT.sock, DIR being its --runtime'},
      {flag: '--connect', metavar: 'SOCKET', kind: 'path', key: 'connect', default: null, fallback: 'none', showWhenGiven: true,
        description: 'Unix socket of the server, instead of --port (the two exclude each other)'},
      runtimeOption(root, 'where the runner keeps its sessions (DIR/sessions/<id>/) and looks for the server socket DIR/runner-PORT.sock; the server cleans the empty sessions it leaves there only with the same --runtime'),
      catalogOption(root),
      {flag: '--exit-on-disconnect', metavar: null, key: 'exitOnDisconnect', default: false, value: true, fallback: 'off',
        description: `stop every machine and exit when the server connection is lost (default: keep the sessions and reconnect every ${RECONNECT_MS / 1000} seconds)`}
    ]
  };
}

function runSpec(root) {
  return {
    program: 'runner run',
    node: 'node runner/main.js run',
    script: './scripts/runner.sh run',
    summary: [
      'The remote runner: it runs the machines of the sessions the server places on it and dials the server',
      'itself (WebSocket on /runner/connect, authenticated by the token of the runner file, no inbound port).',
      'A network cut stops no machine: it reconnects (2 s, doubling up to 30 s) and the server resynchronises.',
      'It stops for good when the server refuses its token (revoked). Register first with',
      './scripts/runner.sh register. Run it as your normal user. ' + REFUSED
    ].join('\n'),
    environment: ENVIRONMENT,
    options: [
      runtimeOption(root, 'where the runner keeps its sessions (DIR/sessions/<id>/); default: the "runtime" of the runner file, else this'),
      catalogOption(root),
      {flag: '--url', metavar: 'URL', kind: 'text', key: 'url', default: null, fallback: 'the runner file',
        description: 'server URL (https://host); default: the one that register wrote in the runner file'},
      caOption('PEM file of the certificate authority that signed the server certificate (self-signed); default: the one of the runner file, else the system ones'),
      insecureOption,
      runnerConfigOption('runner file written by register: server URL, runner ID, token, name, limits')
    ]
  };
}

function registerSpec(root) {
  return {
    program: 'runner register',
    node: 'node runner/main.js register',
    script: './scripts/runner.sh register',
    summary: [
      'Registers this machine as a remote runner: it sends the one-time registration token that an',
      'administrator created in /admin/runners, receives its own identity and writes the runner file',
      '(mode 0600). Then start it with ./scripts/runner.sh run. ' + REFUSED
    ].join('\n'),
    environment: ENVIRONMENT,
    options: [
      {flag: '--url', metavar: 'URL', kind: 'text', key: 'url', default: null, fallback: 'required', required: true,
        description: 'server URL, for example https://qemuweb.example.org'},
      {flag: '--token', metavar: 'TOKEN', kind: 'text', key: 'token', default: null, fallback: 'required', required: true, secret: true,
        description: 'registration token created in /admin/runners (single use, short lived)'},
      {flag: '--name', metavar: 'NAME', kind: 'text', key: 'name', default: null, fallback: 'the runner ID',
        description: 'name shown in /admin/runners (up to 64 characters)'},
      caOption('PEM file of the certificate authority that signed the server certificate (self-signed); kept in the runner file'),
      insecureOption,
      runtimeOption(root, 'sessions directory the runner will use, kept in the runner file; default: runtime/ of the repository where it runs'),
      runnerConfigOption('where to write the runner file (directory 0700, file 0600)')
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

module.exports = {runnerSpec, runSpec, registerSpec, serverSocket, parseRunnerArguments, defaultRunnerConfig, DEFAULT_PORT, RECONNECT_MS};
