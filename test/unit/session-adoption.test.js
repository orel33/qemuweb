// Adoption of a runner's sessions by the control plane after a server restart (SessionManager.resync).
// The runner is an in-memory service (test/unit/runner-pair.js); no process is spawned.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {SessionManager, reportedSessions} = require('../../server/session-manager');
const {runnerPair} = require('./runner-pair');

async function setup(t) {
  const pair = await runnerPair(t, {prefix: 'qw-adopt-'});
  // The server was restarted: this manager knows no session.
  const manager = new SessionManager({registry: pair.registry});
  const created = [];
  manager.on('created', (workspace, info) => created.push([workspace.owner, workspace.session.id, info.adopted]));
  return {...pair, manager, created};
}

const ID = n => n.toString(16).padStart(16, '0');
const settle = async condition => {
  for (let turn = 0; turn < 200 && !condition(); turn++) await new Promise(resolve => setImmediate(resolve));
};
const runnerSessions = service => service.hello().sessions.map(item => item.sessionId).sort();

test('a trusted runner\'s unknown session with a valid owner is adopted, with its date, handle and alias', async t => {
  const {runtimeRoot, manager, service, entry, created} = await setup(t);
  await service.handle('session.create', ID(1), {owner: 'toto', createdAt: '2026-01-02T03:04:05.000Z'});
  await service.handle('switch.create', ID(1), {id: 's-00000000000000aa', name: 'sw', autostart: false});
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
  assert.equal(fs.realpathSync(path.join(runtimeRoot, 'users', 'toto')), fs.realpathSync(path.join(runtimeRoot, 'sessions', workspace.session.id)));
  assert.deepEqual(runnerSessions(service), [ID(1)], 'nothing was deleted');
});

test('an owner that already has a workspace never gets a second session: the extra one is deleted', async t => {
  const {manager, service, entry, created} = await setup(t);
  const toto = manager.open('toto');
  await toto.runner.request('nodes.list');
  await service.handle('session.create', ID(2), {owner: 'toto'});
  manager.resync(entry, service.hello());
  await settle(() => runnerSessions(service).length === 1);
  assert.deepEqual(runnerSessions(service), [toto.session.id]);
  assert.equal(manager.get('toto'), toto);
  assert.deepEqual(created.map(item => item[2]), [false]);
});

test('two sessions of one owner: the first is adopted, the second deleted', async t => {
  const {manager, service, entry, created} = await setup(t);
  await service.handle('session.create', ID(3), {owner: 'toto'});
  await service.handle('session.create', ID(4), {owner: 'toto'});
  manager.resync(entry, service.hello());
  await settle(() => runnerSessions(service).length === 1);
  assert.equal(created.length, 1);
  assert.deepEqual(runnerSessions(service), [created[0][1]]);
  assert.equal(manager.get('toto').session.id, created[0][1]);
});

test('an invalid or missing owner is never adopted: the session is deleted', async t => {
  const {manager, service, entry, created} = await setup(t);
  const owners = [undefined, null, '', '../x', 'a b', 'x'.repeat(65), 12, ['toto'], {login: 'toto'}];
  const sessions = [];
  for (const [index, owner] of owners.entries()) {
    await service.handle('session.create', ID(10 + index), {});
    sessions.push({sessionId: ID(10 + index), owner});
  }
  // A hello that lies about the owners (the runner would announce null or a plain string).
  manager.resync(entry, {sessions});
  await settle(() => runnerSessions(service).length === 0);
  assert.deepEqual(runnerSessions(service), [], 'every one was deleted on the runner');
  assert.equal(created.length, 0);
  assert.equal(manager.list().length, 0);
});

test('an invalid session ID is ignored, never adopted', async t => {
  const {manager, entry, created} = await setup(t);
  for (const sessionId of ['', 'xyz', '../../etc', ID(0xabcdef).toUpperCase(), `${ID(1)}0`, 5, null]) {
    manager.resync(entry, {sessions: [{sessionId, owner: 'toto'}]});
  }
  assert.equal(created.length, 0);
  assert.equal(manager.list().length, 0);
});

test('an untrusted runner\'s sessions are deleted, never adopted', async t => {
  const {manager, service, entry, created} = await setup(t);
  entry.trusted = false;
  await service.handle('session.create', ID(5), {owner: 'toto'});
  manager.resync(entry, service.hello());
  await settle(() => runnerSessions(service).length === 0);
  assert.deepEqual(runnerSessions(service), []);
  assert.equal(created.length, 0);
  assert.equal(manager.get('toto'), null);
});

test('a session bound to the runner that it no longer reports is dropped, an adopted one stays bound', async t => {
  const {manager, service, entry} = await setup(t);
  const gone = manager.open('gone');
  await gone.runner.request('nodes.list');
  await service.handle('session.create', ID(6), {owner: 'toto'});
  const removed = [];
  manager.on('removed', (workspace, by, reason) => removed.push([workspace.owner, by, reason]));
  manager.resync(entry, {sessions: service.hello().sessions.filter(item => item.sessionId === ID(6))});
  assert.deepEqual(removed, [['gone', null, 'runner lost']]);
  assert.deepEqual(manager.list().map(workspace => workspace.owner), ['toto']);
});

test('the server never opens a path under the runner\'s directory, whatever its hello announces', async t => {
  const {runtimeRoot, manager, service, entry} = await setup(t);
  entry.runtimeRoot = '/somewhere/else/runtime';
  await service.handle('session.create', ID(7), {owner: 'toto'});
  manager.resync(entry, service.hello());
  assert.ok(manager.get('toto'), 'still adopted');
  assert.equal(fs.readlinkSync(path.join(runtimeRoot, 'users', 'toto')), path.join('..', 'sessions', ID(7)), 'the alias is the runner\'s');
});

test('reportedSessions checks every field of the hello', () => {
  const reported = reportedSessions({sessions: [
    {sessionId: ID(1), owner: 'toto', createdAt: '2026-01-02T03:04:05.000Z'},
    {sessionId: ID(1), owner: 'dup'},
    {sessionId: ID(2), owner: 'x'.repeat(65), createdAt: 'not a date'},
    {sessionId: 'bad', owner: 'toto'},
    null, 'text', {}
  ]});
  assert.deepEqual([...reported.keys()], [ID(1), ID(2)]);
  assert.equal(reported.get(ID(1)).owner, 'toto');
  assert.equal(reported.get(ID(2)).owner, null);
  assert.ok(Number.isFinite(Date.parse(reported.get(ID(2)).createdAt)), 'a bad date becomes the adoption time');
  assert.equal(reportedSessions({}).size, 0);
  assert.equal(reportedSessions(null).size, 0);
  assert.equal(reportedSessions({sessions: 'x'}).size, 0);
});
