'use strict';

// The command line of the server, as a table for common/cli.js (which parses it, prints --help and
// the Options block): parsed once into a plain settings object that is passed down: {port,
// runtime, usersFile, logDir, sessionHours, trustProxy, authMode, ephemeral, given}. `given` is
// the set of the flags present on the command line. The server reads no environment variable.
// test/unit/server-startup-report.test.js checks that each option is documented in the README.
const path = require('path');
const {parseArguments, defaultSettings: cliDefaults} = require('../common/cli');

const DEFAULT_PORT = 3002;
const DEFAULT_SESSION_HOURS = 12;
const MAX_SESSION_HOURS = 24 * 90;

function serverSpec(root) {
  return {
    program: 'server',
    node: 'node server/main.js',
    script: './scripts/server.sh',
    summary: [
      'The QemuWeb server (web interface, accounts, sessions). A runner (./scripts/runner.sh --port PORT)',
      'dials it on <runtime>/runner-PORT.sock. Any unknown option, or a value that is missing or invalid,',
      'is refused (exit status 2).'
    ].join('\n'),
    environment: null,
    options: [
      {flag: '--listen', metavar: 'PORT', kind: 'port', key: 'port', default: DEFAULT_PORT, fallback: String(DEFAULT_PORT),
        description: 'TCP port of the web interface on 127.0.0.1; also names <runtime>/runner-PORT.sock, the socket its runner dials'},
      {flag: '--runtime', metavar: 'DIR', kind: 'path', key: 'runtime', default: path.join(root, 'runtime'), fallback: 'runtime/ of the repository',
        description: 'runtime directory: sessions of a local runner, users/ aliases, server-PORT.pid and .session, and the socket DIR/runner-PORT.sock'},
      {flag: '--users', metavar: 'FILE', kind: 'path', key: 'usersFile', default: path.join(root, 'users.json'), fallback: 'users.json of the repository',
        description: 'users file (mode 0600)'},
      {flag: '--logs', metavar: 'DIR', kind: 'path', key: 'logDir', default: path.join(root, 'logs'), fallback: 'logs/ of the repository',
        description: 'directory of admin.log and users.log (mode 0700)'},
      {flag: '--session-hours', metavar: 'N', kind: 'number', key: 'sessionHours', default: DEFAULT_SESSION_HOURS, fallback: String(DEFAULT_SESSION_HOURS),
        max: MAX_SESSION_HOURS, expected: `a number of hours greater than 0 and at most ${MAX_SESSION_HOURS}`,
        description: 'login lifetime in hours (more than 0, at most 2160), renewed while the user is active'},
      {flag: '--trust-proxy', metavar: 'VALUE', kind: 'text', key: 'trustProxy', default: null, fallback: 'unset',
        convert: value => (value === 'true' ? true : /^\d+$/.test(value) ? Number(value) : value),
        description: 'Express "trust proxy" value behind a reverse proxy ("loopback", "true", a hop count or addresses), so that cookies get Secure over HTTPS'},
      {flag: '--no-auth', metavar: null, key: 'authMode', default: 'password', value: 'off', fallback: 'off',
        description: 'disables authentication: one shared local session, for single-user local work only (default: authentication on)'},
      {flag: '--ephemeral', metavar: null, key: 'ephemeral', default: false, value: true, fallback: 'off',
        description: 'marks an ephemeral server of the test scenarios (tests only)'}
    ]
  };
}

function defaultSettings(root) {
  return cliDefaults(serverSpec(root));
}

// The settings of a command line, or a UsageError (tests and tools; main.js uses commandLine).
function parseServerArguments(argv, {root}) {
  return parseArguments(serverSpec(root), argv).settings;
}

module.exports = {serverSpec, parseServerArguments, defaultSettings, DEFAULT_PORT, DEFAULT_SESSION_HOURS};
