// Remote runners in the control plane: placement (pickRunner), the grace period and rebinding after a network cut.
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
const {createSessionBindings} = require('../../server/session-bindings');
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

test('placement: online, not paused, with an engine, under maxSessions; least loaded wins, the earliest registered on a tie', t => {
  quiet(t);
  const registry = new RunnerRegistry();
  const counts = {local: 1, 'r-00000001': 1, 'r-00000002': 0, 'r-00000003': 0, 'r-00000004': 0, 'r-00000005': 0};
  const sessionsOf = id => counts[id] ?? 0;
  fakeRunner(registry, 'local', {}, {registeredAt: 0});
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
  assert.equal(registry.pickRunner('a', sessionsOf).id, 'local', 'tie: the earliest registered (here the record of "local")');
  registry.get('local').registeredAt = 10;
  assert.equal(registry.pickRunner('a', sessionsOf).id, 'r-00000005', 'tie: "local" has no special case, its registeredAt decides');
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

test('the server creates no file for any runner, whatever its hello announces, with or without a grace period', t => {
  quiet(t);
  const runtime = tempDir(t, 'qw-flag-');
  const registry = new RunnerRegistry();
  const manager = new SessionManager({registry, graceSeconds: 0});
  const fake = fakeRunner(registry, 'r-00000001', {runtimeRoot: runtime, sessions: []}, {registeredAt: 1});
  assert.equal(fake.entry.runtimeRoot, runtime, 'kept as display text only');
  fake.client.session = id => ({sessionId: id, client: fake.client, events: new EventEmitter(), request: async () => ({})});
  fake.client.release = () => {};
  manager.open('toto');
  assert.deepEqual(fs.readdirSync(runtime), [], 'no alias, no directory');
  fake.client.close();
  assert.equal(manager.get('toto'), null, 'dropped at once without grace');
  // The same with a grace period that expires.
  const slow = new SessionManager({registry: new RunnerRegistry(), graceSeconds: 0.01});
  const other = fakeRunner(slow.registry, 'r-00000002', {runtimeRoot: runtime}, {registeredAt: 1});
  other.client.session = fake.client.session;
  other.client.release = () => {};
  slow.open('titi');
  other.client.close();
  return new Promise(resolve => setTimeout(resolve, 60)).then(() => {
    assert.equal(slow.get('titi'), null);
    assert.deepEqual(fs.readdirSync(runtime), [], 'still nothing after the grace period');
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
  const manager = new SessionManager({registry, graceSeconds: 60});
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
  const manager = new SessionManager({registry, graceSeconds: 60});
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
  const manager = new SessionManager({registry, graceSeconds: 0.05});
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
  assert.equal(manager.get('toto'), null, 'never adopted: no binding names this runner');
});

test('a server restart keeps the sessions of a local and of a remote runner: restored offline, adopted at each hello, unknown ones deleted', async t => {
  quiet(t);
  const registry = new RunnerRegistry();
  const bindings = createSessionBindings();
  const near = await remoteRunner(t, registry, 'local');
  const far = await remoteRunner(t, registry, 'r-00000001');
  const ID = n => n.toString(16).padStart(16, '0');
  // Before the restart the runners already ran machines for their users; the server's bindings name the owners.
  for (const [service, id, owner, node] of [[near.service, ID(1), 'toto', 's-00000000000000a1'], [far.service, ID(2), 'titi', 's-00000000000000a2']]) {
    await service.handle('session.create', id, {owner});
    await service.handle('switch.create', id, {id: node, name: 'sw', autostart: false});
  }
  await far.service.handle('session.create', ID(3), {owner: 'ghost'});
  bindings.set({id: ID(1), owner: 'toto', runnerId: 'local', createdAt: '2026-01-02T03:04:05.000Z'});
  bindings.set({id: ID(2), owner: 'titi', runnerId: 'r-00000001', createdAt: '2026-01-02T03:04:05.000Z'});
  const manager = new SessionManager({registry, graceSeconds: 60, bindings});
  t.after(() => { manager.cancelGrace('local'); manager.cancelGrace('r-00000001'); });
  const adopted = [];
  manager.on('adopted', workspace => adopted.push(workspace.owner));
  manager.restore(() => ({}));
  assert.deepEqual(manager.list().map(workspace => [workspace.owner, manager.available(workspace)]), [['toto', false], ['titi', false]]);
  assert.throws(() => registry.pickRunner('new'), error => error.status === 503, 'no runner is online: no new session opens elsewhere');
  const toto = manager.get('toto');
  assert.equal(manager.open('toto'), toto);
  await far.connect();
  assert.equal(manager.available(manager.get('titi')), true);
  assert.equal(manager.available(toto), false, 'the local runner has not come back yet');
  await near.connect();
  assert.deepEqual(adopted.sort(), ['titi', 'toto']);
  assert.ok(JSON.stringify(await toto.runner.request('nodes.list')).includes('s-00000000000000a1'), 'the local runner\'s machine');
  assert.ok(JSON.stringify(await manager.get('titi').runner.request('nodes.list')).includes('s-00000000000000a2'), 'the remote runner\'s machine');
  await until(() => !far.service.hello().sessions.some(item => item.sessionId === ID(3)));
  assert.deepEqual(far.service.hello().sessions.map(item => item.sessionId), [ID(2)], 'the unknown session was deleted, the bound one kept');
});

test('the local runner has no special rule: with no grace its sessions are dropped at once, with a grace they are kept', async t => {
  quiet(t);
  for (const [grace, kept] of [[0, false], [60, true]]) {
    const registry = new RunnerRegistry();
    const manager = new SessionManager({registry, graceSeconds: grace});
    const fake = fakeRunner(registry, 'local');
    fake.client.session = id => ({sessionId: id, client: fake.client, events: new EventEmitter(), request: async () => ({})});
    fake.client.release = () => {};
    manager.open('toto');
    fake.client.close();
    assert.equal(manager.get('toto') !== null, kept, `grace ${grace}`);
    for (const timer of manager.graceTimers.values()) clearTimeout(timer);
  }
});

test('a remote runner offers and accepts only the systems whose image it has', async t => {
  const dir = tempDir(t, 'qw-images-');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const [system] = Object.keys(catalog.systems).filter(id => id !== 'default');
  for (const id of Object.keys(catalog.systems).filter(id => id !== 'default')) {
    for (const engine of ['qemu', 'vbox']) catalog.systems[id][`image:${engine}`] = 'images/not-installed-here.img';
  }
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(catalog));
  const make = requireImages => createRunnerService({commands, root, runtimeRoot: path.join(dir, requireImages ? 'remote' : 'local'), configPath, requireImages});
  const remote = make(true);
  t.after(() => remote.shutdown());
  await remote.handle('session.create', '00000000000000a1', {owner: 'toto'});
  assert.deepEqual(await remote.handle('catalog.systems', '00000000000000a1', {}), [], 'nothing is offered');
  await assert.rejects(remote.handle('host.create', '00000000000000a1', {body: {id: 'h-00000000000000a1', imageId: system}}), /not installed on this runner/);
  const local = make(false);
  t.after(() => local.shutdown());
  await local.handle('session.create', '00000000000000a2', {owner: 'toto'});
  assert.ok((await local.handle('catalog.systems', '00000000000000a2', {})).length > 0, 'the local runner is unchanged');
});
