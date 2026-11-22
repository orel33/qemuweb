'use strict';

// The manual mode: the server run alone (`node server/main.js --local-runner`) spawns nothing and answers 503 until a
// runner, started by hand (runner/main.js --port N --token-file F), dials ws://127.0.0.1:<port> with the token the server wrote
// in <runtime>/local-runner.token (never on a command line). The id local is refused without that token. A session
// runs on that runner (VDE switch); the runner and its switch SURVIVE a SIGKILL of the server;
// a new server on the same port is joined again by the runner, and the user finds the SAME
// session, adopted (`session-adopted` in users.log), with its switch still running; a second
// runner is refused (409); SIGTERM on the runner leaves no process and no session directory. A lost token file is
// recreated by a server restart and a runner that waited for it connects; a revoked local runner exits with status 78
// and stays refused after a server restart.
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
const WebSocket = require('ws');
const {setTimeout: delay} = require('node:timers/promises');
const {USERS_LOG} = require('../../server/audit');
const {createTestUsers, spawnServer, QemuWebClient} = require('./qemuweb-client');
const {serverRuntime} = require('../../common/runtime-dir');
const {tokenFilePath} = require('../../common/local-token');

const root = path.join(__dirname, '..', '..');
// The default directory of the SERVER of the port (/tmp/qw-<login>/<port>), set once the port is chosen.
let runtime = null;
let tokenFile = null;
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
  const child = spawnServer({port, usersFile: testUsers.file, standalone: true, localRunner: true, logDir});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { serverOutput = (serverOutput + data).slice(-12000); });
  return child;
}

