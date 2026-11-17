// Control plane unit tests: one session per user (SessionManager) on a runner reached through
// the protocol (an in-memory stream pair, test/unit/runner-pair.js), server instance records,
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
const {SessionManager, userAliasName} = require('../../server/session-manager');
const {ServerInstance} = require('../../server/server-instance');
const {createSessionSnapshot} = require('../../runner/archive-snapshot');
const {runnerPair, root, commands} = require('./runner-pair');

async function setup(t) {
  const pair = await runnerPair(t, {prefix: 'qw-manager-'});
  const manager = new SessionManager({runtimeRoot: pair.runtimeRoot, registry: pair.registry});
  return {...pair, manager};
}

// Opens a session and waits until the runner created it.
async function opened(manager, login) {
  const workspace = manager.open(login);
  await workspace.runner.request('nodes.list');
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
    assert.match(session.id, /^[0-9a-f]{16}$/);
    assert.equal(session.runnerId, 'local');
    assert.equal(session.runtimeDir, path.join(runtimeRoot, 'sessions', session.id));
  }
  // session.json is the definition only; what belongs to the live session is in meta.json.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(toto.session.runtimeDir, 'session.json'), 'utf8')),
    {schemaVersion: 4, engine: 'qemu', hosts: [], switches: []});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(toto.session.runtimeDir, 'meta.json'), 'utf8')),
    {schemaVersion: 1, owner: 'toto', createdAt: toto.session.createdAt});
  assert.equal(new Date(toto.session.createdAt).toISOString(), toto.session.createdAt);
  const alias = path.join(runtimeRoot, 'users', 'toto');
  assert.equal(fs.readlinkSync(alias), path.join('..', 'sessions', toto.session.id));
  assert.equal(fs.realpathSync(alias), fs.realpathSync(toto.session.runtimeDir));
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
  const id = 's-00000000000000aa';
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
  await toto.runner.request('switch.create', {id: 's-00000000000000bb', name: 'sw', autostart: false});
  const removed = [];
  manager.on('removed', (workspace, by, reason) => removed.push([workspace.session.id, by, reason]));
  assert.equal(await manager.remove('toto'), true);
  assert.deepEqual(removed, [[toto.session.id, 'toto', null]]);
  assert.equal(fs.existsSync(toto.session.runtimeDir), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'users', 'toto')), false);
  assert.equal(manager.get('toto'), null);
  assert.equal(await manager.remove('toto'), false);
  const again = await opened(manager, 'toto');
  assert.notEqual(again.session.id, toto.session.id);
  again.session.archiveBusy = true;
  await assert.rejects(manager.remove('toto'), /archive operation/);
  again.session.archiveBusy = false;
});

test('a lost runner drops its sessions like deleted ones, and no session opens without a runner', async t => {
  const {runtimeRoot, manager, client} = await setup(t);
  const toto = await opened(manager, 'toto');
  const removed = [];
  manager.on('removed', (workspace, by, reason) => removed.push([workspace.owner, by, reason]));
  const lost = once(manager.registry, 'lost');
  client.close();
  await lost;
  assert.deepEqual(removed, [['toto', null, 'runner lost']]);
  assert.equal(manager.get('toto'), null);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'users', 'toto')), false);
  assert.equal(fs.existsSync(toto.session.runtimeDir), false, 'a runner sharing runtime/ is gone: its session directory is removed');
  assert.throws(() => manager.open('toto'), error => error.status === 503);
  await assert.rejects(toto.runner.request('nodes.list'), error => error.status === 503);
});

test('a runner hello resynchronises: unknown sessions are deleted, missing ones dropped', async t => {
  const {manager, service, entry} = await setup(t);
  const toto = await opened(manager, 'toto');
  await service.handle('session.create', '00000000000000cc', {owner: 'ghost'});
  const removed = [];
  manager.on('removed', (workspace, by, reason) => removed.push([workspace.owner, reason]));
  manager.resync(entry, {sessions: [{sessionId: '00000000000000cc'}]});
  assert.deepEqual(removed, [['toto', 'runner lost']]);
  for (let turn = 0; turn < 100 && service.hello().sessions.length > 1; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(service.hello().sessions.map(item => item.sessionId), [toto.session.id]);
});

test('exit cleanup removes the aliases of sessions whose directory is gone', async t => {
  const {runtimeRoot, manager} = await setup(t);
  const toto = await opened(manager, 'toto');
  fs.rmSync(toto.session.runtimeDir, {recursive: true});
  manager.pruneUserAliases();
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'users')), false, 'dangling aliases are pruned');
});

test('user aliases encode the login like hostname aliases', () => {
  assert.equal(userAliasName('jean@example.org'), 'jean%40example.org');
  assert.equal(userAliasName('a.b'), 'a.b');
  assert.equal(userAliasName('..'), '%2E%2E');
});

