'use strict';

// The launch sequence scripts/start.sh: the server and a runner, two processes under start.sh,
// each leader of its own process group; the runner reaches the server over the WebSocket with the token of
// <runtime>/local-runner.token (created by the server, never on the runner's command line); a session works through it (VDE switch start, terminal output,
// stop). A runner killed with SIGKILL takes its group with it (nothing is restarted): start.sh
// stops the server and exits with an error, browsers get session-deleted, no process is
// left; the server removes no directory, so the dead runner's session directory (with its switch)
// stays, and the next runner replaces the stale runner.pid, keeps that non-empty directory and
// says so in its log (PST01 will decide restore or discard). SIGTERM on start.sh (the harness's stop) stops the runner and the
// server cleanly: exit code 0, no runner, vde_switch or qemu-system process, no
// runtime/sessions/<id>; the token file stays (it is the server's) and the second launch reuses the same token. VDE only: no system image or KVM is needed.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {createTestUsers, spawnServer, QemuWebClient} = require('./qemuweb-client');
const {serverRuntime, localRunnerRuntime} = require('../../common/runtime-dir');

const root = path.join(__dirname, '..', '..');
// The default directories of the port (common/runtime-dir.js), set once the port is chosen: the server's (/tmp/qw-<login>/<port>: pid record,
// token file, no sessions/) and the local runner's (/tmp/qw-<login>/l-<port>: sessions, aliases, runner.pid).
let serverDir = null;
let runtime = null;
const newSwitchId = () => `s-${crypto.randomBytes(4).toString('hex')}`;
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

