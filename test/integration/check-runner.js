'use strict';

// The local runner process: the server starts runner/main.js in its own process group, reached
// over runtime/runner-<port>.sock; a session works through it (VDE switch start, terminal
// output, stop); a runner killed with SIGKILL takes its processes with it, its sessions are
// dropped (browsers get session-deleted, the runtime directory goes) and a new runner starts;
// server shutdown leaves no runner, vde_switch or qemu-system process, no runtime/sessions/<id>
// and no socket. VDE only: no system image or KVM is needed.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {createTestUsers, spawnServer, QemuWebClient} = require('./qemuweb-client');

const root = path.join(__dirname, '..', '..');
const runtime = path.join(root, 'runtime');
const newSwitchId = () => `s-${crypto.randomBytes(8).toString('hex')}`;
let child;
let testUsers;
let serverOutput = '';
const sockets = [];
process.on('exit', () => testUsers?.cleanup());

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const {port} = server.address();
  await new Promise(resolve => server.close(resolve));
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

// Every process of the machine: {pid, ppid, pgrp, comm, cmdline}.
function processes() {
  const list = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      const comm = stat.slice(stat.indexOf('(') + 1, end);
      const [state, ppid, pgrp] = stat.slice(end + 2).split(' ');
      if (state === 'Z') continue;
      const cmdline = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').join(' ');
      list.push({pid: Number(name), ppid: Number(ppid), pgrp: Number(pgrp), comm, cmdline});
    } catch (_) { /* The process ended meanwhile. */ }
  }
  return list;
}

const runnerOf = serverPid => processes().find(item => item.ppid === serverPid && item.cmdline.includes('runner/main.js')) || null;
const groupMembers = pgrp => processes().filter(item => item.pgrp === pgrp);
const emulators = pgrp => groupMembers(pgrp).filter(item => /^(vde_switch|qemu-system)/.test(item.comm));

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

function select(socket, nodeId) {
  return new Promise(resolve => socket.emit('select-node', nodeId, `t-${nodeId}`, resolve));
}

// A running switch in the user's session, with its console attached; returns the switch ID.
async function startSwitch(client, name) {
  const id = newSwitchId();
  const created = await client.request('/api/switches', {method: 'POST', body: {id, name, autostart: true}});
  assert.equal(created.running, true, `${name} did not start`);
  return id;
}

async function run() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const socketPath = path.join(runtime, `runner-${port}.sock`);
  testUsers = await createTestUsers([{login: 'carol'}]);
  child = spawnServer({port, usersFile: testUsers.file});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { serverOutput = (serverOutput + data).slice(-12000); });
  const anonymous = new QemuWebClient(baseUrl);
  await anonymous.waitForServer(30000, () => child.exitCode === null);

  // The runner process: a child of the server, leader of its own process group, on a 0600 socket.
  const runner = runnerOf(child.pid);
  assert.ok(runner, 'no runner/main.js process under the server');
  assert.equal(runner.pgrp, runner.pid, 'the runner does not lead its own process group');
  assert.match(runner.cmdline, /--exit-on-disconnect/);
  const socketStat = fs.statSync(socketPath);
  assert.ok(socketStat.isSocket(), `${socketPath} is not a socket`);
  assert.equal(socketStat.mode & 0o777, 0o600, 'the runner socket is not 0600');
  console.log(`Runner: process ${runner.pid} started by the server on ${path.relative(root, socketPath)}`);

  // A session works through the runner: switch start, terminal output, stop.
  const [user] = testUsers.users;
  const carol = await new QemuWebClient(baseUrl).signIn(user.login, user.password);
  const {sessionId} = await carol.request('/api/general-settings');
  const sessionDir = path.join(runtime, 'sessions', sessionId);
  const session = recorder(carol, 'carol');
  const console1 = recorder(carol, 'carol console');
  await Promise.all([session.connected, console1.connected]);
  const first = await startSwitch(carol, 'sw1');
  assert.equal(emulators(runner.pid).filter(item => item.comm === 'vde_switch').length, 1, 'vde_switch is not in the runner group');
  assert.deepEqual(await select(console1.socket, first), {ok: true});
  console1.socket.emit('input', 'showinfo\r');
  await waitFor('switch terminal output', () => console1.events.some(item => item.event === 'serial' && /VDE|ports|showinfo/i.test(item.payload.data)));
  await carol.request(`/api/nodes/${first}/stop`, {method: 'POST'});
  await waitFor('vde_switch stopped', () => !emulators(runner.pid).length);
  assert.equal((await carol.request('/api/nodes')).find(node => node.id === first).running, false);
  await carol.request(`/api/nodes/${first}/start`, {method: 'POST', body: {}});
  assert.ok(fs.existsSync(sessionDir), 'no runtime/sessions/<id> for the session');
  console.log('Runner: switch started, terminal output received, switch stopped and restarted through the runner');

  // SIGKILL on the runner: its group dies, the session is dropped, a new runner starts.
  process.kill(runner.pid, 'SIGKILL');
  await waitFor('session-deleted after the runner loss', () => session.events.some(item => item.event === 'session-deleted'));
  await waitFor('no process left in the killed runner group', () => !groupMembers(runner.pid).length);
  await waitFor('runtime directory of the dropped session removed', () => !fs.existsSync(sessionDir));
  assert.equal(child.exitCode, null, 'the server exited after the runner loss');
  const restarted = await waitFor('a new runner process', () => {
    const next = runnerOf(child.pid);
    return next && next.pid !== runner.pid ? next : null;
  });
  const fresh = await waitFor('a new session on the new runner', async () => {
    const response = await carol.fetch('/api/general-settings');
    return response.status === 200 ? response.json() : null;
  });
  assert.notEqual(fresh.sessionId, sessionId, 'the dropped session came back');
  assert.deepEqual(await carol.request('/api/nodes'), []);
  const second = await startSwitch(carol, 'sw2');
  assert.equal(emulators(restarted.pid).length, 1);
  console.log(`Runner: SIGKILL ended its group and its session; runner ${restarted.pid} took over (switch ${second} running)`);

  // Server shutdown: no runner, no emulator, no session directory, no socket.
  const freshDir = path.join(runtime, 'sessions', fresh.sessionId);
  for (const socket of sockets) socket.close();
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  child.kill('SIGTERM');
  const {code, signal} = await Promise.race([exited, delay(15000).then(() => ({code: 'timeout'}))]);
  assert.equal(code, 0, `the server stopped with ${signal || code}`);
  await waitFor('runner group gone after shutdown', () => !groupMembers(restarted.pid).length, 5000);
  assert.equal(fs.existsSync(freshDir), false, 'runtime/sessions/<id> left after shutdown');
  assert.equal(fs.existsSync(socketPath), false, 'runner socket left after shutdown');
  console.log('Runner: server shutdown left no process, session directory or socket');
}

async function cleanup() {
  for (const socket of sockets) socket.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)),
      delay(12000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })]);
  }
}

run().then(() => console.log('Runner test passed.')).catch(error => {
  console.error(`\nRunner test FAILED: ${error.stack || error.message}`);
  if (serverOutput) console.error(`\n--- QemuWeb output ---\n${serverOutput}`);
  process.exitCode = 1;
}).finally(cleanup);
