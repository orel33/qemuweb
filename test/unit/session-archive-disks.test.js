'use strict';

// What a session ZIP carries for working disks (VBX02): per host, `disk.qcow2` (QEMU) and/or `disk.vdi`
// (VirtualBox), whichever engine is current, and what the import does with them: the loaded hosts keep both
// engines' settings and both disks, and use those of the session engine. No emulator is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createSessionRunner} = require('../../runner/session-runner');
const {Session} = require('../../runner/session');
const {createSessionSnapshot} = require('../../runner/archive-snapshot');
const {commands: hostCommands} = require('../../runner/commands/hosts');
const {commands: archiveCommands} = require('../../runner/commands/archives');

const root = path.join(__dirname, '..', '..');
const commands = {QEMU_IMG: 'qemu-img', QEMU_SYSTEM_X86_64: 'qemu-system-x86_64', GENISOIMAGE: 'genisoimage', VBOXMANAGE: 'VBoxManage'};
const HOST = 'h-0000000000000001';
const ZERO = '0'.repeat(64);

function setup(t, engine = 'qemu') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-archive-disks-'));
  const session = new Session({runtimeRoot: dir, id: '0000000000000001', engine});
  fs.mkdirSync(session.runtimeDir, {recursive: true});
  const runner = createSessionRunner({session, commands, root, runtimeRoot: dir, configPath: path.join(root, 'config.json')});
  const emitted = [];
  const emit = (event, payload) => emitted.push([event, payload]);
  const snapshot = createSessionSnapshot({session, runner, commands, emit});
  t.after(() => { runner.stopResourceSampling(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {dir, session, runner, snapshot, emit, emitted};
}

function addHost(ctx, settings) {
  const {session, runner, emit} = ctx;
  hostCommands['host.create']({session, runner, emit}, {body: {id: HOST, name: 'web', imageId: 'alpine', settings}});
  session.saveMetadata();
  return runner.getNode(HOST);
}

test('the archive carries disk.qcow2 and/or disk.vdi, whichever engine is current', t => {
  const ctx = setup(t);
  const node = addHost(ctx);
  const qcow2 = path.join(node.runtimeDir, 'disk.qcow2'), vdi = path.join(node.runtimeDir, 'disk.vdi');
  const names = includeDisks => ctx.snapshot.archiveSources(includeDisks).sources.map(item => item.name);
  const disks = includeDisks => ctx.snapshot.archiveSources(includeDisks).hosts[0].disks;

  assert.deepEqual(disks(true), [], 'no disk yet');
  fs.writeFileSync(qcow2, Buffer.alloc(8192, 1));
  assert.deepEqual(disks(true), ['raw']);
  assert.ok(names(true).includes(`${HOST}/disk.qcow2`));
  assert.ok(!names(true).includes(`${HOST}/disk.vdi`));
  fs.writeFileSync(vdi, Buffer.alloc(8192, 2));
  assert.deepEqual(disks(true), ['raw', 'vdi'], 'both engines disks, though only one engine is current');
  assert.ok(names(true).includes(`${HOST}/disk.vdi`));
  assert.deepEqual(disks(false), [], 'without "Include working disks" none goes in');
  assert.ok(!names(false).some(name => name.includes('/disk.')));

  fs.rmSync(qcow2);
  assert.deepEqual(disks(true), ['vdi'], 'a VirtualBox disk alone is saved too');
  // A VirtualBox session saves its disks (it used to be refused).
  ctx.session.engine = 'vbox';
  node.engine = 'vbox';
  assert.deepEqual(disks(true), ['vdi']);
});

test('the size estimate counts the disks it will include and says how many hosts have each engine disk', t => {
  const ctx = setup(t);
  const node = addHost(ctx);
  const estimate = includeDisks => archiveCommands['archive.estimate'](ctx, {includeDisks});
  const plain = estimate(true);
  assert.deepEqual(plain.workingDisks, {qemu: 0, vbox: 0});
  assert.equal(plain.hasWorkingDisks, false);
  fs.writeFileSync(path.join(node.runtimeDir, 'disk.qcow2'), Buffer.alloc(1024 * 1024, 7));
  fs.writeFileSync(path.join(node.runtimeDir, 'disk.vdi'), Buffer.alloc(1024 * 1024, 9));
  const both = estimate(true);
  assert.deepEqual(both.workingDisks, {qemu: 1, vbox: 1});
  assert.equal(both.hasWorkingDisks, true);
  assert.ok(both.bytes > plain.bytes + 2 * 1024 * 1024 * 0.9, 'both disks are in the estimate');
  const without = estimate(false);
  assert.equal(without.hasWorkingDisks, false);
  assert.equal(without.bytes, plain.bytes);
});

test('saving disks needs the hosts stopped, whichever disks exist', t => {
  const ctx = setup(t);
  const node = addHost(ctx);
  node.machine = {};
  assert.throws(() => ctx.snapshot.archiveSources(true), /Stop every host before saving working disks/);
  assert.doesNotThrow(() => ctx.snapshot.archiveSources(true, true));
  node.machine = null;
  node.action = 'reboot';
  assert.throws(() => ctx.snapshot.archiveSources(true), /Wait for the current host action/);
});

function stageArchive(ctx, {engine, disks}) {
  const stage = fs.mkdtempSync(path.join(ctx.dir, 'stage-'));
  fs.mkdirSync(path.join(stage, HOST, 'startup'), {recursive: true});
  fs.writeFileSync(path.join(stage, 'session.json'), JSON.stringify({schemaVersion: 1, engine, hosts: [HOST], switches: []}));
  fs.writeFileSync(path.join(stage, HOST, 'startup', 'start.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(stage, HOST, 'host.json'), JSON.stringify({
    schemaVersion: 2, id: HOST, name: 'web', system: 'alpine',
    config: {'memory:qemu': 2048, 'memory:vbox': 3072, 'cpus:vbox': 2},
    network: {interfaces: [{switchId: null, port: null, mac: '02:00:00:00:00:01'}]},
    ...(disks.length ? {baseImages: Object.fromEntries(disks.map(format => [format, {size: 1, sha256: ZERO}]))} : {})
  }));
  const files = ['session.json', `${HOST}/host.json`, `${HOST}/startup/start.sh`];
  if (disks.includes('raw')) { fs.writeFileSync(path.join(stage, HOST, 'disk.qcow2'), 'qcow2'); files.push(`${HOST}/disk.qcow2`); }
  if (disks.includes('vdi')) { fs.writeFileSync(path.join(stage, HOST, 'disk.vdi'), 'vdi'); files.push(`${HOST}/disk.vdi`); }
  return {stage, files};
}

for (const [engine, disks, expected] of [
  ['qemu', ['raw', 'vdi'], 'disk.qcow2'],
  ['vbox', ['raw', 'vdi'], 'disk.vdi'],
  ['qemu', ['vdi'], null],
  ['vbox', ['raw'], null],
  ['qemu', [], null]
]) {
  test(`loading a ${engine} session with disks [${disks}]: settings of both engines kept, the ${engine} disk is the current one`, t => {
    const ctx = setup(t, engine === 'qemu' ? 'vbox' : 'qemu');
    const {stage, files} = stageArchive(ctx, {engine, disks});
    const snapshot = ctx.snapshot.archivedSessionFiles(stage, files);
    assert.deepEqual(snapshot.hosts[0].disks, ['raw', 'vdi'].filter(format => disks.includes(format)));
    ctx.snapshot.installArchive(snapshot, stage);

    assert.equal(ctx.session.engine, engine, 'the loaded engine becomes the session engine');
    const node = ctx.runner.getNode(HOST);
    assert.equal(node.engine, engine);
    assert.equal(node.runDisk, expected ? path.join(node.runtimeDir, expected) : null);
    assert.equal(node.everStarted, !!expected);
    assert.equal(node.launchSettings.memory, engine === 'qemu' ? 2048 : 3072, 'the settings of the session engine apply');
    assert.deepEqual(node.hostConfig, {'memory:qemu': 2048, 'memory:vbox': 3072, 'cpus:vbox': 2}, 'both engines settings are kept');
    for (const format of disks) assert.ok(fs.existsSync(path.join(node.runtimeDir, format === 'raw' ? 'disk.qcow2' : 'disk.vdi')), `${format} disk kept in the node directory`);
    // The runner writes its own host.json (no engine, no base image record) and session.json.
    const written = JSON.parse(fs.readFileSync(path.join(node.runtimeDir, 'host.json'), 'utf8'));
    assert.equal(written.schemaVersion, 2);
    assert.ok(!('engine' in written) && !('baseImages' in written) && !('disk' in written));
    assert.deepEqual(written.config, {'memory:qemu': 2048, 'memory:vbox': 3072, 'cpus:vbox': 2});
    assert.equal(JSON.parse(fs.readFileSync(ctx.session.metadataFile, 'utf8')).engine, engine);
    assert.ok(ctx.emitted.some(([event, payload]) => event === 'general-settings-changed' && payload.engine === engine));
  });
}
