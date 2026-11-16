// Control plane unit tests: one session per user (SessionManager), server instance
// records, and the session owner in meta.json (never in session.json or archives). No server is started
// and no emulator process is spawned.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createRunner} = require('../../runner');
const {Session} = require('../../lib/session');
const {SessionManager, userAliasName} = require('../../lib/session-manager');
const {ServerInstance} = require('../../lib/server-instance');
const {createSessionSnapshot} = require('../../lib/session-snapshot');

const root = path.join(__dirname, '..', '..');
const commands = {QEMU_IMG: 'qemu-img', QEMU_SYSTEM_X86_64: 'qemu-system-x86_64', GENISOIMAGE: 'genisoimage'};

function setup(t) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-manager-'));
  const manager = new SessionManager({runtimeRoot, createRunner: (session, hostNodes) =>
    createRunner({session, commands, root, runtimeRoot, configPath: path.join(root, 'config.json'), hostNodes})});
  t.after(async () => {
    await manager.shutdown();
    for (const workspace of manager.list()) workspace.runner.stopResourceSampling();
    fs.rmSync(runtimeRoot, {recursive: true, force: true});
  });
  return {runtimeRoot, manager};
}

test('each user gets one persistent session with a random ID, an owner and an alias', t => {
  const {runtimeRoot, manager} = setup(t);
  const created = [];
  manager.on('created', workspace => created.push(workspace.owner));
  const toto = manager.open('toto');
  assert.equal(manager.open('toto'), toto, 'the same workspace is returned on every request');
  const titi = manager.open('titi');
  assert.deepEqual(created, ['toto', 'titi']);
  assert.notEqual(toto.session.id, titi.session.id);
  assert.notEqual(toto.runner, titi.runner);
  assert.notEqual(toto.runner.events, titi.runner.events);
  for (const {session} of [toto, titi]) {
    assert.match(session.id, /^[0-9a-f]{16}$/);
    assert.equal(session.runtimeDir, path.join(runtimeRoot, 'sessions', session.id));
  }
  // session.json is the definition only; what belongs to the live session is in meta.json.
  assert.deepEqual(JSON.parse(fs.readFileSync(toto.session.metadataFile, 'utf8')),
    {schemaVersion: 4, engine: 'qemu', hosts: [], switches: []});
  assert.deepEqual(JSON.parse(fs.readFileSync(toto.session.metaFile, 'utf8')),
    {schemaVersion: 1, owner: 'toto', createdAt: toto.session.createdAt});
  assert.equal(new Date(toto.session.createdAt).toISOString(), toto.session.createdAt);
  const alias = path.join(runtimeRoot, 'users', 'toto');
  assert.equal(fs.readlinkSync(alias), path.join('..', 'sessions', toto.session.id));
  assert.equal(fs.realpathSync(alias), fs.realpathSync(toto.session.runtimeDir));
  assert.deepEqual(manager.sessionIds().sort(), [toto.session.id, titi.session.id].sort());
  assert.throws(() => manager.open(''), /login is required/);
});

test('runners are independent: nodes and events stay in their session', t => {
  const {manager} = setup(t);
  const toto = manager.open('toto');
  const titi = manager.open('titi');
  const events = {toto: [], titi: []};
  toto.runner.events.on('log', event => events.toto.push(event.nodeId));
  titi.runner.events.on('log', event => events.titi.push(event.nodeId));
  // Archives keep node IDs, so two sessions can hold the same ID.
  const id = 'h-00000000000000aa';
  const first = toto.runner.createNode(id, 'host');
  const second = titi.runner.createNode(id, 'host');
  assert.notEqual(first, second);
  assert.notEqual(first.runtimeDir, second.runtimeDir);
  assert.notEqual(first.vmName, second.vmName, 'VirtualBox VM names are machine-wide');
  assert.equal(toto.runner.getNode(id), first);
  toto.runner.appendLog(first, 'only toto');
  assert.deepEqual(events, {toto: [id], titi: []});
  assert.equal(manager.hostNodes().length, 2, 'the KVM/VirtualBox exclusion sees every session');
});

test('deleting a session stops it, removes its files and alias, and the next open starts afresh', async t => {
  const {runtimeRoot, manager} = setup(t);
  const toto = manager.open('toto');
  toto.runner.createNode('s-00000000000000bb', 'switch');
  const removed = [];
  manager.on('removed', workspace => removed.push(workspace.session.id));
  assert.equal(await manager.remove('toto'), true);
  assert.deepEqual(removed, [toto.session.id]);
  assert.equal(fs.existsSync(toto.session.runtimeDir), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'users', 'toto')), false);
  assert.equal(manager.get('toto'), null);
  assert.equal(await manager.remove('toto'), false);
  const again = manager.open('toto');
  assert.notEqual(again.session.id, toto.session.id);
  again.session.archiveBusy = true;
  await assert.rejects(manager.remove('toto'), /archive operation/);
  again.session.archiveBusy = false;
});

