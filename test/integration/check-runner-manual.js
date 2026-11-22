'use strict';

// The manual mode: the server run alone (`node server/main.js`) spawns nothing and answers 503 until a
// runner, started by hand (runner/main.js --connect), dials <runtime>/runner-<port>.sock (the default runtime directory of the port). A session
// runs on that runner (VDE switch); the runner and its switch SURVIVE a SIGKILL of the server;
// a new server on the same port is joined again by the runner, and the user finds the SAME
// session, adopted (`session-adopted` in users.log), with its switch still running; a second
// runner is refused; SIGTERM on the runner leaves no process and no session directory.
// The runner keeps its sessions in its own short temporary runtime directory (which also makes
// the server's runtime/ differ from the runner's: the server creates no alias, the runner makes its own and holds runner.pid). VDE only: no
// system image or KVM is needed.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');
const {USERS_LOG} = require('../../server/audit');
const {createTestUsers, spawnServer, QemuWebClient} = require('./qemuweb-client');
const {defaultRuntime} = require('../../common/runtime-dir');

const root = path.join(__dirname, '..', '..');
// The default runtime directory of the server's port (/tmp/qw-<login>/<port>), set once the port is chosen.
let runtime = null;
const newSwitchId = () => `s-${crypto.randomBytes(8).toString('hex')}`;
const sockets = [];
const runners = [];
let server;
let testUsers;
let scratch;
let serverOutput = '';
const runnerOutput = new Map();
process.on('exit', () => { testUsers?.cleanup(); if (scratch) fs.rmSync(scratch, {recursive: true, force: true}); });

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const {port} = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitFor(label, condition, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

// vde_switch processes that are children of `pid`.
function switchesOf(pid) {
  const found = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      const comm = stat.slice(stat.indexOf('(') + 1, end);
      const [state, ppid] = stat.slice(end + 2).split(' ');
      if (state !== 'Z' && Number(ppid) === pid && comm === 'vde_switch') found.push(Number(name));
    } catch (_) { /* The process ended meanwhile. */ }
  }
  return found;
}

function startServer(port, logDir) {
  serverOutput = '';
  const child = spawnServer({port, usersFile: testUsers.file, standalone: true, logDir});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { serverOutput = (serverOutput + data).slice(-12000); });
  return child;
}

function startRunner(port, runnerRuntime, label) {
  const child = spawn(process.execPath, ['runner/main.js', '--connect', path.join(runtime, `runner-${port}.sock`), '--runtime', runnerRuntime], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
  runnerOutput.set(label, '');
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => runnerOutput.set(label, (runnerOutput.get(label) + data).slice(-12000)));
  runners.push(child);
  return child;
}

function recorder(client, label) {
  const socket = client.socket();
  const events = [];
  socket.onAny((event, ...args) => events.push({event, payload: args[0]}));
  sockets.push(socket);
  const connected = new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', error => reject(new Error(`${label}: ${error.message}`)));
  });
  return {socket, events, connected};
}

const select = (socket, nodeId) => new Promise(resolve => socket.emit('select-node', nodeId, `t-${nodeId}`, resolve));
const adminRunners = boss => boss.request('/api/admin/runners');

