'use strict';

// The dependency check the server prints at startup ("Checking dependencies…"), counterpart of
// runner/preflight.js: the server needs Node.js of the right version, its npm packages, the
// browser assets it serves from node_modules, and a writable runtime/ directory. It uses core
// modules only, because it runs before the server loads its packages: a missing package is
// reported here with the fix, not as a stack trace.
const fs = require('fs');
const path = require('path');

// The npm packages the server loads (the runner has its own: node-pty), and the files of the
// browser libraries it serves under /vendor and /vendor-addon-fit (public/index.html).
const SERVER_PACKAGES = [['express', 'Express'], ['socket.io', 'Socket.IO']];
const BROWSER_ASSETS = [
  ['@xterm/xterm', 'Terminal (xterm.js)', ['lib/xterm.js', 'css/xterm.css']],
  ['@xterm/addon-fit', 'Terminal fit add-on', ['lib/addon-fit.js']]
];

// Whether `version` (for example "24.1.0") satisfies a caret range "^24.0.0" of package.json.
function satisfiesCaret(version, range) {
  const wanted = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const actual = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!wanted || !actual) throw new Error(`unsupported Node.js version range ${range}`);
  const [wMajor, wMinor, wPatch] = wanted.slice(1).map(Number);
  const [aMajor, aMinor, aPatch] = actual.slice(1).map(Number);
  if (aMajor !== wMajor) return false;
  return aMinor > wMinor || (aMinor === wMinor && aPatch >= wPatch);
}

function packageVersion(root, name) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version; }
  catch (_) { throw new Error(`not installed; run npm ci in ${root}`); }
}

// The checks, as [label, function returning the detail text or throwing the reason].
function serverChecks({root, packageInfo, nodeVersion, runtimeDir}) {
  const checks = [['Node.js', () => {
    const range = packageInfo.engines?.node;
    if (range && !satisfiesCaret(nodeVersion, range)) throw new Error(`${nodeVersion} found, ${range} required`);
    return nodeVersion;
  }]];
  for (const [name, label] of SERVER_PACKAGES) checks.push([label, () => `${name} ${packageVersion(root, name)}`]);
  for (const [name, label, files] of BROWSER_ASSETS) {
    checks.push([label, () => {
      const version = packageVersion(root, name);
      for (const file of files) {
        if (!fs.existsSync(path.join(root, 'node_modules', name, file))) throw new Error(`${name}/${file} is missing; run npm ci in ${root}`);
      }
      return `${name} ${version}`;
    }]);
  }
  checks.push(['Runtime directory', () => {
    fs.mkdirSync(runtimeDir, {recursive: true});
    fs.accessSync(runtimeDir, fs.constants.R_OK | fs.constants.W_OK);
    return path.relative(root, runtimeDir) || runtimeDir;
  }]);
  return checks;
}

// Prints the checks like the runner does and returns the list of failed labels (it prints each
// reason, the caller decides to stop).
function checkDependencies({root, packageInfo, nodeVersion = process.version, runtimeDir = path.join(root, 'runtime'), log = console.log, error = console.error}) {
  log('Checking dependencies…');
  const checks = serverChecks({root, packageInfo, nodeVersion, runtimeDir});
  const width = Math.max(...checks.map(([label]) => label.length));
  const failures = [];
  for (const [label, run] of checks) {
    try { log(`  \x1b[32m✓\x1b[0m ${label.padEnd(width)}  ${run()}`); }
    catch (reason) {
      failures.push(label);
      error(`  \x1b[31m✗\x1b[0m ${label.padEnd(width)}  ${reason.message}`);
    }
  }
  return failures;
}

module.exports = {checkDependencies, satisfiesCaret, serverChecks};
