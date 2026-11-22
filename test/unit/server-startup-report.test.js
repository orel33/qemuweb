// What the server and the runner print at startup and accept on their command line: the option
// tables (server/options.js, runner/options.js), the Options block with value and source, the
// --help text, and the reference tables that repeat them word for word.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const cli = require('../../common/cli');
const {serverSpec, parseServerArguments} = require('../../server/options');
const {defaultRuntime} = require('../../common/runtime-dir');
const {runnerSpec, runSpec, registerSpec, parseRunnerArguments} = require('../../runner/options');
const {tokenFilePath} = require('../../common/local-token');

const root = path.join(path.sep, 'srv', 'qemuweb');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'reference.md'), 'utf8').replace(/`/g, '');
const blockOf = (spec, settings, derived) => cli.formatOptions(cli.startupRows(spec, settings, derived)).join('\n');

test('server: the defaults are listed, each marked as default; --local-runner is off and shows no token file', () => {
  const spec = serverSpec(root);
  const text = blockOf(spec, parseServerArguments([], {root}), []);
  assert.match(text, /^Options/);
  assert.doesNotMatch(text, /Settings/);
  for (const [name, value] of [['--listen', '3002'], ['--runtime', defaultRuntime(3002)], ['--users', path.join(root, 'users.json')],
    ['--runners', path.join(root, 'runners.json')], ['--logs', path.join(root, 'logs')], ['--examples', path.join(root, 'examples')], ['--session-hours', '12'], ['--runner-grace', '300'], ['--local-runner', 'off'], ['--trust-proxy', 'unset'], ['--auth', 'password'], ['--proxy-key-file', 'unset'], ['--logout-url', 'unset'], ['--no-auth', 'off'], ['--ephemeral', 'off']]) {
    assert.match(text, new RegExp(`${name} +${escape(value)} +\\(default\\)`), `${name} default`);
  }
  assert.doesNotMatch(text, /Local runner token|\.sock/);
});

test('server: given options are shown with their source; the environment is ignored', () => {
  const saved = {...process.env};
  Object.assign(process.env, {PORT: '3999', XDG_DATA_HOME: '/x', QEMUWEB_AUTH: 'off', QEMUWEB_USERS_FILE: '/nowhere', QEMUWEB_LOG_DIR: '/nowhere', QEMUWEB_SESSION_HOURS: '1', QEMUWEB_TRUST_PROXY: 'x', QEMUWEB_TEST_SERVER: '1'});
  try {
    assert.equal(parseServerArguments([], {root}).port, 3002);
    assert.equal(parseServerArguments([], {root}).authMode, 'password');
    const settings = parseServerArguments(['--listen', '3003', '--runtime', '/var/lib/qemuweb', '--users', '/etc/qemuweb/users.json', '--runners', '/etc/qemuweb/runners.json', '--logs', '/var/log/qemuweb', '--examples', '/srv/examples',
      '--session-hours', '8', '--runner-grace', '60', '--trust-proxy', 'loopback', '--auth', 'proxy', '--proxy-key-file', '/etc/qemuweb/proxy-key', '--logout-url', 'https://qw.example/bye', '--local-runner', '--ephemeral'], {root});
    const text = blockOf(serverSpec(root), settings, [['Local runner token', tokenFilePath('/var/lib/qemuweb')]]);
    for (const [name, value] of [['--listen', '3003'], ['--runtime', '/var/lib/qemuweb'], ['--users', '/etc/qemuweb/users.json'], ['--runners', '/etc/qemuweb/runners.json'], ['--logs', '/var/log/qemuweb'], ['--examples', '/srv/examples'],
      ['--session-hours', '8'], ['--runner-grace', '60'], ['--trust-proxy', 'loopback'], ['--auth', 'proxy'], ['--proxy-key-file', '/etc/qemuweb/proxy-key'], ['--logout-url', 'https://qw.example/bye'], ['--local-runner', 'on'], ['--ephemeral', 'on']]) {
      assert.match(text, new RegExp(`${name} +${escape(value)} +\\(option\\)`), `${name} option`);
    }
    assert.match(text, /--no-auth +off +\(default\)/, '--auth and --no-auth exclude each other');
    assert.equal(settings.authMode, 'proxy');
    assert.match(text, /Local runner token +\/var\/lib\/qemuweb\/local-runner\.token +\(derived\)/);
    assert.equal(settings.localRunner, true);
    assert.doesNotMatch(text, /PORT|XDG_DATA_HOME|QEMUWEB_/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('server command line: every option, anything else or an invalid value refused', () => {
  const defaults = parseServerArguments([], {root});
  assert.deepEqual([defaults.port, defaults.sessionHours, defaults.trustProxy, defaults.ephemeral, defaults.given.size], [3002, 12, null, false, 0]);
  assert.equal(parseServerArguments(['--runner-grace', '0'], {root}).runnerGrace, 0, '0 drops the sessions of a lost runner at once');
  assert.equal(parseServerArguments(['--runner-grace', '86400'], {root}).runnerGrace, 86400);
  const given = parseServerArguments(['--listen', '3005', '--runtime', '/var/rt'], {root});
  assert.deepEqual([given.port, given.runtime, [...given.given]], [3005, '/var/rt', ['--listen', '--runtime']]);
  for (const bad of [['--listen'], ['--listen', 'abc'], ['--listen', '0'], ['--listen', '65536'], ['--port', '3002'], ['3002'], ['--runtime'],
    ['--session-hours', '0'], ['--session-hours', '2161'], ['--runner-grace'], ['--runner-grace', '-1'], ['--runner-grace', '86401'], ['--runner-grace', 'x'], ['--runner-grace', '1.5'], ['--runners'], ['--trust-proxy', ''], ['--no-auth', 'x']]) {
    assert.throws(() => parseServerArguments(bad, {root}), cli.UsageError, bad.join(' '));
  }
});

test('runner: defaults, the Options block, the token file and the command line', () => {
  const spec = runnerSpec(root);
  const defaults = parseRunnerArguments([], {root});
  assert.equal(defaults.tokenFile, tokenFilePath(defaultRuntime(3002)));
  assert.equal(parseRunnerArguments(['--port', '3010'], {root}).runtime, defaultRuntime(3010), 'the default follows the port');
  assert.equal(parseRunnerArguments(['--port', '3010'], {root}).tokenFile, tokenFilePath(defaultRuntime(3010)), 'so does the token file');
  const text = blockOf(spec, defaults, [['Runner', 'local'], ['Server WebSocket', 'ws://127.0.0.1:3002/runner/connect']]);
  for (const [name, value] of [['--port', '3002'], ['--token-file', tokenFilePath(defaultRuntime(3002))], ['--runtime', defaultRuntime(3002)], ['--config', '/srv/qemuweb/config.json'], ['--exit-on-disconnect', 'off']]) {
    assert.match(text, new RegExp(`${name} +${escape(value)} +\\(default\\)`), `${name} default`);
  }
  assert.match(text, /Server WebSocket +ws:\/\/127\.0\.0\.1:3002\/runner\/connect +\(derived\)/);
  assert.doesNotMatch(text, /--connect|\.sock/);
  const given = parseRunnerArguments(['--port', '4100', '--token-file', '/etc/t', '--runtime', '/rt', '--config', '/c.json', '--exit-on-disconnect'], {root});
  assert.equal(given.tokenFile, '/etc/t');
  assert.match(blockOf(spec, given, []), /--exit-on-disconnect +on +\(option\)/);
  assert.match(blockOf(spec, given, []), /--token-file +\/etc\/t +\(option\)/);
  for (const bad of [['--port'], ['--port', 'x'], ['--port', '70000'], ['--connect', '/s'], ['--token-file'], ['--token', 'abc'], ['--listen', '1'], ['--exit-on-disconnect', 'x']]) {
    assert.throws(() => parseRunnerArguments(bad, {root}), cli.UsageError, bad.join(' '));
  }
  assert.equal(cli.parseArguments(spec, ['--bogus', '--help']).help, true);
});

test('runner run and register: their own tables, required options, a masked token, no local-socket options', () => {
  const parse = (spec, argv) => cli.parseArguments(spec, argv).settings;
  const run = runSpec(root);
  const defaults = parse(run, []);
  assert.deepEqual([defaults.url, defaults.ca, defaults.insecure, defaults.runtime], [null, null, false, null]);
  assert.match(defaults.runnerConfig, /qemuweb-runner[\\/]runner\.json$/);
  const given = parse(run, ['--url', 'https://q.example.org', '--ca', '/ca.pem', '--insecure', '--runner-config', '/r.json']);
  assert.deepEqual([given.url, given.ca, given.insecure, given.runnerConfig], ['https://q.example.org', '/ca.pem', true, '/r.json']);
  for (const bad of [['--port', '3002'], ['--connect', '/s'], ['--exit-on-disconnect'], ['--url'], ['--token', 'x']]) assert.throws(() => parse(run, bad), cli.UsageError, bad.join(' '));
  const register = registerSpec(root);
  assert.throws(() => parse(register, ['--url', 'https://q']), /Missing required option --token/);
  assert.throws(() => parse(register, ['--token', 'abc']), /Missing required option --url/);
  const registered = parse(register, ['--url', 'https://q', '--token', 'abc', '--name', 'salle']);
  assert.deepEqual([registered.token, registered.name], ['abc', 'salle']);
  const text = blockOf(register, registered, []);
  assert.doesNotMatch(text, /abc/, 'the registration token is never printed');
  assert.match(text, /--token +\*+ +\(option\)/);
  assert.equal(cli.parseArguments(register, ['--help']).help, true, '--help needs no required option');
  // The local runner refuses the remote options.
  for (const bad of [['--url', 'https://q'], ['--token', 'x'], ['--ca', '/c'], ['--insecure']]) assert.throws(() => parseRunnerArguments(bad, {root}), cli.UsageError, bad.join(' '));
});

test('both programs share the help layout, usage forms and errors', () => {
  const helps = [serverSpec(root), runnerSpec(root), runSpec(root), registerSpec(root)].map(spec => ({spec, text: cli.formatHelp(spec)}));
  for (const {spec, text} of helps) {
    assert.ok(text.startsWith(`Usage: ${spec.node} [options]\n       ${spec.script} [options]\n`), `${spec.program} usage`);
    assert.match(text, /\nOptions \(default in brackets\):\n/);
    assert.match(text, /\nEnvironment variables:\n/);
    assert.match(text, /\n {2}-h, --help +this text\n/);
    for (const option of spec.options) {
      const name = option.metavar ? `${option.flag} ${option.metavar}` : option.flag;
      assert.match(text, new RegExp(`\\n {2}${escape(name)} +\\[${escape(option.fallback)}\\]\\n {2} +${escape(option.description)}\\n`), `${spec.program} lists ${name}`);
    }
  }
  assert.match(helps[0].text, /none: this program reads no environment variable/);
  assert.doesNotMatch(helps[0].text, /QEMUWEB_|PORT=/);
  assert.match(helps[1].text, /QEMU_SYSTEM_X86_64, QEMU_IMG, VDE_SWITCH, VDETERM, GENISOIMAGE, NODE, PYTHON3, VBOXMANAGE, TCPDUMP/);
  // The same closing text and the same refusal sentence.
  const closing = text => text.slice(text.indexOf('At startup it prints'));
  assert.equal(closing(helps[0].text), closing(helps[1].text));
  for (const {text} of helps) assert.match(text.replace(/\s+/g, ' '), /Any unknown option, or a value that is missing or invalid, is refused \(exit status 2\)/);
});

test('reference: the tables of both programs match --help on options, defaults and descriptions, word for word', () => {
  for (const spec of [serverSpec(root), runnerSpec(root), runSpec(root), registerSpec(root)]) {
    for (const option of spec.options) {
      const name = option.metavar ? `${option.flag} ${option.metavar}` : option.flag;
      assert.ok(readme.includes(`| ${name} | ${option.fallback} | ${option.description} |`), `reference ${spec.program} row of ${name}`);
    }
    for (const {names, description} of spec.environment || []) assert.ok(readme.includes(`| ${names} | names in .env | ${description}`), `reference ${spec.program} variables`);
  }
  assert.ok(readme.includes('| -h, --help | | this text |'), 'reference help row');
  // QEMUWEB_PASSWORD (scripts/user.sh, never the command line) is the only QEMUWEB_ variable left.
  assert.doesNotMatch(readme.replace(/QEMUWEB_PASSWORD/g, ''), /QEMUWEB_[A-Z_]+/);
});