test('exit cleanup removes empty session directories and their aliases', t => {
  const {runtimeRoot, manager} = setup(t);
  const toto = manager.open('toto');
  const titi = manager.open('titi');
  fs.writeFileSync(path.join(titi.session.runtimeDir, 'keep.txt'), 'unexpected');
  manager.removeEmptyRuntimeSessions();
  assert.equal(fs.existsSync(toto.session.runtimeDir), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'users', 'toto')), false);
  assert.equal(fs.existsSync(titi.session.runtimeDir), true, 'unexpected contents are kept');
  fs.rmSync(titi.session.runtimeDir, {recursive: true});
  manager.pruneUserAliases();
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'users')), false, 'dangling aliases are pruned');
});

test('user aliases encode the login like hostname aliases', () => {
  assert.equal(userAliasName('jean@example.org'), 'jean%40example.org');
  assert.equal(userAliasName('a.b'), 'a.b');
  assert.equal(userAliasName('..'), '%2E%2E');
});

test('server records list live sessions and accept the former layout', t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-instance-'));
  t.after(() => fs.rmSync(runtimeRoot, {recursive: true, force: true}));
  fs.mkdirSync(path.join(runtimeRoot, 'sessions'));
  const instance = new ServerInstance({runtimeRoot, port: 4001, ephemeral: true});
  instance.writeRecords(['0123456789abcdef', 'fedcba9876543210']);
  assert.equal(fs.readFileSync(instance.sessionFile, 'utf8'), 'test\n0123456789abcdef\nfedcba9876543210\n');
  fs.writeFileSync(path.join(runtimeRoot, 'server-4002.pid'), `${process.pid}\n`);
  fs.writeFileSync(path.join(runtimeRoot, 'server-4002.session'), '00000000000000aa\nregular\n');
  const live = instance.liveServerSessions();
  assert.deepEqual([...live.keys()].sort(), ['00000000000000aa', '0123456789abcdef', 'fedcba9876543210']);
  assert.equal(live.get('0123456789abcdef').ephemeral, true);
  assert.equal(live.get('00000000000000aa').ephemeral, false);
  fs.symlinkSync(path.join('sessions', 'x'), path.join(runtimeRoot, 'current'));
  instance.removeLegacyCurrentLink();
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'current')), false);
  instance.removeRecords();
  assert.equal(fs.existsSync(instance.pidFile), false);
  assert.equal(fs.existsSync(instance.sessionFile), false);
});

test('the owner is not part of the session definition: archives never carry it, an import leaves meta.json alone', t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-owner-'));
  t.after(() => fs.rmSync(runtimeRoot, {recursive: true, force: true}));
  const session = new Session({runtimeRoot, owner: 'titi'});
  fs.mkdirSync(session.runtimeDir, {recursive: true});
  session.saveMetadata();
  session.saveMeta();
  assert.equal(session.metadata().owner, undefined);
  assert.equal(JSON.parse(fs.readFileSync(session.metadataFile, 'utf8')).owner, undefined);
  assert.equal(JSON.parse(fs.readFileSync(session.metaFile, 'utf8')).owner, 'titi');
  const runner = createRunner({session, commands, root, runtimeRoot, configPath: path.join(root, 'config.json')});
  const emitted = [];
  const snapshot = createSessionSnapshot({session, runner, commands, emit: (event, payload) => emitted.push(event)});
  const stage = fs.mkdtempSync(path.join(runtimeRoot, 'stage-'));
  // An owner in an archive (for instance one made by zipping a runtime directory by hand) is tolerated and ignored.
  fs.writeFileSync(path.join(stage, 'session.json'), JSON.stringify({schemaVersion: 4, engine: 'qemu', hosts: [], switches: [], baseImages: {}, owner: 'toto'}));
  const files = snapshot.archivedSessionFiles(stage, ['session.json']);
  snapshot.installArchive(files, stage);
  assert.deepEqual(JSON.parse(fs.readFileSync(session.metadataFile, 'utf8')), {schemaVersion: 4, engine: 'qemu', hosts: [], switches: []});
  assert.equal(JSON.parse(fs.readFileSync(session.metaFile, 'utf8')).owner, 'titi');
  assert.deepEqual(emitted, ['general-settings-changed', 'nodes-changed']);
  fs.writeFileSync(path.join(stage, 'session.json'), JSON.stringify({schemaVersion: 4, engine: 'qemu', hosts: [], switches: [], baseImages: {}, intruder: 1}));
  assert.throws(() => snapshot.archivedSessionFiles(stage, ['session.json']), /Invalid session.json/);
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
  const log = console.log;
  console.log = () => {};
  try { instance.pruneEmptyRuntimeSessions(); } finally { console.log = log; }
  assert.equal(fs.existsSync(empty), false);
  assert.equal(fs.existsSync(emptyLegacy), false);
  assert.equal(fs.existsSync(withNodes), true);
  assert.equal(fs.existsSync(unexpected), true);
});
