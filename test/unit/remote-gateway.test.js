// The WebSocket gateway of remote runners (server/remote-gateway.js) with a real `ws` client on a
// loopback port: who may connect (401), one connection per runner (409), and the frame protocol over
// the socket. No runner process; the registry and the store are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {once} = require('node:events');
const WebSocket = require('ws');
const {createRemoteGateway} = require('../../server/remote-gateway');
const {RunnerRegistry} = require('../../server/runner-registry');
const {startLocalRunner} = require('../../server/local-runner-token');
const {createRunnerStore} = require('../../server/runner-store');
const {Connection} = require('../../common/runner-protocol');

async function setup(t, {withLocal = false} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-remote-'));
  const registry = new RunnerRegistry();
  const store = createRunnerStore(path.join(dir, 'runners.json'));
  const server = http.createServer((_req, res) => res.end('web'));
  // The local runner: the token file and the record of a server started with --local-runner.
  const localRunner = withLocal ? startLocalRunner({runtime: path.join(dir, 'server'), store, audit: {record() {}}, log: {log() {}, warn() {}}}) : null;
  const gateway = createRemoteGateway({server, registry, store, localRunner});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets = [];
  t.after(() => {
    for (const ws of sockets) ws.terminate();
    gateway.close();
    server.close();
    server.closeAllConnections();
    fs.rmSync(dir, {recursive: true, force: true});
  });
  const {record, authToken} = store.add({name: 'far'});
  const url = `ws://127.0.0.1:${server.address().port}`;
  // Connects like a runner: {ws} once open, or {status} when the upgrade is refused.
  const dial = (headers, pathname = '/runner/connect') => new Promise(resolve => {
    const ws = new WebSocket(`${url}${pathname}`, {headers});
    sockets.push(ws);
    ws.once('open', () => resolve({ws}));
    ws.once('unexpected-response', (_request, response) => { response.resume(); resolve({status: response.statusCode}); });
    ws.once('error', error => resolve({error}));
  });
  const good = {Authorization: `Bearer ${authToken}`, 'X-Runner-Id': record.id};
  const localToken = withLocal ? fs.readFileSync(localRunner.file, 'utf8').trim() : null;
  return {registry, store, record, authToken, dial, good, localToken, localHeaders: {Authorization: `Bearer ${localToken}`, 'X-Runner-Id': 'local'}};
}

test('an unknown runner, a wrong token, no credentials or a revoked token are refused with 401', async t => {
  const {dial, good, record, store, registry} = await setup(t);
  assert.equal((await dial({})).status, 401);
  assert.equal((await dial({...good, Authorization: 'Bearer wrong'})).status, 401);
  assert.equal((await dial({...good, Authorization: 'Basic abc'})).status, 401);
  assert.equal((await dial({...good, 'X-Runner-Id': 'r-00000000'})).status, 401);
  store.change(record.id, {revoked: true});
  assert.equal((await dial(good)).status, 401, 'revoked');
  assert.equal(registry.list().length, 0, 'nothing registered');
});

test('a valid runner is registered with the fields of its record, and speaks the frame protocol', async t => {
  const {dial, good, record, registry} = await setup(t);
  const {ws} = await dial(good);
  assert.ok(ws);
  await new Promise(resolve => setTimeout(resolve, 50));
  const entry = registry.get(record.id);
  assert.deepEqual([entry.state, entry.name, 'local' in entry, 'trusted' in entry], ['starting', 'far', false, false]);
  assert.ok(entry.address);
  const connection = new Connection(WebSocket.createWebSocketStream(ws));
  const online = once(registry, 'online');
  connection.send({type: 'hello', engines: ['qemu'], runtimeRoot: '/anything', limits: {maxSessions: 2}, sessions: []});
  await online;
  assert.equal(entry.state, 'online');
  assert.equal(entry.runtimeRoot, '/anything', 'the announced directory is display text only');
  assert.equal(entry.capabilities.limits.maxSessions, 2);
  // A request goes out as a frame and the answer comes back.
  const answer = entry.client.request('nodes.list', {}, null);
  const [message] = await new Promise(resolve => connection.once('message', message => resolve([message])));
  assert.equal(message.type, 'request');
  connection.send({type: 'response', id: message.id, result: {ok: true}});
  assert.deepEqual(await answer, {ok: true});
});

test('a second connection of a live runner is refused with 409; after the first is lost it is accepted', async t => {
  const {dial, good, record, registry} = await setup(t);
  const first = await dial(good);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await dial(good)).status, 409);
  const lost = once(registry, 'lost');
  first.ws.terminate();
  await lost;
  assert.equal(registry.get(record.id).state, 'lost');
  assert.ok((await dial(good)).ws, 'the runner is back');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(registry.get(record.id).state, 'starting');
});

test('the id "local" is refused when the server has no --local-runner, whatever the token', async t => {
  const {dial, good, store, registry} = await setup(t);
  store.ensureLocal();
  for (const token of [good.Authorization.slice(7), '', 'local', 'a'.repeat(64)]) {
    assert.equal((await dial({Authorization: `Bearer ${token}`, 'X-Runner-Id': 'local'})).status, 401);
  }
  assert.equal(registry.list().length, 0);
});

