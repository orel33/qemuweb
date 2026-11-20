// Session archive validation (host.json format 2): the identity of each base image (size, SHA-256) is
// recorded in `baseImages`, keyed by format (raw for disk.qcow2, vdi for disk.vdi), in the host.json
// of hosts with working disks, since only those depend on it. No server and no emulator process is needed.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createSessionRunner} = require('../../runner/session-runner');
const {Session} = require('../../runner/session');
const {createSessionSnapshot} = require('../../runner/archive-snapshot');
const {selectedProfile, readCatalog} = require('../../common/system-config');

const root = path.join(__dirname, '..', '..');
const commands = {QEMU_IMG: 'qemu-img', QEMU_SYSTEM_X86_64: 'qemu-system-x86_64', GENISOIMAGE: 'genisoimage'};
const HOST = 'h-0123456789abcdef';
const ZERO = '0'.repeat(64);

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-archive-'));
  const image = path.join(dir, 'base.raw');
  fs.writeFileSync(image, 'base image content');
  fs.writeFileSync(`${image}.vdi`, 'base vdi content!');
  const session = new Session({runtimeRoot: dir, id: '0000000000000001'});
  const runner = createSessionRunner({session, commands, root, runtimeRoot: dir, configPath: path.join(root, 'config.json')});
  t.after(() => { runner.stopResourceSampling(); fs.rmSync(dir, {recursive: true, force: true}); });
  // The base image of every system is a small temporary file, so that no real image is read.
  const stub = {...runner, imageById: id => ({...runner.imageById(id), images: {raw: image, vdi: `${image}.vdi`}}), imagePath: file => file};
  const snapshot = createSessionSnapshot({session, runner: stub, commands, emit() {}});
  const profile = selectedProfile(runner.readConfig(), 'debian13-legacy', 'qemu');
  const stage = path.join(dir, 'stage');
  fs.mkdirSync(path.join(stage, HOST), {recursive: true});
  // `disks` is not in host.json: the importer computes it from the members of the ZIP.
  const host = (extra = {}) => ({schemaVersion: 2, id: HOST, name: 'h1', system: 'debian13-legacy',
    config: profile.startupDiskEnabled === false ? {} : {startupDiskEnabled: false},
    network: {interfaces: []}, disks: [], ...extra});
  const archive = (hosts, extra = {}) => {
    const disks = hosts.flatMap(item => item.disks);
    const files = ['session.json', `${HOST}/host.json`, ...(disks.includes('raw') ? [`${HOST}/disk.qcow2`] : []), ...(disks.includes('vdi') ? [`${HOST}/disk.vdi`] : [])];
    if (disks.includes('raw')) fs.writeFileSync(path.join(stage, HOST, 'disk.qcow2'), 'disk');
    if (disks.includes('vdi')) fs.writeFileSync(path.join(stage, HOST, 'disk.vdi'), 'disk');
    return {engine: 'qemu', hosts, switches: [], files, ...extra};
  };
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return {dir, stage, snapshot, host, archive, profile, size: fs.statSync(image).size, vdiSize: fs.statSync(`${image}.vdi`).size,
    rawSha: sha(image), vdiSha: sha(`${image}.vdi`)};
}

test('hosts without a working disk need no base image identity', async t => {
  const {snapshot, host, archive, stage} = setup(t);
  assert.deepEqual(await snapshot.validateArchiveSession(archive([host()]), stage), []);
});

test('format 1 and the removed keys (engine, disk, baseImage, profileHash) are refused', async t => {
  const {snapshot, host, archive, stage} = setup(t);
  await assert.rejects(snapshot.validateArchiveSession(archive([host({schemaVersion: 1})]), stage), /Unknown system for h1/);
  for (const extra of [{engine: 'qemu'}, {disk: false}, {baseImage: {format: 'raw', size: 1, sha256: ZERO}}, {profileHash: ZERO}]) {
    await assert.rejects(snapshot.validateArchiveSession(archive([host(extra)]), stage), /Unknown host configuration keyword/, JSON.stringify(extra));
  }
});

