// common/cli.js: the parser table shared by the server and the runner, the help text, the Options
// block and the banner. No process is started.
const assert = require('node:assert/strict');
const test = require('node:test');
const cli = require('../../common/cli');
const packageInfo = require('../../package.json');

const spec = {
  program: 'demo',
  node: 'node demo/main.js',
  script: './scripts/demo.sh',
  summary: 'The demo program.',
  environment: null,
  options: [
    {flag: '--port', metavar: 'PORT', kind: 'port', key: 'port', default: 3002, fallback: '3002', exclusive: ['--socket'], description: 'TCP port'},
    {flag: '--socket', metavar: 'SOCKET', kind: 'path', key: 'socket', default: null, fallback: 'none', showWhenGiven: true, description: 'Unix socket'},
    {flag: '--hours', metavar: 'N', kind: 'number', key: 'hours', default: 12, fallback: '12', max: 24, description: 'a duration'},
    {flag: '--name', metavar: 'NAME', kind: 'text', key: 'name', default: null, fallback: 'unset', convert: value => value.toUpperCase(), description: 'a name'},
    {flag: '--quiet', metavar: null, key: 'quiet', default: false, value: true, fallback: 'off', description: 'no output'}
  ]
};
const parse = argv => cli.parseArguments(spec, argv);
const refused = (argv, pattern) => assert.throws(() => parse(argv), error => error instanceof cli.UsageError && pattern.test(error.message), argv.join(' '));

test('defaults, and `given` tracks the flags present on the line', () => {
  const {help, settings} = parse([]);
  assert.equal(help, false);
  assert.deepEqual([settings.port, settings.socket, settings.hours, settings.name, settings.quiet, settings.given.size], [3002, null, 12, null, false, 0]);
  const given = parse(['--hours', '6', '--quiet', '--name', 'ab']).settings;
  assert.deepEqual([given.hours, given.quiet, given.name, [...given.given]], [6, true, 'AB', ['--hours', '--quiet', '--name']]);
  assert.equal(parse(['--socket', 'rel/x.sock']).settings.socket, require('node:path').resolve('rel/x.sock'));
});

test('unknown flags, missing and invalid values are usage errors', () => {
  refused(['--bogus'], /^Unknown option: --bogus$/);
  refused(['3002'], /^Unknown option: 3002$/);
  refused(['--quiet', 'x'], /^Unknown option: x$/);
  refused(['--port'], /^Missing value for --port \(--port PORT\)$/);
  refused(['--port', 'abc'], /^Invalid value for --port: abc \(1 to 65535\)$/);
  refused(['--port', '0'], /Invalid value/);
  refused(['--port', '65536'], /Invalid value/);
  refused(['--hours', '0'], /Invalid value for --hours: 0 \(a number greater than 0 and at most 24\)/);
  refused(['--hours', '25'], /Invalid value/);
  refused(['--hours', ''], /Invalid value/);
  refused(['--name', ''], /^Invalid value for --name: +\(not empty\)$/);
});

test('exclusive options are refused together, in either order', () => {
  refused(['--port', '1', '--socket', '/s'], /^--port and --socket exclude each other$/);
  refused(['--socket', '/s', '--port', '1'], /exclude each other/);
  assert.doesNotThrow(() => parse(['--socket', '/s']));
});

test('--help or -h anywhere on the line wins over every other check', () => {
  for (const argv of [['--help'], ['-h'], ['--port', '1', '--help'], ['--bogus', '-h'], ['--help', '--port']]) assert.equal(parse(argv).help, true, argv.join(' '));
});

test('the help text: usage forms, options with their default on their own line, environment section', () => {
  const lines = cli.formatHelp(spec).split('\n');
  assert.equal(lines[0], 'Usage: node demo/main.js [options]');
  assert.equal(lines[1], '       ./scripts/demo.sh [options]');
  assert.ok(lines.includes('Options (default in brackets):'));
  const at = lines.findIndex(line => /^ {2}--port PORT +\[3002\]$/.test(line));
  assert.ok(at > 0, '--port with its default');
  assert.match(lines[at + 1], /^ {2} +TCP port$/);
  assert.match(lines.find(line => line.startsWith('  --quiet')), /\[off\]$/);
  assert.match(lines.find(line => line.startsWith('  -h, --help')), /this text$/);
  assert.deepEqual(lines.slice(lines.indexOf('Environment variables:'), lines.indexOf('Environment variables:') + 2),
    ['Environment variables:', '  none: this program reads no environment variable']);
  const withEnv = cli.formatHelp({...spec, environment: [{names: 'A, B', description: 'programs'}]}).split('\n');
  assert.deepEqual(withEnv.slice(withEnv.indexOf('Environment variables:') + 1, withEnv.indexOf('Environment variables:') + 3), ['  A, B', '    programs']);
});

test('the Options block: flags with value and source, flags without value as on/off, derived rows, an unset value shown by its fallback', () => {
  const settings = parse(['--hours', '6', '--quiet']).settings;
  const rows = cli.startupRows(spec, settings, [['Socket', '/run/x.sock']]);
  assert.deepEqual(rows, [['--port', '3002', 'default'], ['--hours', '6', 'option'], ['--name', 'unset', 'default'], ['--quiet', 'on', 'option'], ['Socket', '/run/x.sock', 'derived']]);
  const lines = cli.formatOptions(rows);
  assert.equal(lines[0], 'Options');
  assert.match(lines[1], /^ {2}--port +3002 +\(default\)$/);
  assert.match(lines[4], /^ {2}--quiet +on +\(option\)$/);
  assert.match(lines[5], /^ {2}Socket +\/run\/x\.sock +\(derived\)$/);
  assert.equal(new Set(lines.slice(1).map(line => line.indexOf('('))).size, 1, 'the sources are aligned in one column');
  assert.match(cli.startupRows(spec, parse(['--socket', '/s']).settings).map(row => row[0]).join(' '), /--socket/);
  assert.equal(cli.startupRows(spec, parse([]).settings).some(([name]) => name === '--socket'), false);
});

test('the banner names the version and the program', () => {
  assert.equal(cli.banner('server'), `QemuWeb ${packageInfo.version} server`);
  assert.equal(cli.banner('runner'), `QemuWeb ${packageInfo.version} runner`);
});
