// Restore and adoption of a runner's sessions by the control plane after a server restart
// (SessionManager.restore, SessionManager.resync): the same rule for every runner, the local one included.
// The runner is an in-memory service (test/unit/runner-pair.js); no process is spawned.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {SessionManager, reportedSessions} = require('../../server/session-manager');
const {createSessionBindings} = require('../../server/session-bindings');
const {RunnerRegistry} = require('../../server/runner-registry');
const {runnerPair} = require('./runner-pair');

const quiet = t => { t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'log', () => {}); };
const ID = n => n.toString(16).padStart(16, '0');
const settle = async condition => {
  for (let turn = 0; turn < 400 && !condition(); turn++) await new Promise(resolve => setTimeout(resolve, 5));
};
const bind = (bindings, id, owner, runnerId = 'local', createdAt = '2026-01-02T03:04:05.000Z') => bindings.set({id, owner, runnerId, createdAt});
const runnerSessions = service => service.hello().sessions.map(item => item.sessionId).sort();
const record = () => ({});

// The server was restarted: the manager knows no session but the bindings of its bindings.json, restored
// offline; the runner of the pair is online (its hello is passed to resync by hand).
async function setup(t, {graceSeconds = 60, restoreRecord = record} = {}) {
  quiet(t);
  const pair = await runnerPair(t, {prefix: 'qw-adopt-'});
  const bindings = createSessionBindings();
  const manager = new SessionManager({registry: pair.registry, graceSeconds, bindings});
  const events = [];
  manager.on('created', (workspace, info) => events.push(['created', workspace.owner, workspace.session.id, info.adopted, info.restored]));
  manager.on('adopted', workspace => events.push(['adopted', workspace.owner]));
  manager.on('removed', (workspace, by, reason) => events.push(['removed', workspace.owner, by, reason]));
  manager.on('connectivity', (workspace, online) => events.push(['connectivity', workspace.owner, online]));
  t.after(() => { for (const id of [...manager.graceTimers.keys()]) manager.cancelGrace(id); });
  const restore = () => manager.restore(restoreRecord);
  return {...pair, manager, bindings, events, restore};
}

test('a binding is restored offline for its owner, then adopted at the hello: same handle, same session, the runner\'s machines continue', async t => {
  const {manager, bindings, service, restore, events} = await setup(t);
  await service.handle('session.create', ID(1), {owner: 'toto', createdAt: '2026-01-02T03:04:05.000Z'});
  await service.handle('switch.create', ID(1), {id: 's-00000000000000aa', name: 'sw', autostart: false});
  bind(bindings, ID(1), 'toto');
  restore();
  const workspace = manager.get('toto');
  assert.ok(workspace, 'restored at start');
  assert.deepEqual(events, [['created', 'toto', ID(1), false, true]]);
  assert.equal(workspace.session.runnerId, 'local');
  assert.equal(workspace.session.createdAt, '2026-01-02T03:04:05.000Z', 'the date of the binding');
  assert.ok(workspace.session.lastActivity, 'the last activity counts from the restore');
  assert.ok(Date.now() - Date.parse(workspace.session.lastActivity) < 5000);
  assert.equal(manager.available(workspace), false, 'offline until its runner is back');
  assert.equal(manager.open('toto'), workspace, 'the user finds his offline session, never a new one');
  await assert.rejects(workspace.runner.request('nodes.ids'), error => error.status === 503);
  workspace.runner.input('s-00000000000000aa', 'x'); // dropped, no crash
  assert.throws(() => workspace.runner.outgoing(), error => error.status === 503);
  assert.throws(() => workspace.runner.incoming('x'), error => error.status === 503);
});

test('the hello of the bound runner adopts the restored session through the real client', async t => {
  const {manager, bindings, service, client, registry, restore, events} = await setup(t);
  await service.handle('session.create', ID(1), {owner: 'toto'});
  await service.handle('switch.create', ID(1), {id: 's-00000000000000aa', name: 'sw', autostart: false});
  bind(bindings, ID(1), 'toto');
  restore();
  const workspace = manager.get('toto');
  const handle = workspace.runner;
  const onlineEntry = registry.get('local');
  assert.ok(onlineEntry, 'the pair registered its runner');
  manager.resync(onlineEntry, service.hello());
  assert.equal(manager.get('toto').runner, handle, 'the handle is the same object');
  assert.equal(handle.client, client);
  assert.equal(workspace.restored, false);
  assert.deepEqual(events.slice(1), [['adopted', 'toto'], ['connectivity', 'toto', true]]);
  assert.deepEqual(await handle.request('nodes.ids'), ['s-00000000000000aa'], 'the machines of the runner are reached again');
  assert.deepEqual(runnerSessions(service), [ID(1)], 'nothing was deleted');
  assert.equal(manager.available(workspace), true);
  assert.equal(manager.graceLeft('local'), null, 'no grace runs once the runner is back');
});