test('config keys: unsuffixed (both engines), :qemu and :vbox are validated against the profile of their engine', async t => {
  const {snapshot, host, archive, stage, profile} = setup(t);
  const check = config => snapshot.validateArchiveSession(archive([host({config: {startupDiskEnabled: false, ...config}})]), stage);
  assert.deepEqual(await check({memory: profile.memory, startupDiskEnabled: false}), []);
  assert.deepEqual(await check({'memory:vbox': 1024, 'cpus:qemu': 2, 'clock:vbox': 'localtime', startupDiskEnabled: false}), []);
  // debian13-legacy has ttyS0 and ttyS1 under QEMU and only ttyS0 under VirtualBox.
  assert.deepEqual(await check({'serialPorts:qemu': ['ttyS0', 'ttyS1']}), []);
  await assert.rejects(check({'serialPorts:vbox': ['ttyS0', 'ttyS1']}), /serialPorts:vbox: This system exposes only ttyS0/);
  await assert.rejects(check({serialPorts: ['ttyS0', 'ttyS1']}), /serialPorts: This system exposes only ttyS0/);
  await assert.rejects(check({'memory:vbox': 8}), /memory:vbox: Memory must be between 64 and 32768 MB/);
  await assert.rejects(check({'memory:xen': 512}), /may only override memory, cpus, clock, startupDiskEnabled and serialPorts, optionally suffixed/);
  await assert.rejects(check({'hostname': 'x'}), /Invalid configuration of h1/);
  await assert.rejects(check({'memory:qemu:vbox': 512}), /Invalid configuration of h1/);
});

test('a working disk whose base image changed is refused, or discarded on request', async t => {
  const {snapshot, host, archive, stage, size} = setup(t);
  const changed = {raw: {size, sha256: ZERO}};
  await assert.rejects(snapshot.validateArchiveSession(archive([host({disks: ['raw'], baseImages: changed})]), stage),
    /Base image debian13-legacy changed since this session was saved; working disks of h1 cannot be reused\. Enable "Discard working disks/);

  const discarded = archive([host({disks: ['raw'], baseImages: changed})]);
  const warnings = await snapshot.validateArchiveSession(discarded, stage, {discardDisks: true});
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].hosts, [HOST]);
  assert.match(warnings[0].message, /Working disks of h1 were discarded/);
  assert.deepEqual(discarded.hosts[0].disks, []);
  assert.equal(fs.existsSync(path.join(stage, HOST, 'disk.qcow2')), false);
});

test('each disk is checked against the base image of its own format; the vdi too, or its absence', async t => {
  const {snapshot, host, archive, stage, size, vdiSize, rawSha, vdiSha, dir} = setup(t);
  const identities = {raw: {size, sha256: rawSha}, vdi: {size: vdiSize, sha256: vdiSha}};
  // The raw identity is current but the vdi one is not: the vdi disk alone is the reason.
  await assert.rejects(snapshot.validateArchiveSession(archive([host({disks: ['raw', 'vdi'], baseImages: {...identities, vdi: {size: vdiSize, sha256: ZERO}}})]), stage),
    /Base image debian13-legacy changed since this session was saved; working disks of h1 cannot be reused/);
  // Both current: the identity check passes and the stand-in disks fail the later file checks.
  await assert.rejects(snapshot.validateArchiveSession(archive([host({disks: ['raw', 'vdi'], baseImages: identities})]), stage),
    error => !/changed since this session was saved|Invalid base image identity/.test(error.message));
  // A vdi disk without the base .vdi on this machine cannot be reused.
  fs.rmSync(path.join(dir, 'base.raw.vdi'));
  await assert.rejects(snapshot.validateArchiveSession(archive([host({disks: ['vdi'], baseImages: {vdi: identities.vdi}})]), stage),
    /is not installed on this server \(VirtualBox format\); working disks of h1 cannot be reused/);
});

