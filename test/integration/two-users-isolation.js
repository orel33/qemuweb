'use strict';

// Two users logged in on one server at the same time: neither sees nor drives the other's
// nodes, through HTTP or Socket.IO, and no event of one session reaches the other.
// Also checks the authentication gate and self-service deletion.
// Uses VDE switches and host drafts only: no system image or KVM is needed.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const {setTimeout: delay} = require('node:timers/promises');
const io = require('socket.io-client');
const {createTestUsers, spawnServer, QemuWebClient} = require('./qemuweb-client');

const newId = kind => `${kind === 'switch' ? 's' : 'h'}-${crypto.randomBytes(8).toString('hex')}`;
let child;
let baseUrl;
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

async function waitFor(label, condition, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    if (child?.exitCode !== null) throw new Error(`QemuWeb exited while waiting for ${label}.`);
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

// A Socket.IO client that records every event it receives.
function recorder(client, label) {
  const socket = client.socket();
  const events = [];
  socket.onAny((event, ...args) => events.push({event, payload: args[0]}));
  sockets.push(socket);
  const connected = new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', error => reject(new Error(`${label}: ${error.message}`)));
  });
  return {socket, events, connected, label};
}

function select(socket, nodeId) {
  return new Promise(resolve => socket.emit('select-node', nodeId, `t-${nodeId}`, resolve));
}

function mentions(events, values) {
  const text = JSON.stringify(events);
  return values.filter(value => text.includes(value));
}

async function expectStatus(client, route, method, status, body) {
  const response = await client.fetch(route, {method, body});
  assert.equal(response.status, status, `${client.login || 'anonymous'} ${method} ${route} returned ${response.status}, expected ${status}`);
  return response;
}

