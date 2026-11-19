'use strict';

// The checks of "Checking configuration…", run by server/main.js before the web stack is loaded:
// config.json, the users file, the runners file, the log directory and the runtime directory, each printed with the
// same marks as the runner's checks (✓ ⚠ ✗). Light modules only. Returns false when a check
// failed (the cause is printed with ✗).
const fs = require('fs');
const path = require('path');
const cli = require('../common/cli');
const {readCatalog} = require('../common/system-config');
const {createLogDir} = require('./audit');
const {createUsersStore} = require('./auth/users-store');
const {readProxyKey} = require('./auth/proxy');
const {readRunners} = require('./runner-store');

const octal = mode => (mode & 0o777).toString(8).padStart(4, '0');

// Whether `version` ("v24.1.0") satisfies a caret range of package.json ("^24.0.0").
function satisfiesCaret(version, range) {
  const wanted = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const actual = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!wanted || !actual) throw new Error(`unsupported Node.js version range ${range}`);
  const [wMajor, wMinor, wPatch] = wanted.slice(1).map(Number);
  const [aMajor, aMinor, aPatch] = actual.slice(1).map(Number);
  return aMajor === wMajor && (aMinor > wMinor || (aMinor === wMinor && aPatch >= wPatch));
}

// The block "Checking dependencies…": the server runs no external program, but it runs on
// Node.js, of the version package.json asks for ("engines"). Returns false on a ✗.
function checkDependencies({packageInfo, nodeVersion = process.version, nodePath = process.execPath}) {
  const range = packageInfo.engines?.node;
  if (range && !satisfiesCaret(nodeVersion, range)) {
    cli.failure(`Node.js  ${nodePath}  (${nodeVersion} found, ${range} required)`);
    return false;
  }
  cli.pass(`Node.js  ${nodePath}  (${nodeVersion}${range ? `, requires ${range}` : ''})`);
  return true;
}

function checkCatalog(root) {
  const catalog = readCatalog(path.join(root, 'config.json'));
  cli.pass(`config.json  ${Object.keys(catalog.systems).filter(system => system !== 'default').length} systems`);
}

function checkUsers(settings) {
  if (settings.authMode === 'off') {
    cli.warning('authentication is disabled (--no-auth): every visitor uses one shared local session; use it only for single-user local work, never on a shared or exposed server.');
    return;
  }
  if (settings.authMode !== 'password') {
    readProxyKey(settings.proxyKeyFile);
    cli.pass(`proxy key  ${settings.proxyKeyFile}  (read; mode ${octal(fs.statSync(settings.proxyKeyFile).mode)})`);
    if (!settings.logoutUrl) cli.warning('no --logout-url: users identified by the authenticating front end get no Log out button.');
  }
  const count = createUsersStore(settings.usersFile).count();
  if (count) cli.pass(`${path.basename(settings.usersFile)}  ${count} ${count === 1 ? 'account' : 'accounts'}`);
  else if (settings.authMode === 'proxy') cli.pass(`${path.basename(settings.usersFile)}  no account: every identity from the authenticating front end is a student`);
  else cli.warning(`No user account in ${settings.usersFile}: nobody can log in. Add one with ./scripts/user.sh add <login>.`);
}

function checkRunners(settings) {
  if (!fs.existsSync(settings.runnersFile)) {
    cli.warning(`${path.basename(settings.runnersFile)} absent: no remote runner is registered (create a registration token in /admin/runners).`);
    return;
  }
  const count = readRunners(settings.runnersFile).length;
  cli.pass(`${path.basename(settings.runnersFile)}  ${count} registered ${count === 1 ? 'runner' : 'runners'}`);
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
    [path.basename(settings.runnersFile), () => checkRunners(settings)], ['logs directory', () => checkLogDir(settings)], ['runtime directory', () => checkRuntime(settings)]]) {
    try { check(); }
    catch (error) {
      ok = false;
      cli.failure(`${label}  ${error.message}`);
    }
  }
  cli.end();
  return ok;
}

module.exports = {checkStartup, checkDependencies, satisfiesCaret};
