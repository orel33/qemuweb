// Control plane unit tests: one implicit session per user (SessionManager), placed lazily on a runner reached through
// the protocol (an in-memory stream pair, test/unit/runner-pair.js), the server's pid record,
// and the session owner in meta.json (never in session.json or archives). No server is started
// and no emulator process is spawned.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {once} = require('node:events');
const {createSessionRunner} = require('../../runner/session-runner');
const {Session} = require('../../runner/session');
const {SessionManager} = require('../../server/session-manager');
const {ServerInstance} = require('../../server/server-instance');
const {createSessionSnapshot} = require('../../runner/archive-snapshot');
const {runnerPair, root, commands} = require('./runner-pair');

async function setup(t) {
  const pair = await runnerPair(t, {prefix: 'qw-manager-'});
  const manager = new SessionManager({registry: pair.registry});
  return {...pair, manager};
}

// Where the runner of the pair keeps a session (the server does not know: only these tests do).
const sessionDir = (runtimeRoot, session) => path.join(runtimeRoot, 'sessions', session.id);

// Opens a session and places it on the runner (as its first node would).
async function opened(manager, login) {
  const workspace = manager.open(login);
  await manager.place(workspace);
  return workspace;
}


test('each user gets one persistent session with a random ID, an owner and an alias', async t => {
  const {runtimeRoot, manager} = await setup(t);
  const created = [];
  manager.on('created', workspace => created.push(workspace.owner));
  const toto = await opened(manager, 'toto');
  assert.equal(manager.open('toto'), toto, 'the same workspace is returned on every request');
  const titi = await opened(manager, 'titi');
  assert.deepEqual(created, ['toto', 'titi']);
  assert.notEqual(toto.session.id, titi.session.id);
  assert.notEqual(toto.runner, titi.runner);
  assert.notEqual(toto.runner.events, titi.runner.events);
  for (const {session} of [toto, titi]) {
    assert.match(session.id, /^[0-9a-f]{8}$/);
    assert.equal(session.runnerId, 'local');
    assert.equal(session.runtimeDir, undefined, 'the server holds no path of the runner');
  }
  // session.json is the definition only; what belongs to the live session is in meta.json.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sessionDir(runtimeRoot, toto.session), 'session.json'), 'utf8')),
    {schemaVersion: 1, engine: 'qemu', hosts: [], switches: []});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sessionDir(runtimeRoot, toto.session), 'meta.json'), 'utf8')),
    {schemaVersion: 1, owner: 'toto', createdAt: toto.session.createdAt});
  assert.equal(new Date(toto.session.createdAt).toISOString(), toto.session.createdAt);
  // The alias is made by the runner at session.create (runner/runtime-tidy.js).
  const alias = path.join(runtimeRoot, 'users', 'toto');
  assert.equal(fs.readlinkSync(alias), path.join('..', 'sessions', toto.session.id));
  assert.equal(fs.realpathSync(alias), fs.realpathSync(sessionDir(runtimeRoot, toto.session)));
  assert.deepEqual(manager.sessionIds().sort(), [toto.session.id, titi.session.id].sort());
  assert.throws(() => manager.open(''), /login is required/);
});

test('sessions are independent: nodes and events stay in their session', async t => {
  const {manager} = await setup(t);
  const toto = await opened(manager, 'toto');
  const titi = await opened(manager, 'titi');
  const events = {toto: [], titi: []};
  toto.runner.events.on('nodes-changed', event => events.toto.push(event.nodeId));
  titi.runner.events.on('nodes-changed', event => events.titi.push(event.nodeId));
  // Archives keep node IDs, so two sessions can hold the same ID.
  const id = 's-000000aa';
  await toto.runner.request('switch.create', {id, name: 'sw1', autostart: false});
  await titi.runner.request('switch.create', {id, name: 'sw1', autostart: false});
  assert.deepEqual((await toto.runner.request('nodes.ids')), [id]);
  await titi.runner.request('node.delete', {nodeId: id});
  assert.deepEqual((await titi.runner.request('nodes.ids')), []);
  assert.deepEqual((await toto.runner.request('nodes.ids')), [id]);
  assert.deepEqual(events, {toto: [id], titi: [id]});
  await assert.rejects(titi.runner.request('node.stop', {nodeId: id}), error => error.status === 404 && /Unknown host or switch/.test(error.message));
});

