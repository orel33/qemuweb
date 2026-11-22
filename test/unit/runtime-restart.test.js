// Starting again when the runtime directory has vanished (the default one is in /tmp, empty after a reboot)
// or is only partly there (a stale server record, an unusable token file): a clean new start, never an error.
// Temporary directories and an injected identity: the real /tmp/qw-<login> is never touched. No server, no runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {spawnSync} = require('node:child_process');
const {defaultRuntime, accountRoot, prepareRuntime, runtimeBudget} = require('../../common/runtime-dir');
const {ServerInstance} = require('../../server/server-instance');
const {ensureLocalRunnerToken} = require('../../server/local-runner-token');
const {checkRuntime} = require('../../server/startup-checks');

const alice = {username: 'alice', uid: process.getuid()};

function scratch(t) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-rs-'));
  t.after(() => fs.rmSync(tmpRoot, {recursive: true, force: true}));
  const options = {tmpRoot, identity: alice};
  return {tmpRoot, options, runtime: defaultRuntime(3002, options)};
}

// The PID of a process that has ended: what a server record left by a crash or a reboot holds.
function deadPid() {
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

test('after a reboot the runtime directory is gone: it is created again, private and empty', t => {
  const {tmpRoot, options, runtime} = scratch(t);
  prepareRuntime(runtime, options);
  fs.mkdirSync(path.join(runtime, 'sessions', '0123456789abcdef'));
  fs.rmSync(accountRoot(options), {recursive: true, force: true});
  assert.equal(fs.existsSync(accountRoot(options)), false, 'what /tmp looks like after a reboot');
  const again = prepareRuntime(runtime, options);
  assert.equal(again.created, true);
  assert.deepEqual(fs.readdirSync(path.join(runtime, 'sessions')), [], 'a clean new start, no session');
  assert.equal(fs.statSync(runtime).mode & 0o777, 0o700);
  assert.ok(fs.existsSync(tmpRoot));
});

test('a partial directory (no sessions/, a stale record, a half-written token file) starts clean', t => {
  const {options, runtime} = scratch(t);
  fs.mkdirSync(accountRoot(options), {mode: 0o700});
  fs.mkdirSync(runtime, {mode: 0o700});
  fs.writeFileSync(path.join(runtime, 'server-3002.pid'), `${deadPid()}\n`);
  // A record of an old version is simply ignored (beta rules: no cleanup of leftovers).
  fs.writeFileSync(path.join(runtime, 'server-3002.session'), 'regular\n1111111111111111\n');
  // The token file of an old run that holds no token: the server writes a new one.
  fs.writeFileSync(path.join(runtime, 'local-runner.token'), 'half');
  fs.mkdirSync(path.join(runtime, 'users'));
  fs.symlinkSync('../sessions/1111111111111111', path.join(runtime, 'users', 'carol'));
  assert.equal(fs.existsSync(path.join(runtime, 'sessions')), false);

  prepareRuntime(runtime, options);
  assert.ok(fs.statSync(path.join(runtime, 'sessions')).isDirectory(), 'sessions/ is created again');
  const instance = new ServerInstance({runtimeRoot: runtime, port: 3002});
  instance.writeRecords();
  assert.equal(fs.readFileSync(path.join(runtime, 'server-3002.pid'), 'utf8').trim(), String(process.pid), 'the stale PID record is replaced');
  instance.removeRecords();

  const token = ensureLocalRunnerToken(runtime);
  assert.equal(token.created, true, 'the unusable token file is replaced');
  assert.equal(fs.statSync(token.file).mode & 0o777, 0o600);
});

test('two servers of one account keep separate directories: each writes only its own pid record', t => {
  const {options} = scratch(t);
  const [first, second] = [3002, 3003].map(port => defaultRuntime(port, options));
  prepareRuntime(first, options);
  prepareRuntime(second, options);
  const one = new ServerInstance({runtimeRoot: first, port: 3002});
  const two = new ServerInstance({runtimeRoot: second, port: 3003});
  one.writeRecords();
  assert.deepEqual(fs.readdirSync(first).sort(), ['server-3002.pid', 'sessions']);
  assert.deepEqual(fs.readdirSync(second).sort(), ['sessions']);
  one.removeRecords();
  assert.equal(two.pidFile.endsWith('server-3003.pid'), true);
});

test('an explicit --runtime that is too long is refused at startup with the numbers, before any session', t => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-rl-'));
  t.after(() => fs.rmSync(tmpRoot, {recursive: true, force: true}));
  const {maxRuntimeLength} = runtimeBudget();
  const runtime = path.join(tmpRoot, 'r'.repeat(maxRuntimeLength));
  const lines = [];
  const log = console.log;
  console.log = text => lines.push(String(text));
  try { assert.throws(() => checkRuntime({runtime}), error => /too long/.test(error.message) && /Use a shorter --runtime/.test(error.message) && error.message.includes(`at most ${maxRuntimeLength} bytes`)); }
  finally { console.log = log; }
  assert.equal(fs.existsSync(runtime), false, 'nothing was created');
  assert.deepEqual(lines, []);
});

test('the startup check of the server prints the runtime directory and creates it', t => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-rc-'));
  t.after(() => fs.rmSync(tmpRoot, {recursive: true, force: true}));
  const runtime = path.join(tmpRoot, 'rt');
  const lines = [];
  const log = console.log;
  console.log = text => lines.push(String(text));
  try { checkRuntime({runtime}); }
  finally { console.log = log; }
  assert.ok(lines.some(line => line.includes(`runtime directory  ${runtime}  (writable)`)));
  assert.ok(fs.statSync(path.join(runtime, 'sessions')).isDirectory());
});
