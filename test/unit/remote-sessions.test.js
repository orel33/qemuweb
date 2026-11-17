// Remote runners in the control plane: placement (pickRunner), the rule that the server touches
// the files of the local runner only, and the grace period and rebinding after a network cut.
// Runners are in-memory services or fakes; no process, no socket.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {EventEmitter, once} = require('node:events');
const {duplexPair} = require('node:stream');
const {createRunnerService, serveConnection} = require('../../runner');
const {Connection} = require('../../common/runner-protocol');
const {RunnerClient} = require('../../server/runner-client');
const {RunnerRegistry} = require('../../server/runner-registry');
const {SessionManager} = require('../../server/session-manager');
const {root, commands} = require('./runner-pair');

const quiet = t => { t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'log', () => {}); };
const tempDir = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
};
const until = async condition => {
  for (let turn = 0; turn < 400 && !condition(); turn++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), 'condition reached');
};

// A fake runner client that says hello with the given fields.
function fakeRunner(registry, id, hello = {}, options = {}) {
  const client = Object.assign(new EventEmitter(), {close() { this.emit('close', null); }});
  const entry = registry.add({id, client, ...options});
  client.emit('hello', {engines: ['qemu'], ...hello});
  return {client, entry};
}

test('placement: online, not paused, with an engine, under maxSessions; least loaded wins, local first on a tie', t => {
  quiet(t);
  const registry = new RunnerRegistry();
  const counts = {local: 1, 'r-00000001': 1, 'r-00000002': 0, 'r-00000003': 0, 'r-00000004': 0, 'r-00000005': 0};
  const sessionsOf = id => counts[id] ?? 0;
  fakeRunner(registry, 'local', {}, {local: true, trusted: true});
  fakeRunner(registry, 'r-00000001', {limits: {maxSessions: 2}}, {registeredAt: 1});
  assert.equal(registry.pickRunner('a', sessionsOf).id, 'r-00000001', '1/2 beats 1 session without limit');
  fakeRunner(registry, 'r-00000002', {}, {registeredAt: 2});
  assert.equal(registry.pickRunner('a', sessionsOf).id, 'r-00000002', 'no session at all');
  registry.get('r-00000002').paused = true;
  assert.equal(registry.pickRunner('a', sessionsOf).id, 'r-00000001', 'paused runner skipped');
  fakeRunner(registry, 'r-00000003', {engines: []}, {registeredAt: 3});
  fakeRunner(registry, 'r-00000004', {limits: {maxSessions: 1}}, {registeredAt: 4});
  counts['r-00000004'] = 1;
  assert.equal(registry.pickRunner('a', sessionsOf).id, 'r-00000001', 'no engine and full runners skipped');
  fakeRunner(registry, 'r-00000005', {}, {registeredAt: 5});
  counts.local = 0; counts['r-00000001'] = 1; counts['r-00000005'] = 0;
  assert.equal(registry.pickRunner('a', sessionsOf).id, 'local', 'tie: the local runner first');
  registry.get('local').client.close();
  assert.equal(registry.pickRunner('a', sessionsOf).id, 'r-00000005', 'the least loaded of the rest');
});

test('no candidate: 503 "No runner is available" with the reasons in the log', t => {
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const registry = new RunnerRegistry();
  assert.throws(() => registry.pickRunner('a'), error => error.status === 503 && error.message === 'No runner is available.');
  fakeRunner(registry, 'r-00000001', {limits: {maxSessions: 1}}, {paused: true});
  fakeRunner(registry, 'r-00000002', {limits: {maxSessions: 1}});
  assert.throws(() => registry.pickRunner('a', id => (id === 'r-00000002' ? 1 : 0)), /No runner is available/);
  assert.match(warnings.at(-1), /r-00000001: paused; r-00000002: full \(1\/1\)/);
});

test('a remote runner that announces the server\'s own runtime directory makes the server touch nothing', t => {
  quiet(t);
  const runtime = tempDir(t, 'qw-flag-');
  const registry = new RunnerRegistry();
  const manager = new SessionManager({runtimeRoot: runtime, registry, graceSeconds: 0});
  const fake = fakeRunner(registry, 'r-00000001', {runtimeRoot: runtime, sessions: []}, {registeredAt: 1});
  assert.equal(fake.entry.runtimeRoot, null);
  fake.client.session = id => ({sessionId: id, client: fake.client, events: new EventEmitter(), request: async () => ({})});
  fake.client.release = () => {};
  const workspace = manager.open('toto');
  // Directories the server would delete or link if it believed it shared the runtime.
  fs.mkdirSync(workspace.session.runtimeDir, {recursive: true});
  fs.writeFileSync(path.join(workspace.session.runtimeDir, 'precious'), 'x');
  assert.equal(fs.existsSync(path.join(runtime, 'users')), false, 'no alias was created');
  assert.equal(manager.sharesRuntime(fake.entry), false);
  fake.client.close();
  assert.equal(manager.get('toto'), null, 'dropped at once without grace');
  assert.ok(fs.existsSync(path.join(workspace.session.runtimeDir, 'precious')), 'the directory is untouched');
  // The same with a grace period that expires.
  const slow = new SessionManager({runtimeRoot: runtime, registry: new RunnerRegistry(), graceSeconds: 0.01});
  const other = fakeRunner(slow.registry, 'r-00000002', {runtimeRoot: runtime}, {registeredAt: 1});
  other.client.session = fake.client.session;
  other.client.release = () => {};
  const kept = slow.open('titi');
  fs.mkdirSync(kept.session.runtimeDir, {recursive: true});
  other.client.close();
  return new Promise(resolve => setTimeout(resolve, 60)).then(() => {
    assert.equal(slow.get('titi'), null);
    assert.ok(fs.existsSync(kept.session.runtimeDir), 'still untouched after the grace period');
  });
});