test('server records list the live sessions of every running server', t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-instance-'));
  t.after(() => fs.rmSync(runtimeRoot, {recursive: true, force: true}));
  fs.mkdirSync(path.join(runtimeRoot, 'sessions'));
  const instance = new ServerInstance({runtimeRoot, port: 4001, ephemeral: true});
  instance.writeRecords(['0123456789abcdef', 'fedcba9876543210']);
  assert.equal(fs.readFileSync(instance.sessionFile, 'utf8'), 'test\n0123456789abcdef\nfedcba9876543210\n');
  fs.writeFileSync(path.join(runtimeRoot, 'server-4002.pid'), `${process.pid}\n`);
  fs.writeFileSync(path.join(runtimeRoot, 'server-4002.session'), 'regular\n00000000000000aa\n');
  fs.writeFileSync(path.join(runtimeRoot, 'server-4003.pid'), `${process.pid}\n`);
  fs.writeFileSync(path.join(runtimeRoot, 'server-4003.session'), 'not a kind\n00000000000000bb\n');
  const live = instance.liveServerSessions();
  assert.deepEqual([...live.keys()].sort(), ['00000000000000aa', '0123456789abcdef', 'fedcba9876543210']);
  assert.equal(live.get('0123456789abcdef').ephemeral, true);
  assert.equal(live.get('00000000000000aa').ephemeral, false);
  instance.removeRecords();
  assert.equal(fs.existsSync(instance.pidFile), false);
  assert.equal(fs.existsSync(instance.sessionFile), false);
});

test('the owner is not part of the session definition: an archive that carries one is refused, an import leaves meta.json alone', t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-owner-'));
  t.after(() => fs.rmSync(runtimeRoot, {recursive: true, force: true}));
  const session = new Session({runtimeRoot, id: '00000000000000dd', owner: 'titi'});
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
  fs.writeFileSync(path.join(stage, 'session.json'), JSON.stringify({schemaVersion: 4, engine: 'qemu', hosts: [], switches: []}));
  const files = snapshot.archivedSessionFiles(stage, ['session.json']);
  snapshot.installArchive(files, stage);
  assert.deepEqual(JSON.parse(fs.readFileSync(session.metadataFile, 'utf8')), {schemaVersion: 4, engine: 'qemu', hosts: [], switches: []});
  assert.equal(JSON.parse(fs.readFileSync(session.metaFile, 'utf8')).owner, 'titi');
  assert.deepEqual(emitted, ['general-settings-changed', 'nodes-changed']);
  for (const extra of [{owner: 'toto'}, {baseImages: {}}, {intruder: 1}]) {
    fs.writeFileSync(path.join(stage, 'session.json'), JSON.stringify({schemaVersion: 4, engine: 'qemu', hosts: [], switches: [], ...extra}));
    assert.throws(() => snapshot.archivedSessionFiles(stage, ['session.json']), /Invalid session.json/, `refused: ${Object.keys(extra)}`);
  }
});

test('empty runtime sessions left by a stopped server are pruned, with their meta.json', t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-prune-'));
  t.after(() => fs.rmSync(runtimeRoot, {recursive: true, force: true}));
  const sessions = path.join(runtimeRoot, 'sessions');
  fs.mkdirSync(sessions);
  const instance = new ServerInstance({runtimeRoot, port: 4003, ephemeral: false});
  const old = new Date(Date.now() - 60000);
  const make = (name, files) => {
    const dir = path.join(sessions, name);
    fs.mkdirSync(dir);
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
    fs.utimesSync(dir, old, old);
    return dir;
  };
  const definition = JSON.stringify({schemaVersion: 4, engine: 'qemu', hosts: [], switches: []});
  const empty = make('00000000000000a1', {'session.json': definition, 'meta.json': '{}'});
  const emptyLegacy = make('00000000000000a2', {'session.json': definition});
  const withNodes = make('00000000000000a3', {'session.json': JSON.stringify({schemaVersion: 4, engine: 'qemu', hosts: ['h-0123456789abcdef'], switches: []}), 'meta.json': '{}'});
  const unexpected = make('00000000000000a4', {'session.json': definition, 'meta.json': '{}', 'keep.txt': 'x'});
  const vacant = make('00000000000000a5', {});
  const recent = path.join(sessions, '00000000000000a6');
  fs.mkdirSync(recent);
  const reported = make('00000000000000a7', {});
  const log = console.log;
  console.log = () => {};
  try { instance.pruneEmptyRuntimeSessions({keep: ['00000000000000a7', 5]}); } finally { console.log = log; }
  assert.equal(fs.existsSync(empty), false);
  assert.equal(fs.existsSync(emptyLegacy), false);
  assert.equal(fs.existsSync(withNodes), true);
  assert.equal(fs.existsSync(unexpected), true);
  assert.equal(fs.existsSync(vacant), false, 'a directory with nothing in it is pruned');
  assert.equal(fs.existsSync(recent), true, 'a directory created less than 30 s ago may belong to a starting server');
  assert.equal(fs.existsSync(reported), true, 'a session the runner reports in its hello is kept');
});
