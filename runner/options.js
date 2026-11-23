'use strict';

// The command line of the runner, as tables for common/cli.js (which parses them, prints --help and
// the Options block), the counterpart of server/options.js. A runner has three forms:
//   runner.sh [options]            local runner (id local): dials ws://HOST:PORT (HOST: --host, 127.0.0.1) with the token of a file (runnerSpec)
//   runner.sh register [options]   one-time registration with a remote server's token (registerSpec)
//   runner.sh run [options]        remote runner: dials the server over WebSocket, with the
//                                  credentials `register` wrote to the runner file (runSpec)
// Settings: {host, port, tokenFile, runtime, config, exitOnDisconnect, given} locally; {runtime, config, url, ca, insecure, runnerConfig, given} for run; and for register
// {url, token, name, ca, insecure, runtime, runnerConfig, given}.
const os = require('os');
const path = require('path');
const {parseArguments, invalid} = require('../common/cli');
const {localRunnerRuntime, serverRuntime} = require('../common/runtime-dir');
const {tokenFilePath} = require('../common/local-token');
const {DEFAULT_ADDRESS, parseAddress} = require('../common/bind');

const DEFAULT_PORT = 3002;

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

// --runtime: the default is computed by the spec's validate (a local runner: l-<port>) or by runner/remote-identity.js (a remote one: r-<id6>), common/runtime-dir.js.
function runtimeOption(description, fallback) {
  return {flag: '--runtime', metavar: 'DIR', kind: 'path', key: 'runtime', default: null, fallback, description};
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
    commands: [
      {name: '(none)', description: 'the LOCAL runner of this machine, for a server started with --local-runner (scripts/start.sh and demo.sh start it). Its options are listed below.'},
      {name: 'register', description: 'REMOTE runner, once: enroll this machine with the one-time token created in /admin -> Runners (./scripts/runner.sh register --help).'},
      {name: 'run', description: 'REMOTE runner: start the registered runner, which dials the server (no inbound port) (./scripts/runner.sh run --help).'}
    ],
    summary: [
      'The QemuWeb runner: the process that runs the machines (QEMU, VDE) of the sessions. Without a command it is the local runner: it dials the',
      'server of this machine (ws://HOST:PORT, 127.0.0.1 unless --host; the server runs with --local-runner) as the runner "local", with the token',
      'the server wrote in a file, read again at every attempt. It keeps its sessions if the connection drops and reconnects;',
      'it exits with status 78 when the server refuses its token.',
      'Run it as your normal user. For a server on another machine, register once',
      '(./scripts/runner.sh register --help), then ./scripts/runner.sh run (--help). ' + REFUSED
    ].join('\n'),
    environment: ENVIRONMENT,
    options: [
      {flag: '--port', metavar: 'PORT', kind: 'port', key: 'port', default: DEFAULT_PORT, fallback: String(DEFAULT_PORT),
        description: 'port of the server to reach: the runner dials ws://HOST:PORT/runner/connect'},
      {flag: '--host', metavar: 'ADDRESS', kind: 'text', key: 'host', default: DEFAULT_ADDRESS, fallback: DEFAULT_ADDRESS,
        convert: value => {
          try { return parseAddress(value); } catch (error) { throw invalid('--host', value, `an IPv4 or IPv6 address (${error.message})`); }
        },
        description: 'address of the server to reach, for a server that listens on an address other than loopback (its --bind): an IPv4 or IPv6 address, never a host name; start.sh and demo.sh pass it'},
      {flag: '--token-file', metavar: 'FILE', kind: 'path', key: 'tokenFile', default: null, fallback: '<default server directory of the port>/local-runner.token',
        description: 'token file the server created (--local-runner), read again at every connection attempt; a missing file is waited for, never a token on the command line'},
      runtimeOption('where the runner keeps its sessions (DIR/sessions/<id>/); DIR/users/<login> links to them, runner.pid locks the directory (one runner at a time); default: the private directory /tmp/qw-<login>/l-PORT, lost at a reboot, never the server\'s directory', '/tmp/qw-<login>/l-<port>'),
      catalogOption(root),
      {flag: '--exit-on-disconnect', metavar: null, key: 'exitOnDisconnect', default: false, value: true, fallback: 'off',
        description: 'stop every machine and exit when the server connection is lost (default: keep the sessions and reconnect, after 2 seconds, then 4, up to 30)'}
    ],
    // The defaults: the runtime directory and the token file are the default ones of the port: the local runner's own directory, and local-runner.token in the server's directory (common/runtime-dir.js).
    validate(settings) {
      if (!settings.given.has('--runtime')) settings.runtime = localRunnerRuntime(settings.port);
      if (!settings.given.has('--token-file')) settings.tokenFile = tokenFilePath(serverRuntime(settings.port));
    }
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
      runtimeOption('where the runner keeps its sessions (DIR/sessions/<id>/); default: the "runtime" of the runner file, else the private directory /tmp/qw-<login>/r-<6 hex digits of the runner ID> (lost at a reboot)', '/tmp/qw-<login>/r-<runner ID>'),
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
      runtimeOption('sessions directory the runner will use, kept in the runner file; default: not kept, the runner then uses /tmp/qw-<login>/r-<6 hex digits of the runner ID>', '/tmp/qw-<login>/r-<runner ID>'),
      runnerConfigOption('where to write the runner file (directory 0700, file 0600)')
    ]
  };
}

// The settings of a command line, or a UsageError (tests; main.js uses commandLine).
function parseRunnerArguments(argv, {root}) {
  return parseArguments(runnerSpec(root), argv).settings;
}

module.exports = {runnerSpec, runSpec, registerSpec, parseRunnerArguments, defaultRunnerConfig, DEFAULT_PORT};
