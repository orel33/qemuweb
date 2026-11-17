'use strict';

// What the server prints at startup after its version: the settings that control its behaviour,
// each with its value and where the value comes from ("default" or "environment"), also when it
// is the default. The server runs no external program (QEMU, VDE and the others belong to the
// runner, which prints its own dependency check), so this is its whole report.
const path = require('path');
const {usersFilePath} = require('./auth/users-store');
const {logDirPath} = require('./audit');

// Variables of the server: [name, default as shown, description, value as resolved when set].
// The description is what `--help` prints and what README.md ("Server and runner command line")
// repeats; test/unit/server-startup-report.test.js checks that every variable is documented there.
function settingRows({root, env}) {
  return [
    ['PORT', '3002', 'TCP port of the web interface on 127.0.0.1; also names runtime/runner-<PORT>.sock, the socket its runner dials', value => value],
    ['QEMUWEB_AUTH', 'password', '"off" disables authentication: one shared local session, for single-user local work only', value => value],
    ['QEMUWEB_USERS_FILE', path.join(root, 'users.json'), 'users file (mode 0600)', () => usersFilePath(root, env)],
    ['QEMUWEB_SESSION_HOURS', '12', 'login lifetime in hours (0 to 2160), renewed while the user is active', value => value],
    ['QEMUWEB_TRUST_PROXY', 'unset', 'Express "trust proxy" value behind a reverse proxy ("loopback", "true", a hop count or addresses), so that cookies get Secure over HTTPS', value => value],
    ['QEMUWEB_LOG_DIR', path.join(root, 'logs'), 'directory of admin.log and users.log (mode 0700)', () => logDirPath(root, env)]
  ];
}

// The lines to print: a title, then one aligned line per variable and per derived path.
function startupReport({root, env = process.env, runtimeDir = path.join(root, 'runtime'), port}) {
  const rows = settingRows({root, env}).map(([name, fallback, , resolve]) => {
    const raw = env[name];
    const set = raw !== undefined && raw !== '';
    return [name, set ? resolve(raw) : fallback, set ? 'environment' : 'default'];
  });
  if (env.QEMUWEB_TEST_SERVER === '1') rows.push(['QEMUWEB_TEST_SERVER', '1', 'environment']);
  rows.push(['Runtime directory', runtimeDir, 'derived'], ['Runner socket', path.join(runtimeDir, `runner-${port}.sock`), 'derived']);
  const nameWidth = Math.max(...rows.map(([name]) => name.length));
  const valueWidth = Math.max(...rows.map(([, value]) => String(value).length));
  return ['Settings', ...rows.map(([name, value, source]) => `  ${name.padEnd(nameWidth)}  ${String(value).padEnd(valueWidth)}  (${source})`)];
}

// The text of `--help`: usage, then every variable with its default.
function helpText({root, env = process.env}) {
  const rows = settingRows({root, env});
  const width = Math.max(...rows.map(([name]) => name.length));
  return `Usage: node server/main.js            (or ./scripts/server.sh)

The QemuWeb server (web interface, accounts, sessions). It takes no option: environment
variables configure it. A runner (./scripts/runner.sh) dials it on runtime/runner-<PORT>.sock.

Environment variables (default in brackets):
${rows.map(([name, fallback, description]) => `  ${name.padEnd(width)}  [${fallback}]\n  ${' '.repeat(width)}  ${description}`).join('\n')}
  ${'QEMUWEB_TEST_SERVER'.padEnd(width)}  [unset]
  ${' '.repeat(width)}  "1" marks an ephemeral server of the test scenarios (tests only)

At startup it prints these settings with their values and where each comes from.
`;
}

module.exports = {startupReport, helpText, settingRows};