test('deleting a session stops it, removes its files and alias, and the next open starts afresh', async t => {
  const {runtimeRoot, manager} = await setup(t);
  const toto = await opened(manager, 'toto');
  await toto.runner.request('switch.create', {id: 's-000000bb', name: 'sw', autostart: false});
  const removed = [];
  manager.on('removed', (workspace, by, reason) => removed.push([workspace.session.id, by, reason]));
  assert.equal(await manager.remove('toto', 'boss'), true);
  assert.deepEqual(removed, [[toto.session.id, 'boss', null]]);
  assert.equal(fs.existsSync(sessionDir(runtimeRoot, toto.session)), false, 'the runner removed the directory at session.delete');
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'users', 'toto')), false, 'and the alias');
  assert.equal(manager.get('toto'), null);
  assert.equal(await manager.remove('toto', 'boss'), false);
  const again = await opened(manager, 'toto');
  assert.notEqual(again.session.id, toto.session.id);
  again.session.archiveBusy = true;
  await assert.rejects(manager.remove('toto', 'boss'), /archive operation/);
  again.session.archiveBusy = false;
});

test('a lost runner drops its sessions like deleted ones; a session opens without a runner but is not placed', async t => {
  const {runtimeRoot, manager, client} = await setup(t);
  const toto = await opened(manager, 'toto');
  const removed = [];
  manager.on('removed', (workspace, by, reason) => removed.push([workspace.owner, by, reason]));
  const lost = once(manager.registry, 'lost');
  client.close();
  await lost;
  assert.deepEqual(removed, [['toto', null, 'runner lost']]);
  assert.equal(manager.get('toto'), null);
  assert.equal(fs.existsSync(sessionDir(runtimeRoot, toto.session)), true, 'the server never removes a runner directory');
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'users', 'toto')), true, 'nor an alias: both belong to the runner');
  await assert.rejects(toto.runner.request('nodes.list'), error => error.status === 503);
  const again = manager.open('toto');
  assert.notEqual(again.session.id, toto.session.id);
  assert.equal(again.session.runnerId, null);
  assert.deepEqual(await again.runner.request('nodes.list'), [], 'an unplaced session reads as empty, without any runner');
  assert.deepEqual(await again.runner.request('catalog.systems'), [], 'no runner: no system, and no error at login');
  await assert.rejects(manager.place(again), error => error.status === 503 && /No runner is available/.test(error.message));
  assert.equal(again.session.runnerId, null, 'a failed placement leaves the session unplaced');
});

test('UXS02: a session is implicit and unplaced until it is placed; reads answer empty, catalog reads go to the candidate runner', async t => {
  const {runtimeRoot, manager, service} = await setup(t);
  const placed = [];
  manager.on('placed', workspace => placed.push(workspace.owner));
  const toto = manager.open('toto');
  assert.equal(toto.session.runnerId, null);
  assert.equal(manager.available(toto), true, 'no runner needed');
  assert.deepEqual(service.hello().sessions, [], 'the runner holds nothing');
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'sessions')), false);
  assert.deepEqual(manager.bindings.list(), [], 'an unplaced session is not bound');
  assert.equal(manager.sessionsOf('local'), 0);
  assert.deepEqual(await toto.runner.request('nodes.list'), []);
  assert.deepEqual(await toto.runner.request('nodes.ids'), []);
  assert.deepEqual(await toto.runner.request('layout.get'), {positions: {}});
  assert.deepEqual((await toto.runner.request('captures.list')).captures, []);
  assert.equal((await toto.runner.request('session.summary')).nodes, 0);
  const settings = await toto.runner.request('session.settings');
  assert.equal(settings.sessionId, toto.session.id);
  assert.equal(settings.engine, 'qemu');
  assert.deepEqual(settings.availableEngines, ['qemu']);
  assert.ok(Array.isArray(await toto.runner.request('catalog.systems')), 'the systems of the runner the session would go to');
  await assert.rejects(toto.runner.request('node.start', {nodeId: 's-000000aa'}), error => error.status === 404);
  await assert.rejects(toto.runner.request('session.setEngine', {body: {engine: 'vbox'}}), /VirtualBox is unavailable/);
  await assert.rejects(toto.runner.request('session.setEngine', {body: {engine: 'other'}}), /Invalid session engine/);
  assert.deepEqual(service.hello().sessions, [], 'still nothing on the runner');
  await Promise.all([manager.place(toto), manager.place(toto)]);
  assert.deepEqual(placed, ['toto'], 'concurrent placements share one');
  assert.equal(toto.session.runnerId, 'local');
  assert.deepEqual(service.hello().sessions.map(item => item.sessionId), [toto.session.id]);
  assert.deepEqual(manager.bindings.list().map(binding => binding.id), [toto.session.id]);
  assert.equal(fs.existsSync(sessionDir(runtimeRoot, toto.session)), true);
});