async function run() {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  testUsers = await createTestUsers([{login: 'alice'}, {login: 'bob'}]);
  child = spawnServer({port, usersFile: testUsers.file});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { serverOutput = (serverOutput + data).slice(-12000); });
  const [aliceUser, bobUser] = testUsers.users;

  // Authentication gate.
  const anonymous = new QemuWebClient(baseUrl);
  await anonymous.waitForServer(30000, () => child.exitCode === null);
  await expectStatus(anonymous, '/api/nodes', 'GET', 401);
  const page = await anonymous.fetch('/');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login.html');
  await expectStatus(anonymous, '/login.html', 'GET', 200);
  await expectStatus(anonymous, '/auth/login', 'POST', 401, {login: 'alice', password: 'wrong'});
  await expectStatus(anonymous, '/auth/login', 'POST', 401, {login: 'nobody', password: 'x'});
  await expectStatus(anonymous, '/api/switches', 'POST', 401, {id: newId('switch'), name: 'anon'});
  await expectStatus(anonymous, '/api/session', 'DELETE', 401);
  const unauthenticatedSocket = io(baseUrl, {reconnection: false, timeout: 5000});
  sockets.push(unauthenticatedSocket);
  const refused = await new Promise(resolve => {
    unauthenticatedSocket.once('connect', () => resolve('connected'));
    unauthenticatedSocket.once('connect_error', error => resolve(error.message));
  });
  assert.equal(refused, 'Authentication required.');
  console.log('Isolation: anonymous API, pages and sockets refused');

  const alice = await new QemuWebClient(baseUrl).signIn(aliceUser.login, aliceUser.password);
  const bob = await new QemuWebClient(baseUrl).signIn(bobUser.login, bobUser.password);
  const aliceSettings = await alice.request('/api/general-settings');
  const bobSettings = await bob.request('/api/general-settings');
  assert.notEqual(aliceSettings.sessionId, bobSettings.sessionId, 'both users share one session');
  assert.deepEqual(await alice.request('/auth/me'), {login: 'alice', role: 'student', authMode: 'password'});
  console.log(`Isolation: alice and bob logged in with sessions ${aliceSettings.sessionId} and ${bobSettings.sessionId}`);

  // Session-level sockets of both users, plus a bob console on his own switch.
  const aliceSession = recorder(alice, 'alice');
  const bobSession = recorder(bob, 'bob');
  await Promise.all([aliceSession.connected, bobSession.connected]);

  const aliceSwitch = newId('switch'), aliceHost = newId('host'), bobSwitch = newId('switch');
  const [system] = await alice.request('/api/systems');
  assert.ok(system, 'config.json lists no system');
  await alice.request('/api/switches', {method: 'POST', body: {id: aliceSwitch, name: 'alicesw', autostart: true}});
  await alice.request('/api/hosts', {method: 'POST', body: {id: aliceHost, name: 'alice-host', imageId: system.id, interfaces: [aliceSwitch]}});
  await bob.request('/api/switches', {method: 'POST', body: {id: bobSwitch, name: 'bobsw', autostart: true}});
  const bobConsole = recorder(bob, 'bob console');
  await bobConsole.connected;
  assert.deepEqual(await select(bobConsole.socket, bobSwitch), {ok: true});

  const aliceIds = [aliceSwitch, aliceHost, aliceSettings.sessionId];
  const bobIds = [bobSwitch, bobSettings.sessionId];
  assert.deepEqual((await alice.request('/api/nodes')).map(node => node.id).sort(), [aliceSwitch, aliceHost].sort());
  assert.deepEqual((await bob.request('/api/nodes')).map(node => node.id), [bobSwitch]);
  assert.doesNotMatch(await (await bob.fetch('/api/topology')).text(), /alice/);
  assert.deepEqual(Object.keys(await bob.request('/api/metrics')), []);
  console.log('Isolation: each user lists only their own nodes, topology and metrics');

  // Bob cannot read or drive alice's nodes over HTTP.
  const hostRoutes = [['GET', 'config'], ['PUT', 'config', {}], ['GET', 'guest-media'], ['PUT', 'guest-media', {script: '#!/bin/sh\n', resources: []}],
    ['POST', 'guest-cdrom', {script: '#!/bin/sh\n', resources: []}], ['PATCH', 'guest-cdrom', {attached: false}],
    ['POST', 'start', {}], ['POST', 'stop'], ['POST', 'reboot'], ['POST', 'reset'], ['POST', 'monitor', {command: 'info status'}]];
  for (const [method, action, body] of hostRoutes) await expectStatus(bob, `/api/nodes/${aliceHost}/${action}`, method, 404, body);
  for (const id of [aliceHost, aliceSwitch]) {
    await expectStatus(bob, `/api/nodes/${id}`, 'PATCH', 404, {name: 'stolen'});
    await expectStatus(bob, `/api/nodes/${id}`, 'DELETE', 404);
  }
  await expectStatus(bob, `/api/nodes/${aliceSwitch}/stop`, 'POST', 404);
  const afterAttempts = await alice.request('/api/nodes');
  assert.equal(afterAttempts.length, 2);
  assert.equal(afterAttempts.find(node => node.id === aliceSwitch).running, true, 'bob stopped alice\'s switch');
  assert.equal(afterAttempts.find(node => node.id === aliceHost).hostname, 'alice-host');
  console.log('Isolation: every cross-session node route answers 404 and changes nothing');

  // Bob cannot reach alice's nodes over Socket.IO either.
  const bobProbe = recorder(bob, 'bob probe');
  await bobProbe.connected;
  for (const id of [aliceSwitch, aliceHost]) assert.deepEqual(await select(bobProbe.socket, id), {error: 'Unknown node.'});
  bobProbe.socket.emit('input', 'shutdown\r');
  bobProbe.socket.emit('clear-console', {id: aliceSwitch, line: ''});
  bobProbe.socket.emit('terminal-resize', {id: aliceSwitch, cols: 100, rows: 30});
  await delay(500);
  assert.equal((await alice.request('/api/nodes')).find(node => node.id === aliceSwitch).running, true);
  console.log('Isolation: bob cannot select, type into, clear or resize alice\'s consoles');

  // A node ID is unique within a session only: bob may hold the same ID without effect on alice.
  const bobCopy = await bob.request('/api/switches', {method: 'POST', body: {id: aliceSwitch, name: 'bobcopy', autostart: false}});
  assert.equal(bobCopy.name, 'bobcopy');
  assert.equal(bobCopy.running, false);
  assert.equal((await bob.request('/api/nodes')).find(node => node.id === aliceSwitch).hostname, 'bobcopy');
  assert.equal((await alice.request('/api/nodes')).find(node => node.id === aliceSwitch).hostname, 'alicesw');
  await bob.request(`/api/nodes/${aliceSwitch}`, {method: 'DELETE'});
  assert.equal((await alice.request('/api/nodes')).find(node => node.id === aliceSwitch).running, true);
  await delay(300);
  // Bob's events about the shared ID concern his own stopped copy only: alice's switch was
  // running the whole time, so none of them may report it running or name it.
  for (const recorded of [bobSession, bobConsole, bobProbe]) {
    assert.deepEqual(mentions(recorded.events, aliceIds.filter(id => id !== aliceSwitch)), [], `${recorded.label} received alice's events`);
    assert.deepEqual(mentions(recorded.events, ['alicesw', 'alice-host']), [], `${recorded.label} received alice's node names`);
    for (const item of recorded.events.filter(entry => mentions([entry], [aliceSwitch]).length)) {
      const ownCopy = (item.event === 'nodes-changed' && item.payload.running === false) ||
        (item.event === 'nodes-removed' && item.payload.ids.length === 1);
      assert.ok(ownCopy, `${recorded.label} received an event about alice's switch: ${JSON.stringify(item)}`);
    }
  }
  assert.ok(bobSession.events.some(item => item.event === 'nodes-removed' && item.payload.ids.includes(aliceSwitch)),
    'bob was not told about the deletion of his own copy');

  // Activity in alice's session reaches alice only. Bob's recorders are checked on the
  // events received from here on, after his own copy of the shared ID is gone.
  const bobMarks = new Map([bobSession, bobConsole, bobProbe].map(recorded => [recorded, recorded.events.length]));
  const aliceConsole = recorder(alice, 'alice console');
  await aliceConsole.connected;
  assert.deepEqual(await select(aliceConsole.socket, aliceSwitch), {ok: true});
  aliceConsole.socket.emit('input', 'showinfo\r');
  await alice.request(`/api/nodes/${aliceHost}`, {method: 'PATCH', body: {name: 'alice-renamed'}});
  await alice.request(`/api/nodes/${aliceSwitch}/stop`, {method: 'POST'});
  await alice.request(`/api/nodes/${aliceSwitch}/start`, {method: 'POST', body: {}});
  await waitFor('alice events', () => ['node-renamed', 'nodes-changed'].every(name => aliceSession.events.some(item => item.event === name)));
  await waitFor('alice console output', () => aliceConsole.events.some(item => item.event === 'serial'));
  await delay(500);
  for (const [recorded, mark] of bobMarks) {
    const since = recorded.events.slice(mark);
    assert.deepEqual(mentions(since, aliceIds), [], `${recorded.label} received alice's events: ${JSON.stringify(since).slice(0, 400)}`);
    assert.deepEqual(mentions(since, ['alicesw', 'alice-renamed']), [], `${recorded.label} received alice's node names`);
    assert.ok(!recorded.events.some(item => item.event === 'node-renamed'), `${recorded.label} received a rename`);
  }
  // Bob's IDs never occur in alice's session, so alice's whole history is checked.
  assert.deepEqual(mentions(aliceSession.events, bobIds), [], 'alice received bob\'s events');
  assert.deepEqual(mentions(aliceConsole.events, bobIds), [], 'alice\'s console received bob\'s events');
  console.log('Isolation: no event of alice\'s session reached bob, and none of bob\'s reached alice');

  // Bob deletes his own session: alice keeps hers.
  await bob.request('/api/session', {method: 'DELETE'});
  await waitFor('session-deleted on bob\'s socket', () => bobSession.events.some(item => item.event === 'session-deleted'));
  assert.ok(!aliceSession.events.some(item => item.event === 'session-deleted'));
  const bobAfter = await bob.request('/api/general-settings');
  assert.notEqual(bobAfter.sessionId, bobSettings.sessionId);
  assert.deepEqual(await bob.request('/api/nodes'), []);
  assert.equal((await alice.request('/api/nodes')).length, 2);
  console.log('Isolation: bob deleted his session; alice\'s nodes are untouched');

  // Logging out stops nothing.
  await alice.signOut();
  await expectStatus(alice, '/api/nodes', 'GET', 401);
  await alice.signIn(aliceUser.login, aliceUser.password);
  assert.equal((await alice.request('/api/general-settings')).sessionId, aliceSettings.sessionId);
  assert.equal((await alice.request('/api/nodes')).find(node => node.id === aliceSwitch).running, true);
  console.log('Isolation: alice logged out and back in to the same running session');
}

async function cleanup() {
  for (const socket of sockets) socket.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)),
      delay(12000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })]);
  }
}

run().then(() => console.log('Two-users isolation test passed.')).catch(error => {
  console.error(`\nTwo-users isolation test FAILED: ${error.stack || error.message}`);
  if (serverOutput) console.error(`\n--- QemuWeb output ---\n${serverOutput}`);
  process.exitCode = 1;
}).finally(cleanup);
