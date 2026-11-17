'use strict';

// Closing the browser then coming back finds the running nodes and their consoles: a user
// starts a VDE switch (and, when the Debian Legacy image and KVM are available, a host),
// types into the consoles, disconnects every socket and logs out, then logs in again with
// a new cookie and gets the same session, still running, with the console and log history
// replayed by node-snapshot. RECONNECT_HOST=0 skips the host part.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {createTestUsers, spawnServer, QemuWebClient} = require('./qemuweb-client');

const root = path.resolve(__dirname, '../..');
const imageId = 'debian13-legacy';
const switchId = `s-${crypto.randomBytes(8).toString('hex')}`;
const hostId = `h-${crypto.randomBytes(8).toString('hex')}`;
let child;
let testUsers;
let client;
let serverOutput = '';
const sockets = [];
process.on('exit', () => testUsers?.cleanup());

function hostAvailable() {
  if (process.env.RECONNECT_HOST === '0') return false;
  try {
    fs.accessSync(path.join(root, 'images', `${imageId}.raw`));
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (_) { return false; }
}

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
    if (child?.exitCode !== null) throw new Error(`QemuWeb exited while waiting for ${label}.`);
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n');
}

// A console socket on one node: its snapshot, then live serial output.
async function openConsole(nodeId) {
  const socket = client.socket();
  sockets.push(socket);
  const view = {socket, snapshot: null, serial: ''};
  socket.on('node-snapshot', snapshot => {
    if (snapshot.nodeId !== nodeId) return;
    view.snapshot = snapshot;
    view.serial = snapshot.serial;
  });
  socket.on('serial', event => { if (event.nodeId === nodeId) view.serial += event.data; });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const result = await new Promise(resolve => socket.emit('select-node', nodeId, `reconnect-${nodeId}`, resolve));
  assert.deepEqual(result, {ok: true}, `select-node ${nodeId}`);
  await waitFor(`${nodeId} snapshot`, () => view.snapshot);
  return view;
}

async function run() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  testUsers = await createTestUsers([{login: 'reconnect'}]);
  const [user] = testUsers.users;
  child = spawnServer({port, usersFile: testUsers.file});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { serverOutput = (serverOutput + data).slice(-12000); });
  client = new QemuWebClient(baseUrl);
  await client.waitForServer(30000, child);
  await client.signIn(user.login, user.password);
  const {sessionId} = await client.request('/api/general-settings');
  const withHost = hostAvailable();
  console.log(`Reconnect: logged in, session ${sessionId}${withHost ? '' : ' (host part skipped: no image, no KVM or RECONNECT_HOST=0)'}`);

  await client.request('/api/switches', {method: 'POST', body: {id: switchId, name: 'reconnectsw', autostart: true}});
  const switchConsole = await openConsole(switchId);
  const initialLength = switchConsole.serial.length;
  switchConsole.socket.emit('input', 'showinfo\r');
  await waitFor('switch terminal output', () => switchConsole.serial.length > initialLength);
  let hostConsole;
  if (withHost) {
    await client.request('/api/hosts', {method: 'POST', body: {id: hostId, name: 'reconnect-host', imageId, interfaces: [switchId],
      settings: {memory: 1024, cpus: 1, clock: 'utc'}}});
    await client.request(`/api/nodes/${hostId}/start`, {method: 'POST', body: {engine: 'qemu', imageId}});
    hostConsole = await openConsole(hostId);
    await waitFor('host login prompt', () => /login:\s*$/m.test(stripAnsi(hostConsole.serial)), 180000);
  }
  const before = {
    switchSerial: switchConsole.serial,
    hostSerial: hostConsole?.serial,
    nodes: await client.request('/api/nodes')
  };
  console.log('Reconnect: consoles produced output; closing every socket and logging out');

  for (const socket of sockets.splice(0)) socket.close();
  await client.signOut();
  assert.equal(client.cookie, null);
  await delay(2000);

  client = new QemuWebClient(baseUrl);
  await client.signIn(user.login, user.password);
  assert.equal((await client.request('/api/general-settings')).sessionId, sessionId, 'a new session was opened');
  const nodes = await client.request('/api/nodes');
  assert.deepEqual(nodes.map(node => node.id).sort(), before.nodes.map(node => node.id).sort());
  for (const node of nodes) assert.equal(node.running, true, `${node.hostname} stopped while the user was away`);

  const switchAgain = await openConsole(switchId);
  assert.equal(switchAgain.snapshot.state.running, true);
  assert.ok(switchAgain.snapshot.logs.length > 0, 'the switch log was lost');
  assert.ok(before.switchSerial.length > 0 && switchAgain.snapshot.serial.includes(before.switchSerial.slice(-200)), 'the switch terminal history was lost');
  switchAgain.socket.emit('input', 'help\r');
  await waitFor('switch terminal after reconnect', () => switchAgain.serial.length > switchAgain.snapshot.serial.length);
  console.log('Reconnect: switch still running, terminal history and log replayed, input works');

  if (withHost) {
    const hostAgain = await openConsole(hostId);
    assert.equal(hostAgain.snapshot.state.running, true);
    assert.match(stripAnsi(hostAgain.snapshot.serial), /login:/, 'the host console history was lost');
    assert.ok(hostAgain.snapshot.serial.includes(before.hostSerial.slice(-200)), 'the host console history differs');
    assert.ok(hostAgain.snapshot.logs.some(line => line.includes('qemu-system-x86_64')), 'the host log was lost');
    hostAgain.socket.emit('input', 'root\r');
    await waitFor('host console after reconnect', () => hostAgain.serial.length > hostAgain.snapshot.serial.length, 30000);
    console.log('Reconnect: host still running, console history and log replayed, input works');
  }
}

async function cleanup() {
  for (const socket of sockets) socket.close();
  if (child && child.exitCode === null) {
    try { await client?.request('/api/session', {method: 'DELETE'}); } catch (_) {}
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)),
      delay(12000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })]);
  }
}

run().then(() => console.log('Session reconnect test passed.')).catch(error => {
  console.error(`\nSession reconnect test FAILED: ${error.stack || error.message}`);
  if (serverOutput) console.error(`\n--- QemuWeb output ---\n${serverOutput}`);
  process.exitCode = 1;
}).finally(cleanup);
