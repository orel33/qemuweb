// Adoption of a runner's sessions by the control plane after a server restart (SessionManager.resync).
// The runner is an in-memory service (test/unit/runner-pair.js); no process is spawned.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {SessionManager, reportedSessions} = require('../../server/session-manager');
const {createSessionBindings} = require('../../server/session-bindings');
const {runnerPair} = require('./runner-pair');

async function setup(t) {
  const pair = await runnerPair(t, {prefix: 'qw-adopt-'});
  // The server was restarted: this manager knows no session, only the bindings of its bindings.json.
  const bindings = createSessionBindings();
  const manager = new SessionManager({registry: pair.registry, bindings});
  const created = [];
  manager.on('created', (workspace, info) => created.push([workspace.owner, workspace.session.id, info.adopted]));
  return {...pair, manager, bindings, created};
}

const ID = n => n.toString(16).padStart(16, '0');
const settle = async condition => {
  for (let turn = 0; turn < 200 && !condition(); turn++) await new Promise(resolve => setImmediate(resolve));
};
const bind = (bindings, id, owner, runnerId = 'local', createdAt = '2026-01-02T03:04:05.000Z') => bindings.set({id, owner, runnerId, createdAt});
const runnerSessions = service => service.hello().sessions.map(item => item.sessionId).sort();

test('an unknown session with a binding to this runner is adopted for the binding\'s owner, with its date and handle', async t => {
  const {runtimeRoot, manager, bindings, service, entry, created} = await setup(t);
  await service.handle('session.create', ID(1), {owner: 'toto', createdAt: '2026-01-02T03:04:05.000Z'});
  await service.handle('switch.create', ID(1), {id: 's-00000000000000aa', name: 'sw', autostart: false});
  bind(bindings, ID(1), 'toto');
  manager.resync(entry, service.hello());
  const workspace = manager.get('toto');
  assert.ok(workspace);
  assert.deepEqual(created, [['toto', ID(1), true]]);
  assert.equal(workspace.session.id, ID(1));
  assert.equal(workspace.session.runnerId, 'local');
  assert.equal(workspace.session.createdAt, '2026-01-02T03:04:05.000Z');
  assert.equal(workspace.session.lastActivity, null);
  assert.deepEqual(await workspace.runner.request('nodes.ids'), ['s-00000000000000aa'], 'the handle reaches the runner session');
  assert.equal(manager.open('toto'), workspace, 'the user gets the adopted session, not a new one');
  assert.equal(fs.realpathSync(path.join(runtimeRoot, 'users', 'toto')), fs.realpathSync(path.join(runtimeRoot, 'sessions', workspace.session.id)), 'the alias is the runner\'s');
  assert.deepEqual(runnerSessions(service), [ID(1)], 'nothing was deleted');
});

test('the owner announced in a hello is ignored: the binding decides, whatever the runner says', async t => {
  const {manager, bindings, service, entry, created} = await setup(t);
  await service.handle('session.create', ID(1), {owner: 'toto'});
  bind(bindings, ID(1), 'alice');
  // The runner (or whoever speaks for it) names another owner and another date.
  manager.resync(entry, {sessions: [{sessionId: ID(1), owner: 'mallory', createdAt: '2000-01-01T00:00:00.000Z'}]});
  assert.equal(manager.get('mallory'), null);
  assert.equal(manager.get('toto'), null);
  const workspace = manager.get('alice');
  assert.equal(workspace.session.id, ID(1));
  assert.equal(workspace.session.createdAt, '2026-01-02T03:04:05.000Z', 'the date of the binding, not the hello\'s');
  assert.deepEqual(created, [['alice', ID(1), true]]);
});

test('a hello session with no binding is deleted, whatever owner it names (a lost bindings.json deletes them)', async t => {
  const {manager, service, entry, created} = await setup(t);
  await service.handle('session.create', ID(5), {owner: 'toto'});
  manager.resync(entry, service.hello());
  await settle(() => runnerSessions(service).length === 0);
  assert.deepEqual(runnerSessions(service), []);
  assert.equal(created.length, 0);
  assert.equal(manager.get('toto'), null);
});

test('a binding to another runner never adopts the session; a hostile hello cannot claim a bound session of another runner', async t => {
  const {manager, bindings, service, entry, created} = await setup(t);
  await service.handle('session.create', ID(6), {owner: 'toto'});
  bind(bindings, ID(6), 'toto', 'r-00000001');
  manager.resync(entry, service.hello());
  await settle(() => runnerSessions(service).length === 0);
  assert.deepEqual(runnerSessions(service), []);
  assert.equal(created.length, 0);
  assert.ok(bindings.get(ID(6)), 'the binding of the other runner is left alone');
});

