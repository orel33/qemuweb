// The runner gateway (server/runner-gateway.js): who may connect, and what the registry keeps of a
// hello. Real Unix sockets in a short temporary directory; no server and no runner process.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {once} = require('node:events');
const {createRunnerGateway} = require('../../server/runner-gateway');
const {RunnerRegistry} = require('../../server/runner-registry');
const {createRunnerStore} = require('../../server/runner-store');
const {Connection} = require('../../common/runner-protocol');

async function setup(t) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-gw-'));
  const registry = new RunnerRegistry();
  const store = createRunnerStore(path.join(runtimeRoot, 'runners.json'));
  const gateway = createRunnerGateway({root: runtimeRoot, runtimeRoot, port: 4999, registry, store});
  await gateway.start();
  const sockets = [];
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    gateway.close();
    fs.rmSync(runtimeRoot, {recursive: true, force: true});
  });
  // Connects like a runner; resolves with {socket, connection, closed} once connected.
  const dial = async () => {
    const socket = net.createConnection(gateway.socketPath);
    sockets.push(socket);
    await once(socket, 'connect');
    const closed = once(socket, 'close');
    return {socket, connection: new Connection(socket), closed};
  };
  return {runtimeRoot, registry, gateway, dial, store};
}

test('the socket is private (0600)', async t => {
  const {gateway} = await setup(t);
  assert.equal(fs.statSync(gateway.socketPath).mode & 0o777, 0o600);
});

test('the gateway accepts one runner, with the fields of its record, and refuses a second while it lives', async t => {
  const {registry, dial} = await setup(t);
  const first = await dial();
  await new Promise(resolve => setTimeout(resolve, 50));
  const entry = registry.get('local');
  assert.ok(entry);
  assert.deepEqual([entry.name, 'trusted' in entry, 'local' in entry], ['local', false, false]);
  const second = await dial();
  await second.closed;
  assert.equal(registry.get('local'), entry, 'the first runner keeps its place');
  assert.equal(entry.state, 'starting');
  first.connection.send({type: 'hello', engines: ['qemu'], sessions: []});
  await once(registry, 'online');
  assert.equal(entry.state, 'online');
  const third = await dial();
  await third.closed;
  assert.equal(registry.get('local'), entry);
});

test('the place is free again once the runner is lost', async t => {
  const {registry, dial} = await setup(t);
  const first = await dial();
  await new Promise(resolve => setTimeout(resolve, 50));
  const lost = once(registry, 'lost');
  first.socket.destroy();
  await lost;
  const entry = registry.get('local');
  assert.equal(entry.state, 'lost');
  await dial();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.notEqual(registry.get('local'), entry);
  assert.equal(registry.get('local').state, 'starting');
});

test('the registry keeps only checked fields of a hello', async t => {
  const {registry, dial} = await setup(t);
  const runner = await dial();
  const online = once(registry, 'online');
  runner.connection.send({type: 'hello', engines: ['qemu', 'bogus', 3], kvm: 'yes', cpus: '4', memoryBytes: 8e9, runtimeRoot: '/data/runtime/../runtime', limits: {maxSessions: 3},
    images: [], warnings: ['ok', 7, 'x'.repeat(400)], sessions: []});
  await online;
  const entry = registry.get('local');
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

test('the first connection creates the record "local" once; its pause and registration date apply to every connection', async t => {
  const {registry, dial, store} = await setup(t);
  assert.equal(store.count(), 0);
  const first = await dial();
  await new Promise(resolve => setTimeout(resolve, 50));
  const record = store.get('local');
  assert.equal(record.name, 'local');
  assert.equal(registry.get('local').registeredAt, Date.parse(record.createdAt));
  const lost = once(registry, 'lost');
  first.socket.destroy();
  await lost;
  store.change('local', {paused: true});
  await dial();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(store.count(), 1, 'one record, reused');
  assert.equal(store.get('local').createdAt, record.createdAt);
  assert.equal(registry.get('local').paused, true, 'the pause kept in runners.json applies to the new connection');
});

test('a revoked local runner is refused at its connection (the Unix equivalent of the 401) until its record is forgotten', async t => {
  t.mock.method(console, 'log', () => {});
  const {registry, dial, store} = await setup(t);
  store.ensureLocal();
  store.change('local', {revoked: true});
  for (let attempt = 0; attempt < 2; attempt++) {
    const refused = await dial();
    await refused.closed;
    assert.equal(registry.get('local'), null, 'never registered');
  }
  assert.equal(console.log.mock.calls.length, 1, 'the refusal is logged once, not at every retry');
  store.remove('local');
  await dial();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(registry.get('local').state, 'starting', 'a forgotten record is created again at the next connection');
  assert.equal(store.get('local').revoked, undefined);
});

test('pickRunner says whether a runner is connected', () => {
  const registry = new RunnerRegistry();
  assert.throws(() => registry.pickRunner('toto'), error => error.status === 503 && /No runner is available/.test(error.message));
});
