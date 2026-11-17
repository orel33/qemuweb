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
const {createRunnerStore} = require('../../server/runner-store');
const {Connection} = require('../../common/runner-protocol');

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-remote-'));
  const registry = new RunnerRegistry();
  const store = createRunnerStore(path.join(dir, 'runners.json'));
  const server = http.createServer((_req, res) => res.end('web'));
  const gateway = createRemoteGateway({server, registry, store});
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
  return {registry, store, record, authToken, dial, good};
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

test('a valid runner is registered as remote, untrusted, and speaks the frame protocol', async t => {
  const {dial, good, record, registry} = await setup(t);
  const {ws} = await dial(good);
  assert.ok(ws);
  await new Promise(resolve => setTimeout(resolve, 50));
  const entry = registry.get(record.id);
  assert.deepEqual([entry.state, entry.local, entry.trusted, entry.name], ['starting', false, false, 'far']);
  assert.ok(entry.address);
  const connection = new Connection(WebSocket.createWebSocketStream(ws));
  const online = once(registry, 'online');
  connection.send({type: 'hello', engines: ['qemu'], runtimeRoot: '/anything', limits: {maxSessions: 2}, sessions: []});
  await online;
  assert.equal(entry.state, 'online');
  assert.equal(entry.runtimeRoot, null, 'a remote runtime directory is ignored');
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

test('only /runner/connect is the gateway\'s: another upgrade path gets no answer from it (Socket.IO\'s handler owns its own)', async t => {
  const {dial, good} = await setup(t);
  const outcome = await Promise.race([dial(good, '/elsewhere'), new Promise(resolve => setTimeout(() => resolve('untouched'), 300))]);
  assert.equal(outcome, 'untouched');
});