test('UXS02: an empty session is released (unplaced, deleted on the runner, same ID), a session with nodes is not', async t => {
  const {runtimeRoot, manager, service} = await setup(t);
  const toto = await opened(manager, 'toto');
  const id = toto.session.id;
  await toto.runner.request('switch.create', {id: 's-000000a1', name: 'sw1', autostart: false});
  await manager.release(toto);
  assert.equal(toto.session.runnerId, 'local', 'a session with a node stays placed');
  await toto.runner.request('node.delete', {nodeId: 's-000000a1'});
  await manager.release(toto);
  assert.equal(toto.session.runnerId, null);
  assert.equal(toto.session.id, id, 'the session stays the same');
  assert.equal(manager.get('toto'), toto);
  assert.deepEqual(service.hello().sessions, []);
  assert.equal(fs.existsSync(sessionDir(runtimeRoot, toto.session)), false, 'the runner deleted its directory');
  assert.deepEqual(manager.bindings.list(), []);
  await manager.place(toto);
  assert.equal(toto.session.runnerId, 'local', 'placed again by its next node');
  assert.deepEqual(await toto.runner.request('nodes.ids'), []);
});

test('UXS02: a creation in flight blocks the release, a release in flight delays the placement', async t => {
  const {manager, service} = await setup(t);
  const toto = await opened(manager, 'toto');
  await toto.runner.request('switch.create', {id: 's-000000b1', name: 'sw1', autostart: false});
  // The last node is removed while another request creates one (another tab).
  const end = manager.beginCreation(toto);
  await toto.runner.request('node.delete', {nodeId: 's-000000b1'});
  await manager.release(toto);
  assert.equal(toto.session.runnerId, 'local', 'no release while a creation runs');
  await manager.place(toto);
  await toto.runner.request('switch.create', {id: 's-000000b2', name: 'sw2', autostart: false});
  end();
  end();
  assert.equal(toto.creations, 0, 'end() is idempotent');
  assert.deepEqual(await toto.runner.request('nodes.ids'), ['s-000000b2'], 'the node exists afterwards');
  await toto.runner.request('node.delete', {nodeId: 's-000000b2'});
  // A release already running: the placement waits for it, then places again.
  const releasing = manager.release(toto);
  const end2 = manager.beginCreation(toto);
  await manager.place(toto);
  await releasing;
  assert.equal(toto.session.runnerId, 'local');
  await toto.runner.request('switch.create', {id: 's-000000b3', name: 'sw3', autostart: false});
  end2();
  assert.deepEqual(await toto.runner.request('nodes.ids'), ['s-000000b3']);
  assert.deepEqual(service.hello().sessions.map(item => item.sessionId), [toto.session.id]);
});

test('UXS02: Reset removes every node, keeps the session unplaced with its engine, and works on an unplaced session', async t => {
  const {runtimeRoot, manager, service} = await setup(t);
  const toto = await opened(manager, 'toto');
  await toto.runner.request('switch.create', {id: 's-000000c1', name: 'sw1', autostart: false});
  const resets = [];
  const changed = [];
  manager.on('reset', (workspace, by) => resets.push([workspace.owner, by]));
  toto.runner.events.on('nodes-changed', event => changed.push(event.nodeId));
  assert.deepEqual(await manager.reset(toto, 'boss'), {reset: true});
  assert.deepEqual(resets, [['toto', 'boss']]);
  assert.deepEqual(changed, [null], 'the pages refresh');
  assert.equal(toto.session.runnerId, null);
  assert.equal(toto.session.engine, 'qemu', 'the engine is kept for the next placement');
  assert.equal(manager.get('toto'), toto);
  assert.equal(fs.existsSync(sessionDir(runtimeRoot, toto.session)), false);
  assert.deepEqual(service.hello().sessions, []);
  assert.deepEqual(await manager.reset(toto), {reset: true}, 'an unplaced session resets too');
  toto.session.archiveBusy = true;
  await assert.rejects(manager.reset(toto), /archive operation/);
  toto.session.archiveBusy = false;
});

