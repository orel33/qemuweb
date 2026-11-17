// The server's startup dependency check (server/preflight.js): Node.js version range, npm packages,
// browser assets served from node_modules, runtime directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {checkDependencies, satisfiesCaret} = require('../../server/preflight');

const packageInfo = {engines: {node: '^24.0.0'}};
const quiet = {log() {}, error() {}};

function fakeRoot(t, {packages = true, assets = true} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-preflight-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const install = (name, files = []) => {
    const directory = path.join(root, 'node_modules', name);
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({name, version: '1.2.3'}));
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), {recursive: true});
      fs.writeFileSync(path.join(directory, file), '');
    }
  };
  if (packages) { install('express'); install('socket.io'); }
  if (assets) { install('@xterm/xterm', ['lib/xterm.js', 'css/xterm.css']); install('@xterm/addon-fit', ['lib/addon-fit.js']); }
  return root;
}

test('a caret range accepts the same major version from the minimum on', () => {
  assert.equal(satisfiesCaret('v24.0.0', '^24.0.0'), true);
  assert.equal(satisfiesCaret('v24.11.1', '^24.0.0'), true);
  assert.equal(satisfiesCaret('v23.9.0', '^24.0.0'), false);
  assert.equal(satisfiesCaret('v25.0.0', '^24.0.0'), false);
  assert.equal(satisfiesCaret('v24.1.0', '^24.2.0'), false);
  assert.throws(() => satisfiesCaret('v24.0.0', '>=24'), /unsupported/);
});

test('a complete installation passes and every check is printed', t => {
  const lines = [];
  const failures = checkDependencies({root: fakeRoot(t), packageInfo, nodeVersion: 'v24.1.0', log: line => lines.push(line), error: line => lines.push(line)});
  assert.deepEqual(failures, []);
  assert.match(lines[0], /^Checking dependencies/);
  for (const label of ['Node.js', 'Express', 'Socket.IO', 'Terminal \\(xterm.js\\)', 'Terminal fit add-on', 'Runtime directory']) {
    assert.ok(lines.some(line => new RegExp(`✓.*${label}`).test(line)), `${label} is checked`);
  }
  assert.ok(lines.some(line => /express 1\.2\.3/.test(line)), 'the installed version is shown');
});

test('a missing package, a missing asset and a wrong Node.js version are reported with their fix', t => {
  const missingPackages = checkDependencies({root: fakeRoot(t, {packages: false}), packageInfo, nodeVersion: 'v24.0.0', ...quiet});
  assert.deepEqual(missingPackages, ['Express', 'Socket.IO']);
  const root = fakeRoot(t);
  fs.rmSync(path.join(root, 'node_modules', '@xterm', 'xterm', 'css'), {recursive: true});
  const errors = [];
  const failures = checkDependencies({root, packageInfo, nodeVersion: 'v22.1.0', log() {}, error: line => errors.push(line)});
  assert.deepEqual(failures, ['Node.js', 'Terminal (xterm.js)']);
  assert.ok(errors.some(line => /v22\.1\.0 found, \^24\.0\.0 required/.test(line)));
  assert.ok(errors.some(line => /css\/xterm\.css is missing; run npm ci/.test(line)));
});

test('an unusable runtime directory fails the check', t => {
  const root = fakeRoot(t);
  const blocked = path.join(root, 'blocked');
  fs.writeFileSync(blocked, '');
  const failures = checkDependencies({root, packageInfo, nodeVersion: 'v24.0.0', runtimeDir: path.join(blocked, 'runtime'), ...quiet});
  assert.deepEqual(failures, ['Runtime directory']);
});
