'use strict';

// The checks of "Checking configuration…", run by server/main.js before the web stack is loaded:
// config.json, the users file, the log directory and the runtime directory, each printed with the
// same marks as the runner's checks (✓ ⚠ ✗). Light modules only. Returns false when a check
// failed (the cause is printed with ✗).
const fs = require('fs');
const path = require('path');
const cli = require('../common/cli');
const {readCatalog} = require('../common/system-config');
const {createLogDir} = require('./audit');
const {createUsersStore} = require('./auth/users-store');

const octal = mode => (mode & 0o777).toString(8).padStart(4, '0');

function checkCatalog(root) {
  const catalog = readCatalog(path.join(root, 'config.json'));
  cli.pass(`config.json  ${Object.keys(catalog.systems).filter(system => system !== 'default').length} systems`);
}

function checkUsers(settings) {
  if (settings.authMode === 'off') {
    cli.warning('authentication is disabled (--no-auth): every visitor uses one shared local session; use it only for single-user local work, never on a shared or exposed server.');
    return;
  }
  const count = createUsersStore(settings.usersFile).count();
  if (count) cli.pass(`${path.basename(settings.usersFile)}  ${count} ${count === 1 ? 'account' : 'accounts'}`);
  else cli.warning(`No user account in ${settings.usersFile}: nobody can log in. Add one with ./scripts/user.sh add <login>.`);
}

function checkLogDir(settings) {
  const existed = fs.existsSync(settings.logDir);
  createLogDir(settings.logDir);
  cli.pass(`logs directory  ${settings.logDir}  (${existed ? '' : 'created, '}mode ${octal(fs.statSync(settings.logDir).mode)})`);
}

function checkRuntime(settings) {
  fs.mkdirSync(path.join(settings.runtime, 'sessions'), {recursive: true});
  fs.accessSync(settings.runtime, fs.constants.W_OK);
  cli.pass(`runtime directory  ${settings.runtime}  (writable)`);
}

function checkStartup({root, settings}) {
  cli.heading('Checking configuration…');
  let ok = true;
  for (const [label, check] of [['config.json', () => checkCatalog(root)], [path.basename(settings.usersFile), () => checkUsers(settings)],
    ['logs directory', () => checkLogDir(settings)], ['runtime directory', () => checkRuntime(settings)]]) {
    try { check(); }
    catch (error) {
      ok = false;
      cli.failure(`${label}  ${error.message}`);
    }
  }
  cli.end();
  return ok;
}

module.exports = {checkStartup};