test('UXS02: a restored session that its runner reports without any node is released', async t => {
  const {manager, service, entry} = await setup(t);
  const toto = await opened(manager, 'toto');
  // The handle as a restored session has it: behind a placeholder client, until the hello adopts it.
  const {createOfflineClient} = require('../../server/offline-runner');
  createOfflineClient().adopt(toto.runner);
  toto.restored = true;
  manager.resync(entry, service.hello());
  assert.ok(toto.releasing, 'the release started');
  await toto.releasing;
  assert.equal(toto.session.runnerId, null);
  assert.deepEqual(service.hello().sessions, []);
});

test('a runner hello resynchronises: unknown sessions are deleted, missing ones dropped', async t => {
  const {manager, service, entry} = await setup(t);
  const toto = await opened(manager, 'toto');
  await service.handle('session.create', '000000cc', {owner: 'ghost'});
  const removed = [];
  manager.on('removed', (workspace, by, reason) => removed.push([workspace.owner, reason]));
  manager.resync(entry, {sessions: [{sessionId: '000000cc'}]});
  assert.deepEqual(removed, [['toto', 'runner lost']]);
  for (let turn = 0; turn < 100 && service.hello().sessions.length > 1; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(service.hello().sessions.map(item => item.sessionId), [toto.session.id]);
});

test('the owner is not part of the session definition: an archive that carries one is refused, an import leaves meta.json alone', t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-owner-'));
  t.after(() => fs.rmSync(runtimeRoot, {recursive: true, force: true}));
  const session = new Session({runtimeRoot, id: '000000dd', owner: 'titi'});
  fs.mkdirSync(session.runtimeDir, {recursive: true});
  session.saveMetadata();
  session.saveMeta();
  assert.equal(session.metadata().owner, undefined);
  assert.equal(JSON.parse(fs.readFileSync(session.metadataFile, 'utf8')).owner, undefined);
  assert.equal(JSON.parse(fs.readFileSync(session.metaFile, 'utf8')).owner, 'titi');
  const runner = createSessionRunner({session, commands, root, runtimeRoot, configPath: path.join(root, 'config.json')});
  const emitted = [];
  const snapshot = createSessionSnapshot({session, runner, commands, emit: (event, payload) => emitted.push(event)});
  const stage = fs.mkdtempSync(path.join(runtimeRoot, 'stage-'));
  fs.writeFileSync(path.join(stage, 'session.json'), JSON.stringify({schemaVersion: 1, engine: 'qemu', hosts: [], switches: []}));
  const files = snapshot.archivedSessionFiles(stage, ['session.json']);
  snapshot.installArchive(files, stage);
  assert.deepEqual(JSON.parse(fs.readFileSync(session.metadataFile, 'utf8')), {schemaVersion: 1, engine: 'qemu', hosts: [], switches: []});
  assert.equal(JSON.parse(fs.readFileSync(session.metaFile, 'utf8')).owner, 'titi');
  assert.deepEqual(emitted, ['general-settings-changed', 'nodes-changed', 'graphic-layout']);
  for (const extra of [{owner: 'toto'}, {baseImages: {}}, {intruder: 1}]) {
    fs.writeFileSync(path.join(stage, 'session.json'), JSON.stringify({schemaVersion: 1, engine: 'qemu', hosts: [], switches: [], ...extra}));
    assert.throws(() => snapshot.archivedSessionFiles(stage, ['session.json']), /Invalid session.json/, `refused: ${Object.keys(extra)}`);
  }
});

