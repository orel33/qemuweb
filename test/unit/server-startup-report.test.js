// The settings the server prints at startup (server/startup-report.js): every option and variable with its
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
  for (const [name, value] of [['--listen', '3002'], ['QEMUWEB_AUTH', 'password'], ['QEMUWEB_USERS_FILE', path.join(root, 'users.json')],
    ['QEMUWEB_SESSION_HOURS', '12'], ['QEMUWEB_TRUST_PROXY', 'unset'], ['QEMUWEB_LOG_DIR', path.join(root, 'logs')]]) {
    assert.match(text, new RegExp(`${name} +${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} +\\(default\\)`), `${name} default`);
  }
  assert.match(text, /Runner socket +\/srv\/qemuweb\/runtime\/runner-3002\.sock +\(derived\)/);
  assert.doesNotMatch(text, /QEMUWEB_TEST_SERVER/);
});

test('values from the environment and the options are shown with their source, paths resolved', () => {
  const env = {PORT: '3999', XDG_DATA_HOME: '/x', QEMUWEB_AUTH: 'off', QEMUWEB_USERS_FILE: '/etc/qemuweb/users.json', QEMUWEB_SESSION_HOURS: '', QEMUWEB_TRUST_PROXY: 'loopback',
    QEMUWEB_LOG_DIR: '/var/log/qemuweb', QEMUWEB_TEST_SERVER: '1'};
  const text = startupReport({root, env, port: 3003, given: new Set(['--listen'])}).join('\n');
  assert.match(text, /--listen +3003 +\(option\)/);
  assert.doesNotMatch(text, /PORT|XDG_DATA_HOME/, 'PORT and XDG_DATA_HOME are ignored');
  assert.match(text, /QEMUWEB_AUTH +off +\(environment\)/);
  assert.match(text, /QEMUWEB_USERS_FILE +\/etc\/qemuweb\/users\.json +\(environment\)/);
  assert.match(text, /QEMUWEB_SESSION_HOURS +12 +\(default\)/, 'an empty value counts as unset');
  assert.match(text, /QEMUWEB_TRUST_PROXY +loopback +\(environment\)/);
  assert.match(text, /QEMUWEB_LOG_DIR +\/var\/log\/qemuweb +\(environment\)/);
  assert.match(text, /QEMUWEB_TEST_SERVER +1 +\(environment\)/);
  assert.match(text, /Runtime directory +\/srv\/qemuweb\/runtime +\(derived\)/);
  assert.match(text, /\/srv\/qemuweb\/runtime\/runner-3003\.sock/);
});

test('every server option and variable is listed by --help (with its description) and documented in the README', () => {
  const fs = require('node:fs');
  const {helpText, settingRows, optionRows} = require('../../server/startup-report');
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
  const help = helpText({root, env: {}});
  for (const [name, fallback, description] of optionRows({root})) {
    const flag = name.split(' ')[0];
    assert.ok(help.includes(name) && help.includes(description) && help.includes(`[${fallback}]`), `--help lists ${name}`);
    assert.ok(readme.includes(`\`${flag}`), `README documents ${flag}`);
  }
  for (const [name, , description] of settingRows({root, env: {}})) {
    assert.ok(help.includes(name) && help.includes(description), `--help lists ${name}`);
    assert.ok(readme.includes(`\`${name}\``), `README documents ${name}`);
  }
  assert.ok(help.includes('QEMUWEB_TEST_SERVER') && readme.includes('`QEMUWEB_TEST_SERVER`'));
});

test('the command line: --listen only, anything else refused', () => {
  const {parseServerArguments} = require('../../server/options');
  const defaults = parseServerArguments([]);
  assert.equal(defaults.port, 3002);
  assert.equal(defaults.given.size, 0);
  const given = parseServerArguments(['--listen', '3005']);
  assert.equal(given.port, 3005);
  assert.deepEqual([...given.given], ['--listen']);
  for (const bad of [['--listen'], ['--listen', 'abc'], ['--listen', '0'], ['--listen', '65536'], ['--port', '3002'], ['3002'], ['--runtime', '/x']]) {
    assert.throws(() => parseServerArguments(bad), Error, bad.join(' '));
  }
});
