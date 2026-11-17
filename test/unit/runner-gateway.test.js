// The runner gateway (lib/runner-gateway.js): who may connect, and what the registry keeps of a
// hello. Real Unix sockets in a short temporary directory; no server and no runner process.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {once} = require('node:events');
const {createRunnerGateway} = require('../../lib/runner-gateway');
const {RunnerRegistry} = require('../../lib/runner-registry');
const {Connection} = require('../../common/runner-protocol');

async function setup(t) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-gw-'));
  const registry = new RunnerRegistry();
  const gateway = createRunnerGateway({root: runtimeRoot, runtimeRoot, port: 4999, registry});
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
  return {runtimeRoot, registry, gateway, dial};
}

test('the socket is private (0600)', async t => {
  const {gateway} = await setup(t);
  assert.equal(fs.statSync(gateway.socketPath).mode & 0o777, 0o600);
});

test('the gateway accepts one runner, trusted, and refuses a second while it lives', async t => {
  const {registry, dial} = await setup(t);
  const first = await dial();
  await new Promise(resolve => setTimeout(resolve, 50));
  const entry = registry.get('local');
  assert.ok(entry);
  assert.equal(entry.trusted, true);
  const second = await dial();
  await second.closed;
  assert.equal(registry.get('local'), entry, 'the first runner keeps its place');
  assert.equal(entry.state, 'starting');
  first.connection.send({type: 'hello', engines: ['qemu'], runtimeRoot: '/tmp/x', sessions: []});
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
  runner.connection.send({type: 'hello', engines: ['qemu', 'bogus', 3], kvm: 'yes', cpus: '4', memoryBytes: 8e9, runtimeRoot: '/data/runtime/../runtime',
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
  assert.equal(entry.runtimeRoot, '/data/runtime');
  for (const runtimeRoot of ['relative/path', 5, null, undefined, `/${'x'.repeat(5000)}`]) {
    const other = new RunnerRegistry();
    const [client] = [{on: (event, handler) => { if (event === 'hello') other.helloHandler = handler; }}];
    const added = other.add({id: 'local', client});
    other.helloHandler({runtimeRoot});
    assert.equal(added.runtimeRoot, null, `runtimeRoot ${String(runtimeRoot).slice(0, 20)} is refused`);
  }
});

test('pickRunner says whether a runner is connected', () => {
  const registry = new RunnerRegistry();
  assert.throws(() => registry.pickRunner('toto'), error => error.status === 503 && /No runner is connected/.test(error.message));
});
