'use strict';

// Changing the session engine with hosts present (VBX02): session.setEngine switches the engine of the
// session and of every host without deleting anything: the settings of both engines stay in each
// host's config, and each engine's working disk stays in the node directory. It is refused while a host
// is running or busy, and the answer lists the hosts that cannot start on the new engine.
// The runner of one session is driven in memory; nothing is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createSessionRunner} = require('../../runner/session-runner');
const {commands: settingsCommands} = require('../../runner/commands/settings');
const {commands: hostCommands} = require('../../runner/commands/hosts');
const {selectedProfile} = require('../../common/system-config');

const projectRoot = path.join(__dirname, '..', '..');
const commands = {QEMU_IMG: 'qemu-img', QEMU_SYSTEM_X86_64: 'qemu-system-x86_64', GENISOIMAGE: 'genisoimage', VBOXMANAGE: 'VBoxManage'};
const HOST_1 = 'h-00000001';
const HOST_2 = 'h-00000002';

// A project root of its own: config.json and base images in the QEMU format for every system, in the
// VirtualBox format for alpine only.
function setup(t, {vbox = true} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-engine-switch-'));
  fs.mkdirSync(path.join(dir, 'images'));
  fs.copyFileSync(path.join(projectRoot, 'config.json'), path.join(dir, 'config.json'));
  for (const system of ['debian13-legacy', 'alpine', 'debian13-cloud', 'openwrt']) fs.writeFileSync(path.join(dir, 'images', `${system}.raw`), 'raw');
  fs.writeFileSync(path.join(dir, 'images', 'alpine.vdi'), 'vdi');
  const runtimeDir = path.join(dir, 'runtime', 'sessions', 'test');
  fs.mkdirSync(runtimeDir, {recursive: true});
  const saved = [];
  const session = {id: '00000001', nodes: new Map(), engine: 'qemu', runtimeDir, saveMetadata(engine) { if (engine) saved.push(engine); }};
  const runner = createSessionRunner({session, commands: vbox ? commands : {...commands, VBOXMANAGE: undefined}, root: dir,
    runtimeRoot: path.join(dir, 'runtime'), configPath: path.join(dir, 'config.json')});
  const emitted = [];
  const emit = (event, payload) => emitted.push([event, payload]);
  t.after(() => { runner.stopResourceSampling(); fs.rmSync(dir, {recursive: true, force: true}); });
  const profile = (system, engine) => selectedProfile(runner.readConfig(), system, engine);
  const addHost = (id, name, imageId, settings) => hostCommands['host.create']({session, runner, emit}, {body: {id, name, imageId, settings}});
  const setEngine = engine => settingsCommands['session.setEngine']({session, runner, emit}, {body: {engine}});
  return {dir, runner, session, saved, emitted, emit, profile, addHost, setEngine, runtimeDir};
}

const hostJson = (runtimeDir, id) => fs.readFileSync(path.join(runtimeDir, id, 'host.json'), 'utf8');
const tree = dir => fs.readdirSync(dir, {recursive: true}).sort();

test('the engine changes with hosts present: names, ids, interfaces and both engines settings stay, nothing is deleted', t => {
  const {runner, session, saved, emitted, profile, addHost, setEngine, runtimeDir} = setup(t);
  addHost(HOST_1, 'web', 'alpine', {memory: 2048, cpus: 2});
  addHost(HOST_2, 'db', 'debian13-legacy', {serialPorts: ['ttyS0']});
  const web = runner.getNode(HOST_1), db = runner.getNode(HOST_2);
  const before = {files: tree(runtimeDir), webJson: hostJson(runtimeDir, HOST_1), dbJson: hostJson(runtimeDir, HOST_2), nics: web.networkInterfaces};
  // Settings are stored for the engine they were set under (QEMU here), never unsuffixed.
  assert.deepEqual(JSON.parse(before.webJson).config, {'memory:qemu': 2048, 'cpus:qemu': 2});
  assert.deepEqual(JSON.parse(before.dbJson).config, {'serialPorts:qemu': ['ttyS0']});
  assert.ok(!('engine' in JSON.parse(before.webJson)));

  const answer = setEngine('vbox');
  assert.equal(answer.engine, 'vbox');
  assert.equal(session.engine, 'vbox');
  assert.deepEqual(saved, ['vbox'], 'session.json is written with the new engine');
  assert.ok(emitted.some(([event, payload]) => event === 'general-settings-changed' && payload.engine === 'vbox'));
  assert.ok(emitted.some(([event]) => event === 'nodes-changed'));

  for (const node of [web, db]) assert.equal(node.engine, 'vbox');
  // The VirtualBox values of the system profile apply: the QEMU values are not used.
  assert.equal(web.launchSettings.memory, profile('alpine', 'vbox').memory);
  assert.equal(web.launchSettings.cpus, profile('alpine', 'vbox').cpus);
  assert.deepEqual(db.launchSettings.serialPorts, ['ttyS0']);
  assert.equal(web.hostname, 'web');
  assert.deepEqual(web.networkInterfaces, before.nics);
  assert.equal(hostJson(runtimeDir, HOST_1), before.webJson, 'host.json is not touched by the switch');
  assert.equal(hostJson(runtimeDir, HOST_2), before.dbJson);
  assert.deepEqual(tree(runtimeDir), before.files);

  // Back to QEMU: the values chosen there are still there.
  setEngine('qemu');
  assert.equal(web.launchSettings.memory, 2048);
  assert.equal(web.launchSettings.cpus, 2);
  assert.equal(hostJson(runtimeDir, HOST_1), before.webJson);
});

