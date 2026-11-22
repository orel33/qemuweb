// Remote runner scenario (milestone 5c), no VM image needed (VDE switch only): the server alone
// (standalone), an administrator creates a registration token through the API, `runner.sh
// register` and `run` (node runner/main.js register|run, with a temporary HOME so that no
// file of the user is touched) connect a runner over ws://127.0.0.1 through a small TCP proxy. A
// user session is placed on it and its switch terminal answers. The proxy then cuts the network:
// the switch survives, the session answers 503 and its page is told, then everything works again
// and the SAME switch is still running. Pause refuses new sessions; revoke disconnects the runner,
// which stops retrying. Takes about 40 seconds.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');
const {createTestUsers, spawnServer, QemuWebClient} = require('./qemuweb-client');

const root = path.join(__dirname, '..', '..');
const newSwitchId = () => `s-${crypto.randomBytes(8).toString('hex')}`;
const sockets = [];
const children = [];
let testUsers;
let scratch;
process.on('exit', () => { for (const child of children) child.kill('SIGKILL'); testUsers?.cleanup(); if (scratch) fs.rmSync(scratch, {recursive: true, force: true}); });

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const {port} = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitFor(label, condition, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

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

// A TCP proxy between the runner and the server that the test can cut (every connection destroyed,
// nothing accepted) and restore on the same port.
function createProxy(targetPort) {
  const connections = new Set();
  let listener = null;
  let port = 0;
  async function listen() {
    listener = net.createServer(client => {
      const upstream = net.connect(targetPort, '127.0.0.1');
      for (const socket of [client, upstream]) {
        connections.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => { connections.delete(socket); client.destroy(); upstream.destroy(); });
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise(resolve => listener.listen(port, '127.0.0.1', resolve));
    port = listener.address().port;
  }
  return {
    listen,
    get port() { return port; },
    cut() { listener.close(); listener = null; for (const socket of connections) socket.destroy(); },
    restore: listen
  };
}

// Runs a runner command (register or run) with an isolated home and config directory.
function runner(args, env, label, output) {
  const child = spawn(process.execPath, ['runner/main.js', ...args], {cwd: root, env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
  output.set(label, '');
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => output.set(label, (output.get(label) + data).slice(-12000)));
  child.exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  children.push(child);
  return child;
}

function recorder(client) {
  const socket = client.socket();
  const events = [];
  socket.onAny((event, ...args) => events.push({event, payload: args[0]}));
  sockets.push(socket);
  const connected = new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return {socket, events, connected};
}

const select = (socket, nodeId) => new Promise(resolve => socket.emit('select-node', nodeId, `t-${nodeId}`, resolve));
const adminRunners = boss => boss.request('/api/admin/runners');

async function run() {
  const serverPort = await freePort();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-rr-'));
  const logDir = path.join(scratch, 'logs');
  const runnersFile = path.join(scratch, 'runners.json');
  const home = path.join(scratch, 'home');
  const runtime = path.join(scratch, 'rt');
  const env = {HOME: home};
  const output = new Map();
  testUsers = await createTestUsers([{login: 'carol'}, {login: 'dave'}, {login: 'boss', role: 'admin'}]);
  const credentials = Object.fromEntries(testUsers.users.map(user => [user.login, user]));
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  const signIn = login => new QemuWebClient(baseUrl).signIn(login, credentials[login].password);
  const proxy = createProxy(serverPort);
  await proxy.listen();
  const remoteUrl = `ws://127.0.0.1:${proxy.port}`;

  // 1. The server alone, no runner: a session cannot be placed.
  let server = spawnServer({port: serverPort, usersFile: testUsers.file, logDir, runnersFile, standalone: true});
  children.push(server);
  await new QemuWebClient(baseUrl).waitForServer(30000, () => server.exitCode === null);
  assert.match(server.output, /runners\.json absent/, 'the startup check says no runner is registered');
  let boss = await signIn('boss');
  let carol = await signIn('carol');
  assert.equal((await carol.fetch('/api/nodes')).status, 503);
  assert.match((await carol.request('/api/nodes').catch(error => error)).message, /No runner is available/);
  console.log('Remote: server alone, a session cannot be placed (No runner is available)');

  // 2. Registration with a one-time token; a second use and a wrong token are refused.
  const created = await boss.request('/api/admin/runners/registration-tokens', {method: 'POST', body: {minutes: 15}});
  assert.match(created.command, new RegExp(`runner\\.sh register --url http://127\\.0\\.0\\.1:${serverPort} --token `));
  const register = runner(['register', '--url', remoteUrl, '--token', created.token, '--name', 'test remote', '--runtime', runtime], env, 'register', output);
  assert.equal((await register.exited).code, 0, output.get('register'));
  assert.doesNotMatch(output.get('register'), new RegExp(created.token), 'the registration token is never printed');
  const runnerFile = path.join(home, '.config', 'qemuweb-runner', 'runner.json');
  assert.equal(fs.statSync(runnerFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(runnerFile)).mode & 0o777, 0o700);
  const identity = JSON.parse(fs.readFileSync(runnerFile, 'utf8'));
  assert.match(identity.runnerId, /^r-[0-9a-f]{8}$/);
  assert.equal(fs.statSync(runnersFile).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(runnersFile, 'utf8'), new RegExp(identity.authToken), 'the server stores only a hash');
  const again = runner(['register', '--url', remoteUrl, '--token', created.token, '--runner-config', path.join(scratch, 'second', 'runner.json')], env, 'again', output);
  assert.notEqual((await again.exited).code, 0, 'a registration token is single use');
  console.log(`Remote: registered ${identity.runnerId} with a one-time token (runner.json 0600, hash only on the server)`);

  // 3. `run`: the runner appears online and takes the session.
  const remote = runner(['run'], env, 'run', output);
  await waitFor('the remote runner online', async () => (await adminRunners(boss)).runners.some(item => item.id === identity.runnerId && item.state === 'online'));
  assert.match(output.get('run'), /Checking configuration/);
  assert.doesNotMatch(output.get('run'), new RegExp(identity.authToken), 'the authentication token is never printed');
  const info = (await adminRunners(boss)).runners.find(item => item.id === identity.runnerId);
  assert.deepEqual([info.name, info.address, 'local' in info], ['test remote', '127.0.0.1', false]);
  carol = await signIn('carol');
  const {sessionId} = await carol.request('/api/general-settings');
  const switchId = newSwitchId();
  const made = await carol.request('/api/switches', {method: 'POST', body: {id: switchId, name: 'sw1', autostart: true}});
  assert.equal(made.running, true);
  assert.ok(fs.existsSync(path.join(runtime, 'sessions', sessionId)), 'the session lives in the remote runner\'s runtime');
  const [switchPid] = await waitFor('the remote runner\'s vde_switch', () => { const found = switchesOf(remote.pid); return found.length ? found : null; });
  assert.equal((await adminRunners(boss)).runners.find(item => item.id === identity.runnerId).sessions, 1);
  const page = recorder(carol);
  await page.connected;
  assert.deepEqual(await select(page.socket, switchId), {ok: true});
  page.socket.emit('input', 'showinfo\r');
  await waitFor('switch terminal output', () => page.events.some(item => item.event === 'serial' && /VDE|ports|showinfo/i.test(item.payload.data)));
  console.log(`Remote: session ${sessionId} placed on the remote runner, switch ${switchId} (vde_switch ${switchPid}) answers`);

  // 4. The network is cut: no VM dies, the session answers 503, the page is told.
  proxy.cut();
  await waitFor('the runner offline', async () => (await adminRunners(boss)).runners.find(item => item.id === identity.runnerId).state === 'offline');
  assert.equal(alive(switchPid), true, 'vde_switch died with the network');
  assert.equal(alive(remote.pid), true);
  const offline = await carol.fetch('/api/nodes');
  assert.equal(offline.status, 503);
  assert.match((await offline.json()).error, /offline/);
  await waitFor('runner-state offline on the page', () => page.events.some(item => item.event === 'runner-state' && item.payload.online === false));
  assert.match(output.get('run'), /lost, reconnecting/);
  console.log('Remote: network cut: switch alive, session answers 503, the page is told');

  // 5. The network comes back: the runner reconnects, the same switch is running.
  await delay(2500);
  await proxy.restore();
  await waitFor('the runner back online', async () => (await adminRunners(boss)).runners.find(item => item.id === identity.runnerId).state === 'online', 40000);
  const nodes = await waitFor('the session answering again', async () => { const response = await carol.fetch('/api/nodes'); return response.status === 200 ? response.json() : null; });
  assert.equal(nodes.find(node => node.id === switchId)?.running, true, 'the switch is no longer running');
  assert.deepEqual(switchesOf(remote.pid), [switchPid], 'a different vde_switch is running');
  await waitFor('runner-state online on the page', () => page.events.some(item => item.event === 'runner-state' && item.payload.online === true));
  assert.deepEqual(await select(page.socket, switchId), {ok: true});
  page.events.length = 0;
  page.socket.emit('input', 'showinfo\r');
  await waitFor('switch terminal output after the cut', () => page.events.some(item => item.event === 'serial' && /VDE|ports|showinfo/i.test(item.payload.data)));
  console.log('Remote: network restored: runner back, same session and same vde_switch, console works again');

  // 5b. The server restarts (SIGKILL) while the runner lives: the session is restored offline from bindings.json, then adopted
  // when the runner's hello lists it (the runner retries every 2 s doubling to 30 s): same session, same switch.
  for (const socket of sockets.splice(0)) socket.close();
  const stopped = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGKILL');
  await stopped;
  assert.equal(alive(switchPid), true, 'vde_switch died with the server');
  server = spawnServer({port: serverPort, usersFile: testUsers.file, logDir, runnersFile, standalone: true});
  children.push(server);
  await new QemuWebClient(baseUrl).waitForServer(30000, () => server.exitCode === null);
  boss = await signIn('boss');
  carol = await signIn('carol');
  const restoredReply = await carol.fetch('/api/nodes');
  if (restoredReply.status === 503) assert.match((await restoredReply.json()).error, /^The runner of your session is offline; it comes back or your session is dropped after \d+ seconds?\.$/, 'the restored session says why it waits');
  await waitFor('the remote runner back after the server restart', async () => (await adminRunners(boss)).runners.find(item => item.id === identity.runnerId)?.state === 'online', 60000);
  assert.equal((await carol.request('/api/general-settings')).sessionId, sessionId, 'the user got a different session');
  const afterRestart = await carol.request('/api/nodes');
  assert.equal(afterRestart.find(node => node.id === switchId)?.running, true, 'the switch is no longer running');
  assert.deepEqual(switchesOf(remote.pid), [switchPid], 'a different vde_switch is running');
  assert.match(fs.readFileSync(path.join(logDir, 'users.log'), 'utf8'), /"event":"session-adopted"/);
  console.log('Remote: server restarted: the session was restored offline, then adopted by the runner\'s hello, same switch running');

  // 6. Pause: no new session is placed; resume.
  await boss.request(`/api/admin/runners/${identity.runnerId}/pause`, {method: 'POST'});
  const dave = await signIn('dave');
  assert.equal((await dave.fetch('/api/nodes')).status, 503, 'a paused runner takes no new session');
  assert.equal((await carol.fetch('/api/nodes')).status, 200, 'running sessions continue');
  await boss.request(`/api/admin/runners/${identity.runnerId}/resume`, {method: 'POST'});
  assert.equal((await dave.fetch('/api/nodes')).status, 200, 'placed again after resume');
  console.log('Remote: pause refuses new sessions, resume accepts them');

  // 7. Revoke: the runner is disconnected and stops retrying.
  await boss.request(`/api/admin/runners/${identity.runnerId}/revoke`, {method: 'POST'});
  const result = await Promise.race([remote.exited, delay(30000).then(() => ({code: 'timeout'}))]);
  assert.equal(result.code, 78, `the revoked runner should stop with status 78 (${result.code}): ${output.get('run')}`);
  assert.match(output.get('run'), /refused this runner/);
  assert.equal(alive(switchPid), false, 'the revoked runner stopped its machines');
  assert.equal((await adminRunners(boss)).runners.find(item => item.id === identity.runnerId).state, 'revoked');
  assert.equal((await adminRunners(boss)).runners.find(item => item.id === identity.runnerId).sessions, 0, 'a revoked runner\'s sessions are dropped at once');
  const audit = fs.readFileSync(path.join(logDir, 'admin.log'), 'utf8');
  for (const action of ['create-runner-token', 'register-runner', 'pause-runner', 'resume-runner', 'revoke-runner']) assert.match(audit, new RegExp(`"action":"${action}"`), `${action} audited`);
  assert.ok(!audit.includes(created.token) && !audit.includes(identity.authToken), 'no token in the audit log');
  console.log('Remote: revoked, the runner stopped for good; every action audited');
}

run().then(() => { for (const socket of sockets) socket.close(); process.exit(0); }, error => {
  console.error(error);
  for (const child of children) if (child.output) console.error(child.output.slice(-3000));
  process.exit(1);
});
