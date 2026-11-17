// The settings the server prints at startup (server/startup-report.js) and its command line
// (server/options.js): every option with its value and its source, defaults included.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {startupReport, helpText, optionRows} = require('../../server/startup-report');
const {parseServerArguments} = require('../../server/options');

const root = path.join(path.sep, 'srv', 'qemuweb');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('the defaults are listed, each marked as default, with the derived runner socket', () => {
  const text = startupReport({root, settings: parseServerArguments([], {root})}).join('\n');
  assert.match(text, /^Settings/);
  for (const [name, value] of [['--listen', '3002'], ['--runtime', path.join(root, 'runtime')], ['--users', path.join(root, 'users.json')],
    ['--logs', path.join(root, 'logs')], ['--session-hours', '12'], ['--trust-proxy', 'unset'], ['--no-auth', 'off'], ['--ephemeral', 'off']]) {
    assert.match(text, new RegExp(`${name} +${escape(value)} +\\(default\\)`), `${name} default`);
  }
  assert.match(text, /Runner socket +\/srv\/qemuweb\/runtime\/runner-3002\.sock +\(derived\)/);
});

test('given options are shown with their source; the environment is ignored', () => {
  const saved = {...process.env};
  Object.assign(process.env, {PORT: '3999', XDG_DATA_HOME: '/x', QEMUWEB_AUTH: 'off', QEMUWEB_USERS_FILE: '/nowhere', QEMUWEB_LOG_DIR: '/nowhere', QEMUWEB_SESSION_HOURS: '1', QEMUWEB_TRUST_PROXY: 'x', QEMUWEB_TEST_SERVER: '1'});
  try {
    assert.equal(parseServerArguments([], {root}).port, 3002);
    assert.equal(parseServerArguments([], {root}).authMode, 'password');
    const settings = parseServerArguments(['--listen', '3003', '--runtime', '/var/lib/qemuweb', '--users', '/etc/qemuweb/users.json', '--logs', '/var/log/qemuweb',
      '--session-hours', '8', '--trust-proxy', 'loopback', '--no-auth', '--ephemeral'], {root});
    const text = startupReport({root, settings}).join('\n');
    for (const [name, value] of [['--listen', '3003'], ['--runtime', '/var/lib/qemuweb'], ['--users', '/etc/qemuweb/users.json'], ['--logs', '/var/log/qemuweb'],
      ['--session-hours', '8'], ['--trust-proxy', 'loopback'], ['--no-auth', 'on'], ['--ephemeral', 'on']]) {
      assert.match(text, new RegExp(`${name} +${escape(value)} +\\(option\\)`), `${name} option`);
    }
    assert.match(text, /\/var\/lib\/qemuweb\/runner-3003\.sock/);
    assert.doesNotMatch(text, /PORT|XDG_DATA_HOME|QEMUWEB_/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('every server option is listed by --help (with its default and description) and documented in the README', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
  const help = helpText({root});
  for (const [name, fallback, description] of optionRows({root})) {
    const flag = name.split(' ')[0];
    assert.ok(help.includes(name) && help.includes(description) && help.includes(`[${fallback}]`), `--help lists ${name}`);
    assert.ok(readme.includes(`\`${flag}`), `README documents ${flag}`);
  }
  assert.doesNotMatch(help, /QEMUWEB_|PORT=/);
});

test('the command line: every option, anything else or an invalid value refused', () => {
  const defaults = parseServerArguments([], {root});
  assert.deepEqual([defaults.port, defaults.sessionHours, defaults.trustProxy, defaults.ephemeral, defaults.given.size], [3002, 12, null, false, 0]);
  const given = parseServerArguments(['--listen', '3005', '--runtime', '/var/rt'], {root});
  assert.deepEqual([given.port, given.runtime, [...given.given]], [3005, '/var/rt', ['--listen', '--runtime']]);
  for (const bad of [['--listen'], ['--listen', 'abc'], ['--listen', '0'], ['--listen', '65536'], ['--port', '3002'], ['3002'], ['--runtime'],
    ['--session-hours', '0'], ['--session-hours', '2161'], ['--trust-proxy', ''], ['--no-auth', 'x']]) {
    assert.throws(() => parseServerArguments(bad, {root}), Error, bad.join(' '));
  }
});