test('the answer lists the hosts whose system has no image for the new engine; they stay in the session', t => {
  const {runner, session, addHost, setEngine, runtimeDir} = setup(t);
  addHost(HOST_1, 'web', 'alpine');
  addHost(HOST_2, 'db', 'debian13-legacy');
  const answer = setEngine('vbox');
  assert.deepEqual(answer.unavailableHosts, [{id: HOST_2, name: 'db', system: 'debian13-legacy', message: 'db: no VirtualBox image on this server'}]);
  assert.ok(runner.getNode(HOST_2), 'the host is kept');
  assert.ok(fs.existsSync(path.join(runtimeDir, HOST_2, 'host.json')));
  // The same list is part of the session settings, for a page that opens later or in another tab.
  const settings = settingsCommands['session.settings']({session, runner});
  assert.deepEqual(settings.unavailableHosts.map(item => item.id), [HOST_2]);
  assert.equal(settings.hostsInUse, false);
  assert.deepEqual(setEngine('qemu').unavailableHosts, []);
});

test('a running or busy host refuses the change with 409, and nothing changes', t => {
  const {runner, session, saved, emitted, addHost, setEngine} = setup(t);
  addHost(HOST_1, 'web', 'alpine');
  const node = runner.getNode(HOST_1);
  for (const busy of [{machine: {}}, {action: 'reboot'}, {stopping: true}]) {
    Object.assign(node, {machine: null, action: null, stopping: false}, busy);
    assert.throws(() => setEngine('vbox'), error => error.status === 409 && error.message === 'Stop all hosts before changing the engine.', JSON.stringify(busy));
    assert.equal(session.engine, 'qemu');
    assert.equal(node.engine, 'qemu');
    assert.equal(settingsCommands['session.settings']({session, runner}).hostsInUse, true);
  }
  assert.deepEqual(saved, []);
  assert.deepEqual(emitted, emitted.filter(([event]) => event === 'nodes-changed'), 'no general-settings-changed');
  // A running switch does not block the change.
  Object.assign(node, {machine: null, action: null, stopping: false});
  runner.createNode('s-00000001', 'switch').machine = {};
  assert.equal(setEngine('vbox').engine, 'vbox');
});

test('an engine the runner does not have is refused, and the same engine is a no-op', t => {
  const {session, saved, emitted, setEngine} = setup(t, {vbox: false});
  assert.throws(() => setEngine('vbox'), /VirtualBox is unavailable on this server/);
  assert.throws(() => setEngine('xen'), /Invalid session engine/);
  setEngine('qemu');
  assert.equal(session.engine, 'qemu');
  assert.deepEqual(saved, []);
  assert.deepEqual(emitted.filter(([event]) => event === 'general-settings-changed'), []);
});

test('each engine keeps its own working disk: a switch re-points the host to the disk of the new engine and deletes none', t => {
  const {runner, addHost, setEngine, runtimeDir} = setup(t);
  addHost(HOST_1, 'web', 'alpine');
  const node = runner.getNode(HOST_1);
  const qcow2 = path.join(runtimeDir, HOST_1, 'disk.qcow2'), vdi = path.join(runtimeDir, HOST_1, 'disk.vdi');
  // A started QEMU host that was stopped: its overlay is the current disk.
  fs.writeFileSync(qcow2, 'qcow2');
  Object.assign(node, {runDisk: qcow2, everStarted: true});
  node.selectedImage.runFiles = [qcow2];

  setEngine('vbox');
  assert.equal(node.runDisk, null, 'the QEMU disk is not the VirtualBox disk');
  assert.equal(node.everStarted, false, 'no VirtualBox disk yet: the first start creates it');
  assert.deepEqual(node.selectedImage.runFiles, []);
  assert.equal(node.qemuOptions, null);
  assert.ok(fs.existsSync(qcow2), 'the QEMU disk is kept');

  // The VirtualBox start created its differencing disk; stopped, it is the current disk.
  fs.writeFileSync(vdi, 'vdi');
  Object.assign(node, {runDisk: vdi, everStarted: true});
  node.selectedImage.runFiles = [vdi];

  setEngine('qemu');
  assert.equal(node.runDisk, qcow2);
  assert.equal(node.everStarted, true);
  assert.deepEqual(node.selectedImage.runFiles, [qcow2], 'Reset and removal of the current engine touch this disk only');
  assert.ok(node.qemuOptions, 'a QEMU host with a disk resumes with its QEMU options');
  assert.ok(fs.existsSync(vdi), 'the VirtualBox disk is kept');
  setEngine('vbox');
  assert.equal(node.runDisk, vdi);
  assert.equal(node.everStarted, true);
});

test('a failure while switching puts the session and the hosts back on the previous engine', t => {
  const {runner, session, addHost, setEngine} = setup(t);
  addHost(HOST_1, 'web', 'alpine');
  session.saveMetadata = () => { throw new Error('disk full'); };
  assert.throws(() => setEngine('vbox'), /disk full/);
  assert.equal(session.engine, 'qemu');
  assert.equal(runner.getNode(HOST_1).engine, 'qemu');
});

test('the start path reads the settings of the current engine only', t => {
  const {runner, addHost, setEngine, profile} = setup(t);
  addHost(HOST_1, 'web', 'alpine', {memory: 4096});
  const node = runner.getNode(HOST_1);
  setEngine('vbox');
  assert.equal(node.launchSettings.memory, profile('alpine', 'vbox').memory);
  assert.equal(node.hostConfig['memory:qemu'], 4096);
  // The launch preview of the session engine shows the VirtualBox values and commands.
  const preview = runner.previewLaunch(HOST_1, {system: 'alpine', engine: 'vbox', interfaces: '[null]'});
  assert.equal(preview.settings.memory, profile('alpine', 'vbox').memory);
  assert.ok(preview.commands.some(line => line.includes('createvm')));
});