test('the owner announced in a hello is ignored: the binding decides, whatever the runner says', async t => {
  const {manager, bindings, service, registry, restore, events} = await setup(t);
  await service.handle('session.create', ID(1), {owner: 'toto'});
  bind(bindings, ID(1), 'alice');
  restore();
  manager.resync(registry.get('local'), {sessions: [{sessionId: ID(1), owner: 'mallory', createdAt: '2000-01-01T00:00:00.000Z'}]});
  assert.equal(manager.get('mallory'), null);
  assert.equal(manager.get('toto'), null);
  const workspace = manager.get('alice');
  assert.equal(workspace.session.id, ID(1));
  assert.equal(workspace.session.createdAt, '2026-01-02T03:04:05.000Z', 'the date of the binding, not the hello\'s');
  assert.deepEqual(events.filter(item => item[0] === 'adopted'), [['adopted', 'alice']]);
});

test('a lost bindings.json: every session of the hello is deleted on the runner, none is adopted', async t => {
  const {manager, service, registry, restore, events} = await setup(t);
  await service.handle('session.create', ID(5), {owner: 'toto'});
  await service.handle('session.create', ID(6), {owner: 'titi'});
  restore();
  assert.equal(manager.list().length, 0, 'nothing to restore');
  manager.resync(registry.get('local'), service.hello());
  await settle(() => runnerSessions(service).length === 0);
  assert.deepEqual(runnerSessions(service), []);
  assert.deepEqual(events, []);
});

test('a reported session bound to another runner is deleted on this one; the other binding is left alone', async t => {
  const {manager, bindings, service, registry, restore} = await setup(t);
  await service.handle('session.create', ID(6), {owner: 'toto'});
  bind(bindings, ID(6), 'toto', 'r-00000001');
  restore();
  manager.resync(registry.get('local'), service.hello());
  await settle(() => runnerSessions(service).length === 0);
  assert.deepEqual(runnerSessions(service), [], 'a hostile hello cannot keep a session bound to another runner');
  assert.ok(bindings.get(ID(6)), 'the binding of the other runner is left alone');
  assert.equal(manager.get('toto').session.runnerId, 'r-00000001', 'and so is its workspace');
});

test('one session per user: the extra session of a user who already has one is deleted', async t => {
  const {manager, service, registry, restore} = await setup(t);
  restore();
  const toto = manager.open('toto');
  await toto.runner.request('nodes.list');
  await service.handle('session.create', ID(2), {owner: 'toto'});
  manager.resync(registry.get('local'), service.hello());
  await settle(() => runnerSessions(service).length === 1);
  assert.deepEqual(runnerSessions(service), [toto.session.id]);
  assert.equal(manager.get('toto'), toto);
});

test('an invalid session ID is ignored, never adopted', async t => {
  const {manager, registry, restore, events} = await setup(t);
  restore();
  for (const sessionId of ['', 'xyz', '../../etc', ID(0xabcdef).toUpperCase(), `${ID(1)}0`, 5, null]) {
    manager.resync(registry.get('local'), {sessions: [{sessionId, owner: 'toto'}]});
  }
  assert.deepEqual(events, []);
  assert.equal(manager.list().length, 0);
});

test('a restored session the runner no longer reports is dropped at its hello (runner lost), with its binding; the others stay', async t => {
  const {manager, bindings, service, registry, restore, events} = await setup(t);
  await service.handle('session.create', ID(6), {owner: 'toto'});
  bind(bindings, ID(7), 'gone');
  bind(bindings, ID(6), 'toto');
  bind(bindings, ID(8), 'bob', 'r-00000001');
  restore();
  manager.resync(registry.get('local'), service.hello());
  assert.deepEqual(events.filter(item => item[0] === 'removed'), [['removed', 'gone', null, 'runner lost']]);
  assert.deepEqual(manager.list().map(workspace => workspace.owner).sort(), ['bob', 'toto']);
  assert.equal(bindings.get(ID(7)), null, 'a dropped session loses its binding');
  assert.ok(bindings.get(ID(6)) && bindings.get(ID(8)));
});