// A remote runner service reachable through connections that can be cut and made again.
async function remoteRunner(t, registry, id = 'r-00000001') {
  const runtimeRoot = tempDir(t, 'qw-far-');
  const service = createRunnerService({commands, root, runtimeRoot, configPath: path.join(root, 'config.json')});
  const clients = [];
  async function connect() {
    const [controlSide, runnerSide] = duplexPair();
    const client = new RunnerClient(new Connection(controlSide));
    clients.push(client);
    registry.add({id, client, name: 'far', registeredAt: 1});
    const online = once(registry, 'online');
    serveConnection(new Connection(runnerSide), service);
    await online;
    return client;
  }
  t.after(async () => { await service.shutdown(); for (const client of clients) client.close(); });
  return {service, connect};
}

test('a network cut keeps the session for the grace period; the runner\'s return rebinds the same handle', async t => {
  quiet(t);
  const registry = new RunnerRegistry();
  const manager = new SessionManager({runtimeRoot: tempDir(t, 'qw-cp-'), registry, graceSeconds: 60});
  const far = await remoteRunner(t, registry);
  const first = await far.connect();
  const workspace = manager.open('toto');
  await workspace.runner.request('switch.create', {id: 's-00000000000000aa', name: 'sw', autostart: false});
  const changes = [];
  manager.on('connectivity', (_workspace, online) => changes.push(online));

  first.close();
  assert.equal(manager.get('toto'), workspace, 'kept');
  assert.equal(manager.available(workspace), false);
  await assert.rejects(workspace.runner.request('nodes.list'), error => error.status === 503 && /offline/.test(error.message));
  assert.deepEqual(changes, [false]);

  const second = await far.connect();
  assert.equal(manager.get('toto').runner, workspace.runner, 'the handle is the same object');
  assert.equal(workspace.runner.client, second);
  assert.equal(manager.available(workspace), true);
  assert.deepEqual(changes, [false, true]);
  const nodes = await workspace.runner.request('nodes.list');
  assert.ok(JSON.stringify(nodes).includes('s-00000000000000aa'), 'the node is still there');
  await workspace.runner.request('switch.create', {id: 's-00000000000000bb', name: 'sw2', autostart: false});
});

test('a session the runner no longer lists is dropped when it returns', async t => {
  quiet(t);
  const registry = new RunnerRegistry();
  const manager = new SessionManager({runtimeRoot: tempDir(t, 'qw-cp-'), registry, graceSeconds: 60});
  const far = await remoteRunner(t, registry);
  const first = await far.connect();
  const workspace = manager.open('toto');
  await workspace.runner.request('nodes.list');
  const removed = [];
  manager.on('removed', (_workspace, by, reason) => removed.push([by, reason]));
  first.close();
  await far.service.handle('session.delete', workspace.session.id);
  await far.connect();
  assert.equal(manager.get('toto'), null);
  assert.deepEqual(removed, [[null, 'runner lost']]);
});

test('after the grace period the session is dropped; the runner that returns is told to delete it', async t => {
  quiet(t);
  const registry = new RunnerRegistry();
  const manager = new SessionManager({runtimeRoot: tempDir(t, 'qw-cp-'), registry, graceSeconds: 0.05});
  const far = await remoteRunner(t, registry);
  const first = await far.connect();
  const workspace = manager.open('toto');
  await workspace.runner.request('nodes.list');
  const removed = [];
  manager.on('removed', (_workspace, by, reason) => removed.push([by, reason]));
  first.close();
  await until(() => removed.length === 1);
  assert.deepEqual(removed, [[null, 'runner offline too long']]);
  assert.equal(manager.get('toto'), null);
  assert.equal(far.service.hello().sessions.length, 1, 'the runner still has it');
  await far.connect();
  await until(() => far.service.hello().sessions.length === 0);
  assert.equal(manager.get('toto'), null, 'never adopted: a remote runner is untrusted');
});

test('the local runner is never kept: its sessions are dropped at once', async t => {
  quiet(t);
  const runtime = tempDir(t, 'qw-cp-');
  const registry = new RunnerRegistry();
  const manager = new SessionManager({runtimeRoot: runtime, registry, graceSeconds: 60});
  const fake = fakeRunner(registry, 'local', {}, {local: true, trusted: true});
  fake.client.session = id => ({sessionId: id, client: fake.client, events: new EventEmitter(), request: async () => ({})});
  fake.client.release = () => {};
  manager.open('toto');
  fake.client.close();
  assert.equal(manager.get('toto'), null);
});
