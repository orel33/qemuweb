'use strict';

// The command line of the server (--help is handled by main.js), parsed once into a plain
// settings object that is passed down: {port, runtime, usersFile, logDir, sessionHours,
// trustProxy, authMode, ephemeral, given}. `given` is the set of options present on the command
// line, for the startup report. The server reads no environment variable.
const path = require('path');

const DEFAULT_PORT = 3002;
const DEFAULT_SESSION_HOURS = 12;
const MAX_SESSION_HOURS = 24 * 90;

function invalid(flag, value, expected) {
  return new Error(`Invalid value for ${flag}: ${value} (${expected})`);
}

// One entry per option: flag, metavar (null for a flag without value), settings key, default as
// shown, description (what `--help` prints and README.md repeats) and the parser of the value.
// test/unit/server-startup-report.test.js checks that each one is documented in the README.
function optionTable(root) {
  return [
    {flag: '--listen', metavar: 'PORT', key: 'port', fallback: String(DEFAULT_PORT),
      description: 'TCP port of the web interface on 127.0.0.1; also names <runtime>/runner-<PORT>.sock, the socket its runner dials',
      parse: value => {
        if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw invalid('--listen', value, '1 to 65535');
        return Number(value);
      }},
    {flag: '--runtime', metavar: 'DIR', key: 'runtime', fallback: path.join(root, 'runtime'),
      description: 'runtime directory: sessions of a local runner, users/ aliases, server-<PORT>.pid and .session, and the socket DIR/runner-<PORT>.sock',
      parse: value => path.resolve(value)},
    {flag: '--users', metavar: 'FILE', key: 'usersFile', fallback: path.join(root, 'users.json'),
      description: 'users file (mode 0600)', parse: value => path.resolve(value)},
    {flag: '--logs', metavar: 'DIR', key: 'logDir', fallback: path.join(root, 'logs'),
      description: 'directory of admin.log and users.log (mode 0700)', parse: value => path.resolve(value)},
    {flag: '--session-hours', metavar: 'N', key: 'sessionHours', fallback: String(DEFAULT_SESSION_HOURS),
      description: 'login lifetime in hours (more than 0, at most 2160), renewed while the user is active',
      parse: value => {
        const hours = Number(value);
        if (value === '' || !Number.isFinite(hours) || hours <= 0 || hours > MAX_SESSION_HOURS) throw invalid('--session-hours', value, `a number of hours greater than 0 and at most ${MAX_SESSION_HOURS}`);
        return hours;
      }},
    {flag: '--trust-proxy', metavar: 'VALUE', key: 'trustProxy', fallback: 'unset',
      description: 'Express "trust proxy" value behind a reverse proxy ("loopback", "true", a hop count or addresses), so that cookies get Secure over HTTPS',
      parse: value => {
        if (value === '') throw invalid('--trust-proxy', value, 'not empty');
        return value === 'true' ? true : /^\d+$/.test(value) ? Number(value) : value;
      }},
    {flag: '--no-auth', metavar: null, key: 'authMode', fallback: 'off', value: 'off',
      description: 'disables authentication: one shared local session, for single-user local work only (default: authentication on)'},
    {flag: '--ephemeral', metavar: null, key: 'ephemeral', fallback: 'off', value: true,
      description: 'marks an ephemeral server of the test scenarios (tests only)'}
  ];
}

function defaultSettings(root) {
  return {port: DEFAULT_PORT, runtime: path.join(root, 'runtime'), usersFile: path.join(root, 'users.json'),
    logDir: path.join(root, 'logs'), sessionHours: DEFAULT_SESSION_HOURS, trustProxy: null, authMode: 'password',
    ephemeral: false, given: new Set()};
}

function parseServerArguments(argv, {root}) {
  const settings = defaultSettings(root);
  const table = optionTable(root);
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    const option = table.find(item => item.flag === name);
    if (!option) throw new Error(`Unknown argument: ${name}`);
    if (option.metavar) {
      if (index + 1 >= argv.length) throw new Error(`Missing value for ${name}`);
      settings[option.key] = option.parse(argv[++index]);
    } else {
      settings[option.key] = option.value;
    }
    settings.given.add(name);
  }
  return settings;
}

module.exports = {parseServerArguments, defaultSettings, optionTable, DEFAULT_PORT, DEFAULT_SESSION_HOURS};