test('with --local-runner the id "local" needs the token of the file: the address (a proxy reaches the server from 127.0.0.1 too) proves nothing', async t => {
  const {dial, good, localHeaders, authToken, registry} = await setup(t, {withLocal: true});
  assert.equal((await dial({'X-Runner-Id': 'local'})).status, 401, 'no token');
  assert.equal((await dial({...localHeaders, Authorization: 'Bearer wrong'})).status, 401, 'wrong token');
  assert.equal((await dial({...localHeaders, Authorization: `Bearer ${authToken}`})).status, 401, 'the token of a remote runner is not the local one');
  assert.ok((await dial({...localHeaders, 'X-Forwarded-For': '203.0.113.9', 'X-Real-IP': '127.0.0.1'})).ws, 'headers add nothing and take nothing away: the token is the proof');
  assert.equal(registry.list().length, 1);
  const {ws} = await dial({...good});
  assert.ok(ws, 'a remote runner keeps working beside it');
});

test('a remote runner cannot take the id "local", and the local token opens no other id', async t => {
  const {dial, good, localToken, record, store, registry} = await setup(t, {withLocal: true});
  assert.equal((await dial({'X-Runner-Id': record.id, Authorization: `Bearer ${localToken}`})).status, 401, 'the local token for a remote id');
  assert.equal((await dial({'X-Runner-Id': 'local', Authorization: good.Authorization})).status, 401, 'a remote token for local');
  assert.equal(store.get('local').tokenHash, undefined, 'local has no token hash to be guessed');
  assert.equal(registry.list().length, 0);
});

test('the local runner is registered with its record, one connection at a time (409), and again once lost', async t => {
  const {dial, localHeaders, store, registry} = await setup(t, {withLocal: true});
  store.change('local', {paused: true});
  const first = await dial(localHeaders);
  assert.ok(first.ws);
  await new Promise(resolve => setTimeout(resolve, 50));
  const entry = registry.get('local');
  assert.deepEqual([entry.name, entry.paused, entry.state, 'local' in entry, 'trusted' in entry], ['local', true, 'starting', false, false]);
  assert.equal(entry.registeredAt, Date.parse(store.get('local').createdAt));
  assert.equal((await dial(localHeaders)).status, 409);
  const lost = once(registry, 'lost');
  first.ws.terminate();
  await lost;
  assert.ok((await dial(localHeaders)).ws, 'back with the same token');
});

test('a revoked or forgotten local record is refused (401) and the refusal is logged once', async t => {
  t.mock.method(console, 'log', () => {});
  const {dial, localHeaders, store, registry} = await setup(t, {withLocal: true});
  store.change('local', {revoked: true});
  for (let attempt = 0; attempt < 3; attempt++) assert.equal((await dial(localHeaders)).status, 401);
  assert.equal(console.log.mock.calls.length, 1, 'once, not at every retry');
  store.remove('local');
  assert.equal((await dial(localHeaders)).status, 401, 'a forgotten record is not created by a connection');
  assert.equal(registry.list().length, 0);
});

test('the registry keeps only checked fields of a hello', async t => {
  const {dial, good, record, registry} = await setup(t);
  const {ws} = await dial(good);
  const connection = new Connection(WebSocket.createWebSocketStream(ws));
  const online = once(registry, 'online');
  connection.send({type: 'hello', engines: ['qemu', 'bogus', 3], kvm: 'yes', cpus: '4', memoryBytes: 8e9, runtimeRoot: '/data/runtime/../runtime', limits: {maxSessions: 3},
    images: [], warnings: ['ok', 7, 'x'.repeat(400)], sessions: []});
  await online;
  const entry = registry.get(record.id);
  assert.deepEqual(entry.capabilities.engines, ['qemu']);
  assert.equal(entry.capabilities.kvm, false);
  assert.equal(entry.capabilities.cpus, null);
  assert.equal(entry.capabilities.memoryBytes, 8e9);
  assert.deepEqual(entry.capabilities.images, {});
  assert.equal(entry.capabilities.warnings.length, 2);
  assert.equal(entry.capabilities.warnings[1].length, 300);
  assert.deepEqual(entry.capabilities.limits, {maxSessions: 3});
  assert.equal(entry.runtimeRoot, '/data/runtime/../runtime', 'display text only, as announced');
});

test('the directory and the pid a hello announces are display text: bounded, printable, never decided on', () => {
  const registry = new RunnerRegistry();
  const handlers = {};
  registry.add({id: 'r-00000001', client: {on: (event, handler) => { handlers[event] = handler; }}});
  handlers.hello({runtimeRoot: `/a\u0000b\n${'x'.repeat(9000)}`, pid: '12', engines: ['qemu']});
  const entry = registry.get('r-00000001');
  assert.ok(entry.runtimeRoot.length <= 4096 && !/[\x00-\x1f]/.test(entry.runtimeRoot));
  assert.equal(entry.pid, null);
  handlers.hello({runtimeRoot: 7, pid: 4242, engines: ['qemu']});
  assert.deepEqual([entry.runtimeRoot, entry.pid], [null, 4242]);
});

test('pickRunner says whether a runner is connected', () => {
  const registry = new RunnerRegistry();
  assert.throws(() => registry.pickRunner('toto'), error => error.status === 503 && /No runner is available/.test(error.message));
});

test('only /runner/connect is the gateway\'s: another upgrade path gets no answer from it (Socket.IO\'s handler owns its own)', async t => {
  const {dial, good} = await setup(t);
  const outcome = await Promise.race([dial(good, '/elsewhere'), new Promise(resolve => setTimeout(() => resolve('untouched'), 300))]);
  assert.equal(outcome, 'untouched');
});