const childOf = (parentPid, script) => processes().find(item => item.ppid === parentPid && item.cmdline.includes(script)) || null;
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
  serverDir = serverRuntime(port);
  runtime = localRunnerRuntime(port);
  const baseUrl = `http://127.0.0.1:${port}`;
  const tokenFile = path.join(serverDir, 'local-runner.token');
  testUsers = await createTestUsers([{login: 'carol'}]);
  child = spawnServer({port, usersFile: testUsers.file});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { serverOutput = (serverOutput + data).slice(-12000); });
  const anonymous = new QemuWebClient(baseUrl);
  await anonymous.waitForServer(30000, child);

  // Two processes under start.sh, each leading its own process group; the runner dials the server with the token
  // of the file the server created (0600), and the token is on no command line.
  const runner = childOf(child.pid, 'runner/main.js');
  const server = childOf(child.pid, 'server/main.js');
  assert.ok(runner, 'no runner/main.js process under start.sh');
  assert.ok(server, 'no server/main.js process under start.sh');
  assert.equal(runner.pgrp, runner.pid, 'the runner does not lead its own process group');
  assert.equal(server.pgrp, server.pid, 'the server does not lead its own process group');
  assert.notEqual(runner.pgrp, server.pgrp);
  assert.match(runner.cmdline, /--exit-on-disconnect/);
  assert.match(child.output, /\[server\] /);
  assert.match(child.output, /\[runner\] /);
  assert.match(child.output, /QemuWeb is ready\./);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600, 'the token file is not 0600');
  assert.equal(fs.existsSync(path.join(serverDir, 'sessions')), false, 'the server directory has no sessions/');
  assert.ok(fs.existsSync(path.join(runtime, 'runner.pid')), 'the runner has its own directory l-<port> (runner.pid; an empty sessions/ is pruned at start)');
  assert.match(runner.cmdline, new RegExp(`--runtime ${runtime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'start.sh passes the runner its own directory');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.ok(token.length >= 32);
  assert.match(runner.cmdline, new RegExp(`--port ${port} --token-file ${tokenFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(!processes().some(item => item.cmdline.includes(token)), 'the token is on a command line');
  assert.ok(!/runner-\d+\.sock/.test(runner.cmdline + server.cmdline), 'a runner socket is still named');
  assert.match(child.output, /Runner local \(local\) connected from /);
  console.log(`Runner: process ${runner.pid} and server ${server.pid} started by start.sh; the runner connected with ${path.relative(root, tokenFile)}`);

  // A session works through the runner: switch start, terminal output, stop.
  const [user] = testUsers.users;
  const carol = await new QemuWebClient(baseUrl).signIn(user.login, user.password);
  const {sessionId} = await carol.request('/api/general-settings');
  const sessionDir = path.join(runtime, 'sessions', sessionId);
  const session = recorder(carol, 'carol');
  const console1 = recorder(carol, 'carol console');
  await Promise.all([session.connected, console1.connected]);
  assert.equal(fs.existsSync(sessionDir), false, 'UXS02: the session is placed on the runner only by its first node');
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

  // SIGKILL on the runner: its group dies, the session is dropped, start.sh stops everything.
  const exitedAfterKill = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  process.kill(runner.pid, 'SIGKILL');
  await waitFor('session-deleted after the runner loss', () => session.events.some(item => item.event === 'session-deleted'));
  await waitFor('no process left in the killed runner group', () => !groupMembers(runner.pid).length);
  // The server never removes a path of a runner (docs/runner-model.md R1) and a SIGKILLed runner cannot tidy up: the directory
  // of the dropped session stays, with its switch inside, until the next runner on that directory starts (see below).
  assert.ok(fs.existsSync(sessionDir), 'the server removed the runtime directory of the dropped session');
  const failure = await Promise.race([exitedAfterKill, delay(20000).then(() => ({code: 'timeout'}))]);
  assert.ok(failure.code !== 0 && failure.code !== 'timeout', `start.sh did not fail after the runner loss (${failure.signal || failure.code})`);
  await waitFor('no process left under the server group', () => !groupMembers(server.pid).length, 5000);
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), token, 'the token file changed');
  assert.ok(fs.existsSync(path.join(runtime, 'runner.pid')), 'the killed runner could not release runner.pid');
  assert.match(child.output, /The runner exited/);
  console.log(`Runner: SIGKILL ended its group and its session (its directory stays: the server removes nothing); start.sh stopped the server and exited (${failure.code}); nothing restarted`);

  // A second launch, then the stop: SIGTERM on start.sh leaves no process or session directory.
  child = spawnServer({port, usersFile: testUsers.file});
  await new QemuWebClient(baseUrl).waitForServer(30000, child);
  const again = await new QemuWebClient(baseUrl).signIn(user.login, user.password);
  const next = childOf(child.pid, 'runner/main.js');
  // The new runner replaces the stale runner.pid and prunes its directory at start: the old session holds a switch, so it is
  // NOT empty and stays, reported in the runner's log (restore or discard is the PST01 policy; cleanall.sh removes it).
  await waitFor('the runner reports the non-empty leftover', () => child.output.includes(`Kept 1 non-empty session directory left by an earlier runner: ${sessionId}`), 10000);
  assert.ok(fs.existsSync(sessionDir), 'the start-up pruning removed a non-empty session directory');
  assert.equal(fs.readFileSync(path.join(runtime, 'runner.pid'), 'utf8').trim(), String(next.pid), 'runner.pid holds the new runner');
  const nextServer = childOf(child.pid, 'server/main.js');
  assert.ok(next && next.pid !== runner.pid, 'no new runner under the second start.sh');
  const second = await startSwitch(again, 'sw2');
  assert.equal(emulators(next.pid).length, 1);
  const {sessionId: freshId} = await again.request('/api/general-settings');
  assert.notEqual(freshId, sessionId);
  const freshDir = path.join(runtime, 'sessions', freshId);
  assert.ok(fs.existsSync(freshDir));
  console.log(`Runner: start.sh launched again, runner ${next.pid} runs switch ${second}`);

  for (const socket of sockets) socket.close();
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  child.kill('SIGTERM');
  const {code, signal} = await Promise.race([exited, delay(30000).then(() => ({code: 'timeout'}))]);
  assert.equal(code, 0, `start.sh stopped with ${signal || code}`);
  await waitFor('runner group gone after the stop', () => !groupMembers(next.pid).length, 5000);
  await waitFor('server group gone after the stop', () => !groupMembers(nextServer.pid).length, 5000);
  assert.equal(fs.existsSync(freshDir), false, 'runtime/sessions/<id> left after the stop');
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), token, 'the second launch did not reuse the token');
  assert.equal(fs.existsSync(path.join(runtime, 'runner.pid')), false, 'runner.pid left after the stop');
  console.log('Runner: SIGTERM on start.sh stopped the runner and the server (exit 0), leaving no process or session directory');
  // What the SIGKILLed runner left (this test's own debris, on its own random port).
  fs.rmSync(runtime, {recursive: true, force: true});
  fs.rmSync(serverDir, {recursive: true, force: true});
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