test('a binding whose runner record was forgotten, or that is revoked, is dropped at once with the usual reason', async t => {
  const {manager, bindings, restore, events} = await setup(t, {restoreRecord: id => (id === 'r-00000001' ? {revoked: true} : id === 'r-00000002' ? null : {})});
  bind(bindings, ID(1), 'revoked', 'r-00000001');
  bind(bindings, ID(2), 'forgotten', 'r-00000002');
  bind(bindings, ID(3), 'waiting', 'r-00000003');
  restore();
  assert.deepEqual(events.filter(item => item[0] === 'removed'), [['removed', 'revoked', null, 'runner lost'], ['removed', 'forgotten', null, 'runner lost']]);
  assert.deepEqual(manager.list().map(workspace => workspace.owner), ['waiting']);
  assert.deepEqual(bindings.list().map(binding => binding.owner), ['waiting']);
  assert.ok(manager.graceLeft('r-00000003') > 0 && manager.graceLeft('r-00000001') === null);
});

test('--runner-grace 0: nothing waits for a runner after a restart, the restored sessions are dropped at once', async t => {
  const {manager, bindings, restore, events} = await setup(t, {graceSeconds: 0});
  bind(bindings, ID(1), 'toto');
  restore();
  assert.deepEqual(events.map(item => item.slice(0, 2)), [['created', 'toto'], ['removed', 'toto']]);
  assert.equal(manager.get('toto'), null);
  assert.equal(bindings.list().length, 0);
});

test('the grace period of restored sessions counts from the start; when it ends they are dropped and the returning runner deletes them', async t => {
  const {manager, bindings, service, registry, restore, events} = await setup(t, {graceSeconds: 0.05});
  await service.handle('session.create', ID(1), {owner: 'toto'});
  bind(bindings, ID(1), 'toto');
  restore();
  assert.equal(manager.get('toto').restored, true);
  assert.ok(manager.graceLeft('local') <= 1);
  assert.match(manager.offlineMessage(manager.get('toto')), /^The runner of your session is offline; it comes back or your session is dropped after \d+ seconds?\.$/);
  await settle(() => manager.get('toto') === null);
  assert.deepEqual(events.filter(item => item[0] === 'removed'), [['removed', 'toto', null, 'runner offline too long']]);
  assert.equal(bindings.list().length, 0, 'the binding went with the session');
  assert.deepEqual(runnerSessions(service), [ID(1)], 'the server removed nothing itself');
  manager.resync(registry.get('local'), service.hello());
  await settle(() => runnerSessions(service).length === 0);
  assert.deepEqual(runnerSessions(service), [], 'the runner that returns is told to delete the dropped session');
  assert.equal(manager.get('toto'), null, 'never adopted again');
});

test('a hello before the grace period ends cancels it', async t => {
  const {manager, bindings, service, registry, restore} = await setup(t, {graceSeconds: 0.08});
  await service.handle('session.create', ID(1), {owner: 'toto'});
  bind(bindings, ID(1), 'toto');
  restore();
  registry.emit('online', registry.get('local'), service.hello());
  assert.equal(manager.graceLeft('local'), null);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(manager.get('toto'), 'still there after the time the grace would have ended');
  assert.equal(manager.get('toto').restored, false);
});

test('two server restarts in a row: the sessions come back each time, from the same bindings.json', async t => {
  quiet(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-bind-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'bindings.json');
  const start = () => {
    const manager = new SessionManager({registry: new RunnerRegistry(), graceSeconds: 60, bindings: createSessionBindings(file, {log: () => {}})});
    manager.restore(record);
    t.after(() => manager.cancelGrace('local'));
    return manager;
  };
  fs.writeFileSync(file, `${JSON.stringify({schemaVersion: 1, sessions: [{id: ID(1), owner: 'toto', runnerId: 'local', createdAt: '2026-01-02T03:04:05.000Z'}]})}\n`);
  const first = start();
  assert.equal(first.get('toto').session.id, ID(1));
  const second = start();
  assert.equal(second.get('toto').session.id, ID(1));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessions.length, 1, 'the restore wrote nothing it should not');
});

test('a corrupt bindings.json restores nothing and said so loudly; the sessions of the runners are then deleted at their hello', async t => {
  quiet(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-bind-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'bindings.json');
  fs.writeFileSync(file, '{not json');
  const lines = [];
  const manager = new SessionManager({registry: new RunnerRegistry(), graceSeconds: 60, bindings: createSessionBindings(file, {log: line => lines.push(line)})});
  manager.restore(record);
  assert.equal(manager.list().length, 0);
  assert.match(lines.join('\n'), /bindings\.json: not valid JSON.*will be deleted when the runners connect/);
});

