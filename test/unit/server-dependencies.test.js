// The server's "Checking dependencies…" block (server/startup-checks.js): Node.js and its version range.
const assert = require('node:assert/strict');
const test = require('node:test');
const {checkDependencies, satisfiesCaret} = require('../../server/startup-checks');

function capture(run) {
  const lines = [];
  const {log, error} = console;
  console.log = text => lines.push(text);
  console.error = text => lines.push(text);
  try { return {result: run(), lines}; } finally { console.log = log; console.error = error; }
}

test('a caret range accepts the same major version from the minimum on', () => {
  assert.equal(satisfiesCaret('v24.0.0', '^24.0.0'), true);
  assert.equal(satisfiesCaret('v24.11.1', '^24.0.0'), true);
  assert.equal(satisfiesCaret('v23.9.0', '^24.0.0'), false);
  assert.equal(satisfiesCaret('v25.0.0', '^24.0.0'), false);
  assert.equal(satisfiesCaret('v24.1.0', '^24.2.0'), false);
  assert.throws(() => satisfiesCaret('v24.0.0', '>=24'), /unsupported/);
});

test('Node.js is listed with its path and version; a wrong version is a failure', () => {
  const packageInfo = {engines: {node: '^24.0.0'}};
  const good = capture(() => checkDependencies({packageInfo, nodeVersion: 'v24.22.0', nodePath: '/usr/bin/node'}));
  assert.equal(good.result, true);
  assert.match(good.lines.join('\n'), /✓.*Node\.js {2}\/usr\/bin\/node {2}\(v24\.22\.0, requires \^24\.0\.0\)/);
  const bad = capture(() => checkDependencies({packageInfo, nodeVersion: 'v22.1.0', nodePath: '/usr/bin/node'}));
  assert.equal(bad.result, false);
  assert.match(bad.lines.join('\n'), /✗.*v22\.1\.0 found, \^24\.0\.0 required/);
});
