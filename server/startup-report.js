'use strict';

// What the server prints at startup after its version: the settings that control its behaviour,
// each with its value and where the value comes from ("default" or "environment"), also when it
// is the default. The server runs no external program (QEMU, VDE and the others belong to the
// runner, which prints its own dependency check), so this is its whole report.
const path = require('path');
const {usersFilePath} = require('./auth/users-store');
const {logDirPath} = require('./audit');

// Variables of the server and their default as shown (the code applies the same defaults).
// [name, default text, function giving the resolved value from the environment when set].
function settingRows({root, env}) {
  return [
    ['PORT', '3002', value => value],
    ['QEMUWEB_AUTH', 'password', value => value],
    ['QEMUWEB_USERS_FILE', path.join(root, 'users.json'), () => usersFilePath(root, env)],
    ['QEMUWEB_SESSION_HOURS', '12', value => value],
    ['QEMUWEB_TRUST_PROXY', 'unset', value => value],
    ['QEMUWEB_LOG_DIR', path.join(root, 'logs'), () => logDirPath(root, env)]
  ];
}

// The lines to print: a title, then one aligned line per variable and per derived path.
function startupReport({root, env = process.env, runtimeDir = path.join(root, 'runtime'), port}) {
  const rows = settingRows({root, env}).map(([name, fallback, resolve]) => {
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

module.exports = {startupReport};