async function run() {
  const port = await freePort();
  runtime = defaultRuntime(port);
  const baseUrl = `http://127.0.0.1:${port}`;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-rm-'));
  const runnerRuntime = path.join(scratch, 'rt');
  const logDir = path.join(scratch, 'logs');
  testUsers = await createTestUsers([{login: 'carol'}, {login: 'boss', role: 'admin'}]);
  const credentials = Object.fromEntries(testUsers.users.map(user => [user.login, user]));
  const signIn = login => new QemuWebClient(baseUrl).signIn(login, credentials[login].password);

  // 1. Manual server, no runner: it spawns nothing and answers 503.
  server = startServer(port, logDir);
  await new QemuWebClient(baseUrl).waitForServer(30000, () => server.exitCode === null);
  let boss = await signIn('boss');
  let carol = await signIn('carol');
  assert.equal((await carol.fetch('/api/nodes')).status, 503, 'a session route answers 503 without a runner');
  const before = await adminRunners(boss);
  assert.deepEqual(before.runners, []);
  assert.match(before.connectHint, /scripts\/runner\.sh --port \d+$/);
  assert.match(serverOutput, /No runner connected/);
  assert.equal(fs.statSync(path.join(runtime, `runner-${port}.sock`)).mode & 0o777, 0o600);
  console.log('Manual: no runner, session routes answer 503, /api/admin/runners is empty with its hint');

  // 2. A runner started by hand connects; it prints its own checks.
  const runner = startRunner(port, runnerRuntime, 'runner');
  await waitFor('the runner online in /api/admin/runners', async () => (await adminRunners(boss)).runners.some(item => item.state === 'online'));
  await waitFor('the runner connection line', () => /Connected to the server/.test(runnerOutput.get('runner')));
  assert.match(runnerOutput.get('runner'), /Checking dependencies/);
  assert.match(runnerOutput.get('runner'), /Checking configuration/);
  assert.match(serverOutput, /Runner connected/);
  const [info] = (await adminRunners(boss)).runners;
  assert.equal((await adminRunners(boss)).connectHint, null);
  console.log(`Manual: runner ${runner.pid} connected (${info.engines.join(', ')}), checks printed by the runner itself`);

  // 3. A session works on it; the server touches nothing of the runner's files.
  const {sessionId} = await carol.request('/api/general-settings');
  const switchId = newSwitchId();
  const created = await carol.request('/api/switches', {method: 'POST', body: {id: switchId, name: 'sw1', autostart: true}});
  assert.equal(created.running, true);
  const sessionDir = path.join(runnerRuntime, 'sessions', sessionId);
  assert.ok(fs.existsSync(sessionDir), 'the session is in the runner\'s runtime directory');
  assert.equal(fs.existsSync(path.join(runtime, 'sessions', sessionId)), false);
  assert.equal(fs.existsSync(path.join(runtime, 'users', 'carol')), false, 'the server made no alias');
  assert.equal(fs.readlinkSync(path.join(runnerRuntime, 'users', 'carol')), path.join('..', 'sessions', sessionId), 'the runner made the alias in its own directory');
  assert.match(fs.readFileSync(path.join(runnerRuntime, 'runner.pid'), 'utf8'), /^\d+\n$/, 'the runner holds runner.pid');
  const [switchPid] = await waitFor('the runner\'s vde_switch', () => { const found = switchesOf(runner.pid); return found.length ? found : null; });
  assert.equal((await adminRunners(boss)).runners[0].sessions, 1);
  console.log(`Manual: session ${sessionId} runs switch ${switchId} (vde_switch ${switchPid}) on the runner`);

  // 4. A second runner is refused; the first one keeps its place.
  const intruder = startRunner(port, path.join(scratch, 'rt2'), 'intruder');
  await waitFor('the second runner refused', () => /refused the connection/.test(runnerOutput.get('intruder')), 10000);
  assert.equal((await adminRunners(boss)).runners.length, 1);
  assert.equal(alive(runner.pid), true);
  intruder.kill('SIGTERM');
  await new Promise(resolve => intruder.once('exit', resolve));
  console.log('Manual: a second runner is refused');

  // 5. SIGKILL on the server: the runner and its switch survive.
  for (const socket of sockets.splice(0)) socket.close();
  const exited = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGKILL');
  await exited;
  await delay(1500);
  assert.equal(alive(runner.pid), true, 'the runner died with the server');
  assert.equal(alive(switchPid), true, 'vde_switch died with the server');
  console.log('Manual: server killed (SIGKILL); runner and vde_switch are still running');

  // 6. A new server on the same port: the runner reconnects and its session is adopted.
  server = startServer(port, logDir);
  await new QemuWebClient(baseUrl).waitForServer(30000, () => server.exitCode === null);
  boss = await signIn('boss');
  await waitFor('the runner back (at most 5 s)', async () => (await adminRunners(boss)).runners.some(item => item.state === 'online'), 8000);
  carol = await signIn('carol');
  const again = await carol.request('/api/general-settings');
  assert.equal(again.sessionId, sessionId, 'the user found a different session');
  const nodes = await carol.request('/api/nodes');
  assert.equal(nodes.find(node => node.id === switchId)?.running, true, 'the switch is no longer running');
  assert.equal(alive(switchPid), true);
  assert.equal(fs.existsSync(path.join(runtime, 'users', 'carol')), false);
  assert.equal(fs.readlinkSync(path.join(runnerRuntime, 'users', 'carol')), path.join('..', 'sessions', sessionId), 'the runner\'s alias survived the server restart');
  const adopted = fs.readFileSync(path.join(logDir, USERS_LOG), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(entry => entry.event === 'session-adopted');
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].user, 'carol');
  assert.equal(adopted[0].target.sessionId, sessionId);
  const session = recorder(carol, 'carol');
  await session.connected;
  assert.deepEqual(await select(session.socket, switchId), {ok: true});
  session.socket.emit('input', 'showinfo\r');
  await waitFor('switch terminal output after adoption', () => session.events.some(item => item.event === 'serial' && /VDE|ports|showinfo/i.test(item.payload.data)));
  console.log('Manual: runner reconnected, same session adopted (session-adopted logged), switch running, console works');

  // 7. SIGTERM on the runner: no process and no session directory left.
  for (const socket of sockets.splice(0)) socket.close();
  const runnerExit = new Promise(resolve => runner.once('exit', (code, signal) => resolve({code, signal})));
  runner.kill('SIGTERM');
  const result = await Promise.race([runnerExit, delay(20000).then(() => ({code: 'timeout'}))]);
  assert.equal(result.code, 0, `the runner stopped with ${result.signal || result.code}`);
  assert.equal(alive(switchPid), false, 'vde_switch left after the runner stopped');
  assert.equal(fs.existsSync(sessionDir), false, 'the session directory is left');
  assert.equal(fs.existsSync(path.join(runnerRuntime, 'users')), false, 'the alias is left');
  assert.equal(fs.existsSync(path.join(runnerRuntime, 'runner.pid')), false, 'runner.pid is left');
  await waitFor('no runner listed', async () => (await adminRunners(boss)).runners.length === 0);
  assert.equal((await carol.fetch('/api/nodes')).status, 503);
  console.log('Manual: runner stopped (SIGTERM), no process or session directory left, the server answers 503 again');

  server.kill('SIGTERM');
  assert.equal((await new Promise(resolve => server.once('exit', code => resolve(code)))), 0);
  assert.equal(fs.existsSync(path.join(runtime, `runner-${port}.sock`)), false, 'runner socket left after shutdown');
}

async function cleanup() {
  for (const socket of sockets) socket.close();
  for (const child of [...runners, server]) {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(12000).then(() => child.kill('SIGKILL'))]);
    }
  }
}

run().then(() => console.log('Manual runner test passed.')).catch(error => {
  console.error(`\nManual runner test FAILED: ${error.stack || error.message}`);
  if (serverOutput) console.error(`\n--- QemuWeb output ---\n${serverOutput}`);
  for (const [label, output] of runnerOutput) console.error(`\n--- ${label} output ---\n${output}`);
  process.exitCode = 1;
}).finally(cleanup);
