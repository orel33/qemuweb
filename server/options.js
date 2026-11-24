'use strict';

// The command line of the server, as a table for common/cli.js (which parses it, prints --help and
// the Options block): parsed once into a plain settings object that is passed down: {port,
// bind, runtime, localRunner, usersFile, runnersFile, logDir, examplesDir, sessionHours, runnerGrace, trustProxy, authMode, proxyKeyFile, logoutUrl, ephemeral, given}. `given` is
// the set of the flags present on the command line. The server reads no environment variable.
// test/unit/server-startup-report.test.js checks that each option is documented in docs/reference.md.
const path = require('path');
const {parseArguments, defaultSettings: cliDefaults, UsageError, invalid} = require('../common/cli');
const {serverRuntime} = require('../common/runtime-dir');
const {DEFAULT_ADDRESS, parseAddress, isLoopback} = require('../common/bind');

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
      'The QemuWeb server (web interface, accounts, sessions). Every runner dials /runner/connect (WebSocket) with',
      'a token: with --local-runner the server creates the token file of the runner of this machine',
      '(./scripts/runner.sh --port PORT reads it); a runner on another machine registers with a token created in',
      '/admin/runners. Any unknown option, or a value that is missing or invalid, is refused (exit status 2).'
    ].join('\n'),
    environment: null,
    options: [
      {flag: '--listen', metavar: 'PORT', kind: 'port', key: 'port', default: DEFAULT_PORT, fallback: String(DEFAULT_PORT),
        description: 'TCP port of the web interface, and of /runner/connect, where the runners connect (on the address of --bind)'},
      {flag: '--bind', metavar: 'ADDRESS', kind: 'text', key: 'bind', default: DEFAULT_ADDRESS, fallback: DEFAULT_ADDRESS,
        convert: value => {
          try { return parseAddress(value); } catch (error) { throw invalid('--bind', value, `an IPv4 or IPv6 address of this machine (${error.message})`); }
        },
        description: 'address of this machine the server listens on: an IPv4 or IPv6 address (never a host name), or 0.0.0.0 or :: for every interface; the default is loopback; any other address opens the web interface, the consoles and /runner/connect to the network in clear text (HTTP): refused with --no-auth, and with --auth proxy unless --trust-proxy is given'},
      {flag: '--runtime', metavar: 'DIR', kind: 'path', key: 'runtime', default: null, fallback: '/tmp/qw-<login>/<port>',
        description: 'runtime directory of the server: server-PORT.pid, bindings.json and the token file local-runner.token (a runner keeps its own sessions/, users/ aliases and runner.pid in its --runtime); the default is private, in /tmp, and lost at a reboot'},
      {flag: '--local-runner', metavar: null, key: 'localRunner', default: false, value: true, fallback: 'off',
        description: 'accepts the runner of this machine (id local): creates DIR/local-runner.token when missing (mode 0600) and accepts the runner that presents it; ./scripts/runner.sh --port PORT reads it, start.sh and demo.sh pass this option'},
      {flag: '--users', metavar: 'FILE', kind: 'path', key: 'usersFile', default: path.join(root, 'users.json'), fallback: 'users.json of the repository',
        description: 'users file (mode 0600)'},
      {flag: '--runners', metavar: 'FILE', kind: 'path', key: 'runnersFile', default: path.join(root, 'runners.json'), fallback: 'runners.json of the repository',
        description: 'registered runners (mode 0600): a hash of the token of each remote one'},
      {flag: '--logs', metavar: 'DIR', kind: 'path', key: 'logDir', default: path.join(root, 'logs'), fallback: 'logs/ of the repository',
        description: 'directory of admin.log and users.log (mode 0700)'},
      {flag: '--examples', metavar: 'DIR', kind: 'path', key: 'examplesDir', default: path.join(root, 'examples'), fallback: 'examples/ of the repository',
        description: 'directory of the example topologies (.topo) and sessions (.zip) offered by the Load Session dialog (read only; a missing directory means no example)'},
      {flag: '--session-hours', metavar: 'N', kind: 'number', key: 'sessionHours', default: DEFAULT_SESSION_HOURS, fallback: String(DEFAULT_SESSION_HOURS),
        max: MAX_SESSION_HOURS, expected: `a number of hours greater than 0 and at most ${MAX_SESSION_HOURS}`,
        description: 'login lifetime in hours (more than 0, at most 2160), renewed while the user is active'},
      {flag: '--runner-grace', metavar: 'SECONDS', kind: 'integer', key: 'runnerGrace', default: DEFAULT_RUNNER_GRACE, fallback: String(DEFAULT_RUNNER_GRACE),
        max: MAX_RUNNER_GRACE, expected: `a whole number of seconds from 0 to ${MAX_RUNNER_GRACE}`,
        description: 'how long the sessions of a runner that lost its connection are kept before they are dropped (0 to 86400; 0 drops them at once; start.sh and demo.sh pass 0 unless it is given)'},
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
      if (!settings.given.has('--runtime')) settings.runtime = serverRuntime(settings.port);
      if (settings.authMode === 'proxy' && !settings.proxyKeyFile) {
        throw new UsageError('--auth proxy requires --proxy-key-file FILE');
      }
      // A listening address that is not loopback exposes the server to the network in clear text (HTTP): see docs/deployment.md.
      if (!isLoopback(settings.bind)) {
        if (settings.authMode === 'off') throw new UsageError(`--no-auth cannot be used with --bind ${settings.bind}: without authentication every visitor of the network would get the shared administrator session. Bind to 127.0.0.1, or drop --no-auth`);
        if (settings.authMode === 'proxy' && !settings.given.has('--trust-proxy')) {
          throw new UsageError(`--auth proxy with --bind ${settings.bind} needs --trust-proxy VALUE: this mode trusts the identity headers of the front end, which assumes that only the front end can reach the server (firewall)`);
        }
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
