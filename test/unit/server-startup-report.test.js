// The settings the server prints at startup (server/startup-report.js): every variable with its
// value and its source, defaults included.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {startupReport} = require('../../server/startup-report');

const root = path.join(path.sep, 'srv', 'qemuweb');

test('the defaults are listed, each marked as default, with the derived paths', () => {
  const lines = startupReport({root, env: {}, port: 3002});
  assert.equal(lines[0], 'Settings');
  const text = lines.join('\n');
  for (const [name, value] of [['PORT', '3002'], ['QEMUWEB_AUTH', 'password'], ['QEMUWEB_USERS_FILE', path.join(root, 'users.json')],
    ['QEMUWEB_SESSION_HOURS', '12'], ['QEMUWEB_TRUST_PROXY', 'unset'], ['QEMUWEB_LOG_DIR', path.join(root, 'logs')]]) {
    assert.match(text, new RegExp(`${name} +${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} +\\(default\\)`), `${name} default`);
  }
  assert.match(text, /Runtime directory +\/srv\/qemuweb\/runtime +\(derived\)/);
  assert.match(text, /Runner socket +\/srv\/qemuweb\/runtime\/runner-3002\.sock +\(derived\)/);
  assert.doesNotMatch(text, /QEMUWEB_TEST_SERVER/);
});

test('values from the environment are shown with their source, paths resolved', () => {
  const env = {PORT: '3003', QEMUWEB_AUTH: 'off', QEMUWEB_USERS_FILE: '/etc/qemuweb/users.json', QEMUWEB_SESSION_HOURS: '', QEMUWEB_TRUST_PROXY: 'loopback',
    QEMUWEB_LOG_DIR: '/var/log/qemuweb', QEMUWEB_TEST_SERVER: '1'};
  const text = startupReport({root, env, port: 3003}).join('\n');
  assert.match(text, /PORT +3003 +\(environment\)/);
  assert.match(text, /QEMUWEB_AUTH +off +\(environment\)/);
  assert.match(text, /QEMUWEB_USERS_FILE +\/etc\/qemuweb\/users\.json +\(environment\)/);
  assert.match(text, /QEMUWEB_SESSION_HOURS +12 +\(default\)/, 'an empty value counts as unset');
  assert.match(text, /QEMUWEB_TRUST_PROXY +loopback +\(environment\)/);
  assert.match(text, /QEMUWEB_LOG_DIR +\/var\/log\/qemuweb +\(environment\)/);
  assert.match(text, /QEMUWEB_TEST_SERVER +1 +\(environment\)/);
  assert.match(text, /runner-3003\.sock/);
});