test('the server keeps only its pid record in its runtime directory', t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-instance-'));
  t.after(() => fs.rmSync(runtimeRoot, {recursive: true, force: true}));
  const instance = new ServerInstance({runtimeRoot, port: 4001});
  instance.writeRecords();
  assert.deepEqual(fs.readdirSync(runtimeRoot), ['server-4001.pid']);
  assert.equal(fs.readFileSync(instance.pidFile, 'utf8').trim(), String(process.pid));
  fs.writeFileSync(instance.pidFile, '1\n');
  instance.removeRecords();
  assert.equal(fs.existsSync(instance.pidFile), true, 'the record of a newer server is left alone');
  fs.writeFileSync(instance.pidFile, `${process.pid}\n`);
  instance.removeRecords();
  assert.deepEqual(fs.readdirSync(runtimeRoot), []);
});

test('the session manager and the session do not use the file system (the runner owns its files)', () => {
  for (const file of ['session-manager.js', 'session.js']) {
    const source = fs.readFileSync(path.join(root, 'server', file), 'utf8');
    assert.doesNotMatch(source, /require\('(node:)?fs'\)|\bfs\./, file);
    assert.doesNotMatch(source, /runtimeDir|usersDir|rmSync|symlink/, file);
  }
});

test('IDS01: a new session ID is never one the server knows (a workspace or a binding)', async t => {
  const {manager} = await setup(t);
  const crypto = require('node:crypto');
  const toto = manager.open('toto');
  assert.match(toto.session.id, /^[0-9a-f]{8}$/);
  manager.bindings.set({id: '0000000b', owner: 'gone', runnerId: 'local', createdAt: new Date().toISOString()});
  const original = crypto.randomBytes;
  const draws = [toto.session.id, '0000000b', '0000000c'].map(hex => Buffer.from(hex, 'hex'));
  crypto.randomBytes = () => draws.shift();
  let titi;
  try { titi = manager.open('titi'); }
  finally { crypto.randomBytes = original; }
  assert.equal(titi.session.id, '0000000c', 'the IDs of a workspace and of a binding are drawn again');
  assert.equal(draws.length, 0);
});

test('IDS01: a session ID the runner already has (a stale directory) drops the unplaced session and asks to retry', async t => {
  const {runtimeRoot, manager, service} = await setup(t);
  const removed = [];
  manager.on('removed', (workspace, by, reason) => removed.push([workspace.owner, by, reason]));
  const toto = manager.open('toto');
  const stale = sessionDir(runtimeRoot, toto.session);
  fs.mkdirSync(path.join(stale, 'h-0000000a'), {recursive: true});
  await assert.rejects(manager.place(toto), error => error.status === 409 && /Please retry/.test(error.message));
  assert.deepEqual(removed, [['toto', null, 'session ID already used on the runner']], 'its pages reload into a new session');
  assert.equal(manager.get('toto'), null);
  assert.deepEqual(manager.bindings.list(), [], 'no binding left');
  assert.deepEqual(service.hello().sessions, [], 'the runner created nothing');
  assert.ok(fs.existsSync(path.join(stale, 'h-0000000a')), 'nor touched the stale directory');
  const again = await opened(manager, 'toto');
  assert.notEqual(again.session.id, toto.session.id, 'the next request gets a new ID, which is placed');
  assert.equal(again.session.runnerId, 'local');
});

test('IDS01: the runner refuses a host or switch ID its session already has, with a 409 the browser retries on', async t => {
  const {manager} = await setup(t);
  const toto = await opened(manager, 'toto');
  await toto.runner.request('switch.create', {id: 's-0000000a', name: 'sw1', autostart: false});
  await assert.rejects(toto.runner.request('switch.create', {id: 's-0000000a', name: 'sw2', autostart: false}),
    error => error.status === 409 && /Switch ID already exists/.test(error.message));
  await assert.rejects(toto.runner.request('switch.create', {id: 's-0000000b', name: 'sw1', autostart: false}),
    error => error.status === 400 && /Switch name already exists/.test(error.message), 'a duplicate name is not a 409');
  await assert.rejects(toto.runner.request('switch.create', {id: 's-0123456789abcdef', name: 'sw3', autostart: false}),
    /8 lowercase hex characters/, 'the 16-character IDs of earlier versions are invalid');
  assert.equal((await toto.runner.request('nodes.ids')).length, 1);
});
