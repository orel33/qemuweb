// Starting again when the runtime directory has vanished (the default one is in /tmp, empty after a reboot)
// or is only partly there (a stale server record, a stale runner socket): a clean new start, never an error.
// Temporary directories and an injected identity: the real /tmp/qw-<login> is never touched. No server, no runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {spawn, spawnSync} = require('node:child_process');
const {once} = require('node:events');
const {defaultRuntime, accountRoot, prepareRuntime, runtimeBudget} = require('../../common/runtime-dir');
const {ServerInstance} = require('../../server/server-instance');
const {createRunnerGateway} = require('../../server/runner-gateway');
const {RunnerRegistry} = require('../../server/runner-registry');
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

// A socket file left by a process that was killed (a real stale Unix socket).
async function leaveStaleSocket(file) {
  const child = spawn(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1], () => process.stdout.write('up'))", file], {stdio: ['ignore', 'pipe', 'ignore']});
  await once(child.stdout, 'data');
  child.kill('SIGKILL');
  await once(child, 'exit');
  assert.ok(fs.existsSync(file), 'the socket file is left behind');
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

test('a partial directory (no sessions/, stale records and socket) starts clean', async t => {
  const {options, runtime} = scratch(t);
  fs.mkdirSync(accountRoot(options), {mode: 0o700});
  fs.mkdirSync(runtime, {mode: 0o700});
  fs.writeFileSync(path.join(runtime, 'server-3002.pid'), `${deadPid()}\n`);
  // A record of an old version is simply ignored (beta rules: no cleanup of leftovers).
  fs.writeFileSync(path.join(runtime, 'server-3002.session'), 'regular\n1111111111111111\n');
  await leaveStaleSocket(path.join(runtime, 'runner-3002.sock'));
  fs.mkdirSync(path.join(runtime, 'users'));
  fs.symlinkSync('../sessions/1111111111111111', path.join(runtime, 'users', 'carol'));
  assert.equal(fs.existsSync(path.join(runtime, 'sessions')), false);

  prepareRuntime(runtime, options);
  assert.ok(fs.statSync(path.join(runtime, 'sessions')).isDirectory(), 'sessions/ is created again');
  const instance = new ServerInstance({runtimeRoot: runtime, port: 3002});
  instance.writeRecords();
  assert.equal(fs.readFileSync(path.join(runtime, 'server-3002.pid'), 'utf8').trim(), String(process.pid), 'the stale PID record is replaced');
  instance.removeRecords();

  const gateway = createRunnerGateway({root: runtime, runtimeRoot: runtime, port: 3002, registry: new RunnerRegistry()});
  await gateway.start();
  t.after(() => gateway.close());
  assert.equal(fs.statSync(gateway.socketPath).mode & 0o777, 0o600, 'the stale socket is replaced by a live one');
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
