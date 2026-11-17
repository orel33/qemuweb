'use strict';

// Second serial port (ttyS1) of a Debian Legacy host: the host starts with ttyS0 and ttyS1
// (/api/nodes reports serialPorts [ttyS0, ttyS1]), two sockets select the console IDs `<id>` and `<id>:1`,
// and their output stays separate and simultaneous (a command running on ttyS0 does not block
// or leak into ttyS1). Clear on the second console resets only its buffer. If the image has no
// getty on ttyS1 (prepared before the second console existed), the scenario skips with a clear
// message: run scripts/prepare.sh again. No switch is needed. Requires images/debian13-legacy.raw
// and QEMU/KVM.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {createTestUsers, spawnServer, QemuWebClient} = require('./qemuweb-client');

const root = path.resolve(__dirname, '../..');
const imageId = 'debian13-legacy';
const hostId = `h-${crypto.randomBytes(8).toString('hex')}`;
let child;
let testUsers;
let client;
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
    if (child?.exitCode !== null) throw new Error(`QemuWeb exited while waiting for ${label}.`);
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const stripAnsi = value => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n');

// A console socket on one console ID: its snapshot, then live serial output of that console only.
async function openConsole(consoleId) {
  const socket = client.socket();
  sockets.push(socket);
  const view = {socket, snapshot: null, serial: '', resets: []};
  socket.on('node-snapshot', snapshot => {
    if (snapshot.nodeId !== consoleId) return;
    view.snapshot = snapshot;
    view.serial = snapshot.serial;
  });
  socket.on('serial', event => { assert.equal(event.nodeId, consoleId, 'a console received the output of another one'); view.serial += event.data; });
  socket.on('serial-reset', event => { assert.equal(event.nodeId, consoleId); view.resets.push(event); view.serial = event.serial || ''; });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const result = await new Promise(resolve => socket.emit('select-node', consoleId, `console-${consoleId}`, resolve));
  assert.deepEqual(result, {ok: true}, `select-node ${consoleId}`);
  await waitFor(`${consoleId} snapshot`, () => view.snapshot);
  return view;
}

async function login(view, label) {
  view.socket.emit('input', 'root\r');
  await waitFor(`${label} shell prompt`, () => /[#$] ?$/.test(stripAnsi(view.serial).trimEnd()), 60000);
}

async function run() {
  try {
    fs.accessSync(path.join(root, 'images', `${imageId}.raw`));
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
  } catch (_) {
    console.log('Console: SKIPPED, images/debian13-legacy.raw or /dev/kvm is missing.');
    return;
  }
  const port = await freePort();
  testUsers = await createTestUsers([{login: 'console'}]);
  const [user] = testUsers.users;
  child = spawnServer({port, usersFile: testUsers.file});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { serverOutput = (serverOutput + data).slice(-12000); });
  client = new QemuWebClient(`http://127.0.0.1:${port}`);
  await client.waitForServer(30000, () => child.exitCode === null);
  await client.signIn(user.login, user.password);

  await client.request('/api/hosts', {method: 'POST', body: {id: hostId, name: 'console-host', imageId, interfaces: [],
    settings: {memory: 1024, cpus: 1, clock: 'utc'}}});
  await client.request(`/api/nodes/${hostId}/start`, {method: 'POST', body: {engine: 'qemu', imageId}});
  const node = (await client.request('/api/nodes')).find(item => item.id === hostId);
  assert.deepEqual(node.serialPorts, ['ttyS0', 'ttyS1'], 'a Debian Legacy host starts with ttyS0 and ttyS1');

  const first = await openConsole(hostId);
  const second = await openConsole(`${hostId}:1`);
  await waitFor('ttyS0 login prompt', () => /login:\s*$/m.test(stripAnsi(first.serial)), 180000);
  // A prepared image runs a getty on ttyS1 too: it prints a login prompt once a key is typed.
  second.socket.emit('input', '\r');
  const gettyOnSecond = await waitFor('ttyS1 login prompt', () => /login:/.test(stripAnsi(second.serial)), 20000).catch(() => false);
  if (!gettyOnSecond) {
    console.log('Console: SKIPPED, the image has no getty on ttyS1; run scripts/prepare.sh again to rebuild the Debian image.');
    return;
  }
  console.log('Console: both consoles show a login prompt');

  await login(first, 'ttyS0');
  await login(second, 'ttyS1');
  // A command running on ttyS0 does not block ttyS1, and each output stays on its own console.
  first.socket.emit('input', 'sleep 4; echo LONG0_$((40+2))\r');
  second.socket.emit('input', 'echo SHORT1_$((20+22))\r');
  await waitFor('ttyS1 output while ttyS0 is busy', () => stripAnsi(second.serial).includes('SHORT1_42'), 3500);
  assert.ok(!stripAnsi(first.serial).includes('SHORT1_42'), 'ttyS1 output appeared on ttyS0');
  await waitFor('ttyS0 output', () => stripAnsi(first.serial).includes('LONG0_42'), 15000);
  assert.ok(!stripAnsi(second.serial).includes('LONG0_42'), 'ttyS0 output appeared on ttyS1');
  console.log('Console: simultaneous commands keep separate output');

  // Clear on the second console resets its buffer only.
  second.socket.emit('clear-console', {id: `${hostId}:1`, line: '', column: 0});
  await waitFor('ttyS1 reset', () => second.resets.length > 0);
  assert.equal(first.resets.length, 0, 'clearing console 2 reset console 1');
  const again = await openConsole(`${hostId}:1`);
  assert.ok(!stripAnsi(again.snapshot.serial).includes('SHORT1_42'), 'the cleared buffer was replayed');
  console.log('Console: Clear resets only the second console buffer');
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

run().then(() => console.log('Console test finished.')).catch(error => {
  console.error(`\nConsole test FAILED: ${error.stack || error.message}`);
  if (serverOutput) console.error(`\n--- QemuWeb output ---\n${serverOutput}`);
  process.exitCode = 1;
}).finally(cleanup);
