'use strict';

// The command line of the server, as a table for common/cli.js (which parses it, prints --help and
// the Options block): parsed once into a plain settings object that is passed down: {port,
// runtime, usersFile, runnersFile, logDir, sessionHours, runnerGrace, trustProxy, authMode, proxyKeyFile, logoutUrl, ephemeral, given}. `given` is
// the set of the flags present on the command line. The server reads no environment variable.
// test/unit/server-startup-report.test.js checks that each option is documented in docs/reference.md.
const path = require('path');
const {parseArguments, defaultSettings: cliDefaults, UsageError, invalid} = require('../common/cli');

const DEFAULT_PORT = 3002;
const DEFAULT_SESSION_HOURS = 12;
const MAX_SESSION_HOURS = 24 * 90;
const DEFAULT_RUNNER_GRACE = 300;
const MAX_RUNNER_GRACE = 86400;
const AUTH_MODES = ['password', 'proxy'];

function serverSpec(root) {
  return {
    program: 'server',
    node: 'node server/main.js',
    script: './scripts/server.sh',
    summary: [
      'The QemuWeb server (web interface, accounts, sessions). A local runner (./scripts/runner.sh --port PORT)',
      'dials it on <runtime>/runner-PORT.sock; a runner on another machine registers with a token created in',
      '/admin/runners and connects to /runner/connect (WebSocket). Any unknown option, or a value that is',
      'missing or invalid, is refused (exit status 2).'
    ].join('\n'),
    environment: null,
    options: [
      {flag: '--listen', metavar: 'PORT', kind: 'port', key: 'port', default: DEFAULT_PORT, fallback: String(DEFAULT_PORT),
        description: 'TCP port of the web interface on 127.0.0.1; also names <runtime>/runner-PORT.sock, the socket its runner dials'},
      {flag: '--runtime', metavar: 'DIR', kind: 'path', key: 'runtime', default: path.join(root, 'runtime'), fallback: 'runtime/ of the repository',
        description: 'runtime directory: sessions of a local runner, users/ aliases, server-PORT.pid and .session, and the socket DIR/runner-PORT.sock'},
      {flag: '--users', metavar: 'FILE', kind: 'path', key: 'usersFile', default: path.join(root, 'users.json'), fallback: 'users.json of the repository',
        description: 'users file (mode 0600)'},
      {flag: '--runners', metavar: 'FILE', kind: 'path', key: 'runnersFile', default: path.join(root, 'runners.json'), fallback: 'runners.json of the repository',
        description: 'registered remote runners (mode 0600): a hash of the token of each'},
      {flag: '--logs', metavar: 'DIR', kind: 'path', key: 'logDir', default: path.join(root, 'logs'), fallback: 'logs/ of the repository',
        description: 'directory of admin.log and users.log (mode 0700)'},
      {flag: '--session-hours', metavar: 'N', kind: 'number', key: 'sessionHours', default: DEFAULT_SESSION_HOURS, fallback: String(DEFAULT_SESSION_HOURS),
        max: MAX_SESSION_HOURS, expected: `a number of hours greater than 0 and at most ${MAX_SESSION_HOURS}`,
        description: 'login lifetime in hours (more than 0, at most 2160), renewed while the user is active'},
      {flag: '--runner-grace', metavar: 'SECONDS', kind: 'integer', key: 'runnerGrace', default: DEFAULT_RUNNER_GRACE, fallback: String(DEFAULT_RUNNER_GRACE),
        max: MAX_RUNNER_GRACE, expected: `a whole number of seconds from 0 to ${MAX_RUNNER_GRACE}`,
        description: 'how long the sessions of a remote runner that lost its connection are kept before they are dropped (0 to 86400; 0 drops them at once)'},
      {flag: '--trust-proxy', metavar: 'VALUE', kind: 'text', key: 'trustProxy', default: null, fallback: 'unset',
        convert: value => (value === 'true' ? true : /^\d+$/.test(value) ? Number(value) : value),
        description: 'Express "trust proxy" value behind a reverse proxy ("loopback", "true", a hop count or addresses), so that cookies get Secure over HTTPS'},
      {flag: '--auth', metavar: 'MODE', kind: 'choice', key: 'authMode', default: 'password', choices: AUTH_MODES, fallback: 'password', exclusive: ['--no-auth'],
        description: 'how users are identified: password (QemuWeb login), proxy (identity given by an authenticating front end, for example Apache with mod_auth_openidc for OpenID, but also SAML, CAS, LDAP..., through X-Remote-User, trusted only with a shared X-Proxy-Key; no password login then)'},
      {flag: '--proxy-key-file', metavar: 'FILE', kind: 'path', key: 'proxyKeyFile', default: null, fallback: 'unset',
        description: 'the key shared with the authenticating front end, sent by it as X-Proxy-Key: one line, or two during a rotation (mode 0600); required by --auth proxy'},
      {flag: '--logout-url', metavar: 'URL', kind: 'text', key: 'logoutUrl', default: null, fallback: 'unset',
        convert: value => {
          if (!/^https?:\/\/[^\s]+$/.test(value)) throw invalid('--logout-url', value, 'an http:// or https:// URL');
          return value;
        },
        description: 'where the Log out button goes when the identity comes from the authenticating front end (no button without it)'},
      {flag: '--no-auth', metavar: null, key: 'authMode', default: 'password', value: 'off', fallback: 'off', exclusive: ['--auth'],
        description: 'disables authentication: one shared local session, for single-user local work only (default: authentication on)'},
      {flag: '--ephemeral', metavar: null, key: 'ephemeral', default: false, value: true, fallback: 'off',
        description: 'marks an ephemeral server of the test scenarios (tests only)'}
    ],
    validate(settings) {
      if (settings.authMode === 'proxy' && !settings.proxyKeyFile) {
        throw new UsageError('--auth proxy requires --proxy-key-file FILE');
      }
    }
  };
}

function defaultSettings(root) {
  return cliDefaults(serverSpec(root));
}

// The settings of a command line, or a UsageError (tests and tools; main.js uses commandLine).
function parseServerArguments(argv, {root}) {
  return parseArguments(serverSpec(root), argv).settings;
}

module.exports = {serverSpec, parseServerArguments, defaultSettings, DEFAULT_PORT, DEFAULT_SESSION_HOURS, DEFAULT_RUNNER_GRACE};