test('the user cannot delete his session while its runner is offline: refused, the session stays', async t => {
  const {manager, bindings, restore} = await setup(t);
  bind(bindings, ID(1), 'toto');
  restore();
  await assert.rejects(manager.remove('toto'), error => error.status === 503);
  assert.ok(manager.get('toto'), 'still there');
  assert.equal(manager.get('toto').session.archiveBusy, false, 'and usable again');
  assert.ok(bindings.get(ID(1)));
});

test('a forced loss drops the restored sessions of a runner at once and stops its grace timer', async t => {
  const {manager, bindings, restore, events} = await setup(t);
  bind(bindings, ID(1), 'toto');
  bind(bindings, ID(2), 'titi');
  bind(bindings, ID(3), 'other', 'r-00000009');
  restore();
  assert.equal(manager.dropRunnerSessions('local', 'runner lost'), 2);
  assert.deepEqual(manager.list().map(workspace => workspace.owner), ['other']);
  assert.equal(manager.graceLeft('local'), null);
  assert.deepEqual(events.filter(item => item[0] === 'removed').map(item => item[3]), ['runner lost', 'runner lost']);
  assert.deepEqual(bindings.list().map(binding => binding.owner), ['other']);
  const fresh = manager.open('toto');
  assert.notEqual(fresh.session.id, ID(1), 'the user can open a new session now');
  await fresh.runner.request('nodes.list');
});

test('a paused runner keeps and adopts its restored sessions (a pause concerns placement only); they count for its load', async t => {
  const {manager, bindings, service, registry, restore} = await setup(t);
  await service.handle('session.create', ID(1), {owner: 'toto'});
  bind(bindings, ID(1), 'toto');
  restore();
  registry.get('local').paused = true;
  assert.equal(manager.sessionsOf('local'), 1);
  manager.resync(registry.get('local'), service.hello());
  assert.equal(manager.available(manager.get('toto')), true);
});

test('the server never opens a path under the runner\'s directory, whatever its hello announces', async t => {
  const {runtimeRoot, manager, bindings, service, registry, restore} = await setup(t);
  registry.get('local').runtimeRoot = '/somewhere/else/runtime';
  await service.handle('session.create', ID(7), {owner: 'toto'});
  bind(bindings, ID(7), 'toto');
  restore();
  manager.resync(registry.get('local'), service.hello());
  assert.ok(manager.get('toto'), 'still adopted');
  assert.equal(fs.readlinkSync(path.join(runtimeRoot, 'users', 'toto')), path.join('..', 'sessions', ID(7)), 'the alias is the runner\'s');
});

test('open() binds the session before the runner is asked to create it', async t => {
  const {manager, bindings, registry} = await setup(t);
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

test('after the adoption nothing is dropped when the former grace period would have ended', async t => {
  const {manager, bindings, service, registry, restore, events} = await setup(t, {graceSeconds: 0.08});
  await service.handle('session.create', ID(1), {owner: 'toto'});
  bind(bindings, ID(1), 'toto');
  restore();
  manager.resync(registry.get('local'), service.hello()); // the hello itself, without the registry event
  assert.equal(manager.graceLeft('local'), null, 'the timer is cancelled by the reconciliation');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.ok(manager.get('toto'), 'the session of a runner that is back is still there');
  assert.deepEqual(events.filter(item => item[0] === 'removed'), []);
  assert.deepEqual(runnerSessions(service), [ID(1)]);
});

test('a runner that connects and drops before its hello does not restart the grace period: it runs from the restore', async t => {
  quiet(t);
  const registry = new RunnerRegistry();
  const bindings = createSessionBindings();
  const manager = new SessionManager({registry, graceSeconds: 0.2, bindings});
  t.after(() => manager.cancelGrace('local'));
  bind(bindings, ID(1), 'toto');
  manager.restore(record);
  const removed = [];
  manager.on('removed', (_workspace, _by, reason) => removed.push(reason));
  const end = manager.graceEnds.get('local');
  await new Promise(resolve => setTimeout(resolve, 80));
  const client = Object.assign(new (require('node:events').EventEmitter)(), {close() {}});
  registry.add({id: 'local', client});
  client.emit('close', null); // lost before any hello
  assert.equal(manager.graceEnds.get('local'), end, 'the deadline is the original one');
  await settle(() => removed.length === 1);
  assert.deepEqual(removed, ['runner offline too long']);
});