test('an owner that already has a workspace never gets a second session: the extra one is deleted', async t => {
  const {manager, bindings, service, entry, created} = await setup(t);
  const toto = manager.open('toto');
  await toto.runner.request('nodes.list');
  await service.handle('session.create', ID(2), {owner: 'toto'});
  bind(bindings, ID(2), 'toto');
  manager.resync(entry, service.hello());
  await settle(() => runnerSessions(service).length === 1);
  assert.deepEqual(runnerSessions(service), [toto.session.id]);
  assert.equal(manager.get('toto'), toto);
  assert.deepEqual(created.map(item => item[2]), [false]);
  assert.equal(bindings.get(ID(2)), null, 'the binding of the deleted session is dropped');
  assert.ok(bindings.get(toto.session.id), 'the live workspace keeps its binding');
});

test('two reported sessions bound to one owner: the first is adopted, the other deleted', async t => {
  const {manager, bindings, service, entry, created} = await setup(t);
  await service.handle('session.create', ID(3), {owner: 'toto'});
  await service.handle('session.create', ID(4), {owner: 'toto'});
  bind(bindings, ID(3), 'toto');
  bind(bindings, ID(4), 'toto');
  manager.resync(entry, service.hello());
  await settle(() => runnerSessions(service).length === 1);
  assert.equal(created.length, 1);
  assert.deepEqual(runnerSessions(service), [created[0][1]]);
  assert.equal(manager.get('toto').session.id, created[0][1]);
});

test('an invalid session ID is ignored, never adopted', async t => {
  const {manager, entry, created} = await setup(t);
  for (const sessionId of ['', 'xyz', '../../etc', ID(0xabcdef).toUpperCase(), `${ID(1)}0`, 5, null]) {
    manager.resync(entry, {sessions: [{sessionId, owner: 'toto'}]});
  }
  assert.equal(created.length, 0);
  assert.equal(manager.list().length, 0);
});

test('a session bound to the runner that it no longer reports is dropped, an adopted one stays bound', async t => {
  const {manager, bindings, service, entry} = await setup(t);
  const gone = manager.open('gone');
  await gone.runner.request('nodes.list');
  await service.handle('session.create', ID(6), {owner: 'toto'});
  bind(bindings, ID(6), 'toto');
  const removed = [];
  manager.on('removed', (workspace, by, reason) => removed.push([workspace.owner, by, reason]));
  manager.resync(entry, {sessions: service.hello().sessions.filter(item => item.sessionId === ID(6))});
  assert.deepEqual(removed, [['gone', null, 'runner lost']]);
  assert.deepEqual(manager.list().map(workspace => workspace.owner), ['toto']);
  assert.equal(bindings.get(gone.session.id), null, 'a dropped session loses its binding');
  assert.ok(bindings.get(ID(6)));
});

test('a stale binding of this runner (not reported) is dropped at its hello; those of other runners stay', async t => {
  const {manager, bindings, entry} = await setup(t);
  bind(bindings, ID(7), 'toto');
  bind(bindings, ID(8), 'bob', 'r-00000001');
  manager.resync(entry, {sessions: []});
  assert.equal(bindings.get(ID(7)), null);
  assert.ok(bindings.get(ID(8)));
});

test('open() binds the session before the runner is asked to create it', async t => {
  const {manager, bindings} = await setup(t);
  const seen = [];
  const original = bindings.set.bind(bindings);
  bindings.set = binding => { seen.push(['bind', binding.owner, binding.runnerId]); original(binding); };
  const workspace = manager.open('toto');
  assert.deepEqual(seen, [['bind', 'toto', 'local']]);
  assert.equal(bindings.get(workspace.session.id).owner, 'toto');
  await workspace.runner.request('nodes.list');
  await manager.remove('toto');
  assert.equal(bindings.get(workspace.session.id), null, 'deleted: unbound');
});

test('the server never opens a path under the runner\'s directory, whatever its hello announces', async t => {
  const {runtimeRoot, manager, bindings, service, entry} = await setup(t);
  entry.runtimeRoot = '/somewhere/else/runtime';
  await service.handle('session.create', ID(7), {owner: 'toto'});
  bind(bindings, ID(7), 'toto');
  manager.resync(entry, service.hello());
  assert.ok(manager.get('toto'), 'still adopted');
  assert.equal(fs.readlinkSync(path.join(runtimeRoot, 'users', 'toto')), path.join('..', 'sessions', ID(7)), 'the alias is the runner\'s');
});

test('reportedSessions keeps the valid session IDs of a hello and nothing else', () => {
  const reported = reportedSessions({sessions: [
    {sessionId: ID(1), owner: 'toto', createdAt: '2026-01-02T03:04:05.000Z'},
    {sessionId: ID(1), owner: 'dup'},
    {sessionId: ID(2), owner: 'x'.repeat(65), createdAt: 'not a date'},
    {sessionId: 'bad', owner: 'toto'},
    null, 'text', {}
  ]});
  assert.deepEqual([...reported], [ID(1), ID(2)]);
  assert.equal(reportedSessions({}).size, 0);
  assert.equal(reportedSessions(null).size, 0);
  assert.equal(reportedSessions({sessions: 'x'}).size, 0);
});