function startRunner(port, runnerRuntime, label) {
  const child = spawn(process.execPath, ['runner/main.js', '--port', String(port), '--token-file', tokenFile, '--runtime', runnerRuntime], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
  child.label = label;
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
// The HTTP status of an upgrade to /runner/connect with these headers (101 when it is accepted).
const dial = (port, headers) => new Promise(resolve => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/runner/connect`, {headers});
  ws.once('open', () => { ws.terminate(); resolve(101); });
  ws.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
  ws.once('error', () => resolve(0));
});
const exitOf = child => new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));

async function run() {
  const port = await freePort();
  runtime = serverRuntime(port);
  tokenFile = tokenFilePath(runtime);
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
  assert.deepEqual(before.runners.map(item => [item.id, item.state]), [['local', 'offline']], 'the record of the local runner, created by --local-runner');
  assert.match(before.connectHint, /scripts\/runner\.sh --port \d+$/);
  assert.match(serverOutput, /No runner connected/);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600, 'the token file is not 0600');
  const firstToken = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.ok(!serverOutput.includes(firstToken) && !JSON.stringify(before).includes(firstToken), 'the token is shown');
  // The proxy path cannot stand in for the token: from 127.0.0.1 too, the id local needs it.
  assert.equal(await dial(port, {'X-Runner-Id': 'local'}), 401, 'local without a token');
  assert.equal(await dial(port, {'X-Runner-Id': 'local', Authorization: 'Bearer wrong'}), 401, 'local with a wrong token');
  assert.equal(await dial(port, {'X-Runner-Id': 'local', Authorization: `Bearer ${firstToken}`, 'X-Forwarded-For': '10.0.0.1'}), 101, 'local with its token');
  console.log('Manual: no runner, session routes answer 503, the local record exists with its token file, local needs the token');

  // 2. A runner started by hand connects; it prints its own checks.
  const runner = startRunner(port, runnerRuntime, 'runner');
  await waitFor('the runner online in /api/admin/runners', async () => (await adminRunners(boss)).runners.some(item => item.state === 'online'));
  await waitFor('the runner connection line', () => /Connected to the server/.test(runnerOutput.get('runner')));
  assert.match(runnerOutput.get('runner'), /Checking dependencies/);
  assert.match(runnerOutput.get('runner'), /Checking configuration/);
  assert.match(serverOutput, /Runner local \(local\) connected/);
  assert.ok(!(fs.readFileSync(`/proc/${runner.pid}/cmdline`, 'utf8')).includes(firstToken), 'the token is on the runner command line');
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
  assert.equal(fs.existsSync(path.join(runtime, 'sessions')), false, 'the server directory has no sessions/ at all');
  assert.equal(fs.existsSync(path.join(runtime, 'users', 'carol')), false, 'the server made no alias');
  assert.equal(fs.readlinkSync(path.join(runnerRuntime, 'users', 'carol')), path.join('..', 'sessions', sessionId), 'the runner made the alias in its own directory');
  assert.match(fs.readFileSync(path.join(runnerRuntime, 'runner.pid'), 'utf8'), /^\d+\n$/, 'the runner holds runner.pid');
  const [switchPid] = await waitFor('the runner\'s vde_switch', () => { const found = switchesOf(runner.pid); return found.length ? found : null; });
  assert.equal((await adminRunners(boss)).runners[0].sessions, 1);
  const bindingsFile = path.join(runtime, 'bindings.json');
  assert.equal(fs.statSync(bindingsFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(bindingsFile, 'utf8')).sessions.map(item => [item.id, item.owner, item.runnerId]), [[sessionId, 'carol', 'local']], 'the server binds the session to its owner and runner');
  const runnersFile = path.join(path.dirname(testUsers.file), 'runners.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(runnersFile, 'utf8')).runners.map(item => [item.id, item.name, 'tokenHash' in item]), [['local', 'local', false]], 'the record of the local runner has no token hash');
  assert.equal((await boss.request('/api/admin/runners/local/pause', {method: 'POST'})).paused, true);
  console.log(`Manual: session ${sessionId} runs switch ${switchId} (vde_switch ${switchPid}) on the runner`);

  // 4. A second runner is refused; the first one keeps its place.
  const intruder = startRunner(port, path.join(scratch, 'rt2'), 'intruder');
  await waitFor('the second runner refused', () => /already has a connection of this runner/.test(runnerOutput.get('intruder')), 10000);
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
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), firstToken, 'the restart rewrote a readable token file');
  await waitFor('the runner back (its retries double up to 30 s)', async () => (await adminRunners(boss)).runners.some(item => item.state === 'online'), 40000);
  carol = await signIn('carol');
  const again = await carol.request('/api/general-settings');
  assert.equal(again.sessionId, sessionId, 'the user found a different session');
  const [localRow] = (await adminRunners(boss)).runners;
  assert.deepEqual([localRow.id, localRow.paused], ['local', true], 'the pause of the local runner survived the server restart');
  assert.equal((await boss.request('/api/admin/runners/local/resume', {method: 'POST'})).paused, false);
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
  await waitFor('the local runner offline', async () => (await adminRunners(boss)).runners.every(item => item.state === 'offline'));
  assert.equal((await carol.fetch('/api/nodes')).status, 503);
  console.log('Manual: runner stopped (SIGTERM), no process or session directory left, the server answers 503 again');

  // 8. A lost token file: a runner started meanwhile waits for it (no exit), and the next server start recreates it.
  server.kill('SIGTERM');
  assert.equal((await new Promise(resolve => server.once('exit', code => resolve(code)))), 0);
  fs.rmSync(tokenFile);
  const waiting = startRunner(port, path.join(scratch, 'rt2'), 'waiting');
  await waitFor('the runner waits for the token file', () => /does not exist/.test(runnerOutput.get('waiting')), 15000);
  assert.equal(waiting.exitCode, null, 'the runner exited for a missing token file');
  server = startServer(port, logDir);
  await new QemuWebClient(baseUrl).waitForServer(30000, () => server.exitCode === null);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.notEqual(fs.readFileSync(tokenFile, 'utf8').trim(), firstToken, 'the lost file was not recreated with a new token');
  boss = await signIn('boss');
  await waitFor('the waiting runner online with the new token', async () => (await adminRunners(boss)).runners.some(item => item.state === 'online'), 40000);
  console.log('Manual: token file lost, a runner waited for it, the server restart recreated it and the runner connected');

  // 9. Revoked: the runner exits with status 78 and a server restart does not un-revoke it.
  const waitingExit = exitOf(waiting);
  assert.equal((await boss.request('/api/admin/runners/local/revoke', {method: 'POST'})).state, 'revoked');
  const refused = await Promise.race([waitingExit, delay(40000).then(() => ({code: 'timeout'}))]);
  assert.equal(refused.code, 78, `the revoked runner exited with ${refused.signal || refused.code}`);
  assert.match(runnerOutput.get('waiting'), /refused the local runner/);
  server.kill('SIGTERM');
  assert.equal((await new Promise(resolve => server.once('exit', code => resolve(code)))), 0);
  server = startServer(port, logDir);
  await new QemuWebClient(baseUrl).waitForServer(30000, () => server.exitCode === null);
  assert.match(serverOutput, /The local runner is revoked: it stays refused/);
  const stillRefused = startRunner(port, path.join(scratch, 'rt3'), 'revoked');
  const again2 = await Promise.race([exitOf(stillRefused), delay(40000).then(() => ({code: 'timeout'}))]);
  assert.equal(again2.code, 78, 'a --local-runner start un-revoked the local runner');
  console.log('Manual: a revoked local runner exits with status 78 and stays refused after a server restart');

  server.kill('SIGTERM');
  assert.equal((await new Promise(resolve => server.once('exit', code => resolve(code)))), 0);
  fs.rmSync(runtime, {recursive: true, force: true});
}

async function cleanup() {
  for (const socket of sockets) socket.close();
  for (const child of [...runners, server]) {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(12000).then(() => child.kill('SIGKILL'))]);
    }
  }
  if (runtime) fs.rmSync(runtime, {recursive: true, force: true});
}

run().then(() => console.log('Manual runner test passed.')).catch(error => {
  console.error(`\nManual runner test FAILED: ${error.stack || error.message}`);
  if (serverOutput) console.error(`\n--- QemuWeb output ---\n${serverOutput}`);
  for (const [label, output] of runnerOutput) console.error(`\n--- ${label} output ---\n${output}`);
  process.exitCode = 1;
}).finally(cleanup);