test('baseImages must match the disks of the archive, key by key, and be well formed', async t => {
  const {snapshot, host, archive, stage, size, rawSha} = setup(t);
  const check = (disks, baseImages) => snapshot.validateArchiveSession(archive([host({disks, ...(baseImages ? {baseImages} : {})})]), stage);
  await assert.rejects(check(['raw'], null), /Invalid base image identity for h1/);
  await assert.rejects(check([], {raw: {size, sha256: rawSha}}), /Invalid base image identity for h1/);
  await assert.rejects(check(['raw', 'vdi'], {raw: {size, sha256: rawSha}}), /Invalid base image identity for h1/);
  await assert.rejects(check(['raw'], {vdi: {size, sha256: rawSha}}), /Invalid base image identity for h1/);
  await assert.rejects(check(['raw'], {raw: {size, sha256: 'not a digest'}}), /Invalid base image identity for h1/);
  await assert.rejects(check(['raw'], {raw: {size: 'big', sha256: ZERO}}), /Invalid base image identity for h1/);
  await assert.rejects(check(['raw'], {raw: {size, sha256: ZERO, extra: 1}}), /Invalid base image identity for h1/);
  await assert.rejects(check(['raw'], {raw: {format: 'raw', size, sha256: ZERO}}), /Invalid base image identity for h1/);
});

test('archivedSessionFiles reads format 2, computes the disks from the members and refuses format 1 and a disks key', t => {
  const {snapshot, stage, host, size} = setup(t);
  const baseImages = {raw: {size, sha256: ZERO}, vdi: {size: 1, sha256: ZERO}};
  const write = data => {
    fs.writeFileSync(path.join(stage, 'session.json'), JSON.stringify({schemaVersion: 1, engine: 'qemu', hosts: [HOST], switches: []}));
    fs.writeFileSync(path.join(stage, HOST, 'host.json'), JSON.stringify(data));
  };
  const {disks, ...plain} = host();
  write({...plain, baseImages});
  const base = ['session.json', `${HOST}/host.json`];
  assert.deepEqual(snapshot.archivedSessionFiles(stage, base).hosts[0].disks, []);
  assert.deepEqual(snapshot.archivedSessionFiles(stage, [...base, `${HOST}/disk.vdi`]).hosts[0].disks, ['vdi']);
  assert.deepEqual(snapshot.archivedSessionFiles(stage, [...base, `${HOST}/disk.qcow2`, `${HOST}/disk.vdi`]).hosts[0].disks, ['raw', 'vdi']);
  assert.deepEqual(snapshot.archivedSessionFiles(stage, base).hosts[0].baseImages, baseImages);
  write({...plain, schemaVersion: 1});
  assert.throws(() => snapshot.archivedSessionFiles(stage, base), /Invalid configuration for h-0123456789abcdef/);
  write({...plain, disks: ['raw']});
  assert.throws(() => snapshot.archivedSessionFiles(stage, base), /Invalid configuration for h-0123456789abcdef/);
});

test('discardDisks ignores every working disk, even when the base images are unchanged', async t => {
  const {snapshot, host, archive, stage, size, rawSha, vdiSize, vdiSha} = setup(t);
  const current = {raw: {size, sha256: rawSha}, vdi: {size: vdiSize, sha256: vdiSha}};
  // The stand-in disks are no overlays: kept, they fail the file checks that follow the identity check.
  await assert.rejects(snapshot.validateArchiveSession(archive([host({disks: ['raw', 'vdi'], baseImages: current})]), stage),
    error => !/changed since this session was saved/.test(error.message));
  assert.equal(fs.existsSync(path.join(stage, HOST, 'disk.qcow2')), true);

  const discarded = archive([host({disks: ['raw', 'vdi'], baseImages: current})]);
  const warnings = await snapshot.validateArchiveSession(discarded, stage, {discardDisks: true});
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].hosts, [HOST]);
  assert.match(warnings[0].message, /Working disks of h1 were discarded/);
  assert.deepEqual(discarded.hosts[0].disks, []);
  assert.equal(fs.existsSync(path.join(stage, HOST, 'disk.qcow2')), false);
  assert.equal(fs.existsSync(path.join(stage, HOST, 'disk.vdi')), false);
});

test('discardDisks does not need a valid base image identity and ignores archives without disks', async t => {
  const {snapshot, host, archive, stage} = setup(t);
  const broken = archive([host({disks: ['raw'], baseImages: {raw: {size: 1}}})]);
  await assert.rejects(snapshot.validateArchiveSession(broken, stage), /Invalid base image identity for h1/);
  assert.equal((await snapshot.validateArchiveSession(broken, stage, {discardDisks: true})).length, 1);
  assert.deepEqual(await snapshot.validateArchiveSession(archive([host()]), stage, {discardDisks: true}), []);
});
