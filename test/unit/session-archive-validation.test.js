// Session archive validation: the identity of a base image (format, size, SHA-256) is recorded in the
// host.json of hosts with a working disk, since only those depend on it. No server and no emulator
// process is needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createRunner} = require('../../runner');
const {Session} = require('../../lib/session');
const {createSessionSnapshot} = require('../../lib/session-snapshot');
const {selectedProfile, profileHash} = require('../../common/system-config');

const root = path.join(__dirname, '..', '..');
const commands = {QEMU_IMG: 'qemu-img', QEMU_SYSTEM_X86_64: 'qemu-system-x86_64', GENISOIMAGE: 'genisoimage'};
const HOST = 'h-0123456789abcdef';
const ZERO = '0'.repeat(64);

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-archive-'));
  const image = path.join(dir, 'base.raw');
  fs.writeFileSync(image, 'base image content');
  const session = new Session({runtimeRoot: dir});
  const runner = createRunner({session, commands, root, runtimeRoot: dir, configPath: path.join(root, 'config.json')});
  t.after(() => { runner.stopResourceSampling(); fs.rmSync(dir, {recursive: true, force: true}); });
  // The base image of every system is a small temporary file, so that no real image is read.
  const stub = {...runner, imageById: id => ({...runner.imageById(id), images: {raw: image, vdi: `${image}.vdi`}}), imagePath: file => file};
  const snapshot = createSessionSnapshot({session, runner: stub, commands, emit() {}});
  const profile = selectedProfile(runner.readConfig(), 'debian13-legacy', 'qemu');
  const stage = path.join(dir, 'stage');
  fs.mkdirSync(path.join(stage, HOST), {recursive: true});
  const host = (extra = {}) => ({schemaVersion: 3, id: HOST, name: 'h1', system: 'debian13-legacy', engine: 'qemu',
    profileHash: profileHash(profile), config: profile.startupDiskEnabled === false ? {} : {startupDiskEnabled: false},
    network: {interfaces: []}, disk: false, ...extra});
  const archive = (hosts, extra = {}) => {
    const files = ['session.json', `${HOST}/host.json`, ...(hosts.some(item => item.disk) ? [`${HOST}/disk.qcow2`] : [])];
    if (hosts.some(item => item.disk)) fs.writeFileSync(path.join(stage, HOST, 'disk.qcow2'), 'disk');
    return {engine: 'qemu', hosts, switches: [], files, ...extra};
  };
  return {dir, stage, snapshot, host, archive, size: fs.statSync(image).size};
}

test('hosts without a working disk need no base image identity', async t => {
  const {snapshot, host, archive, stage} = setup(t);
  assert.deepEqual(await snapshot.validateArchiveSession(archive([host()]), stage), []);
});

test('a working disk whose base image changed is refused, or discarded on request', async t => {
  const {snapshot, host, archive, stage, size} = setup(t);
  const changed = {format: 'raw', size, sha256: ZERO};
  await assert.rejects(snapshot.validateArchiveSession(archive([host({disk: true, baseImage: changed})]), stage),
    /Base image debian13-legacy changed since this session was saved; working disks of h1 cannot be reused\. Enable "Discard working disks/);

  const discarded = archive([host({disk: true, baseImage: changed})]);
  const warnings = await snapshot.validateArchiveSession(discarded, stage, {discardStaleDisks: true});
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].system, 'debian13-legacy');
  assert.deepEqual(warnings[0].hosts, [HOST]);
  assert.match(warnings[0].message, /working disks of h1 were discarded/);
  assert.equal(discarded.hosts[0].disk, false);
  assert.equal(fs.existsSync(path.join(stage, HOST, 'disk.qcow2')), false);
});

test('a working disk needs a well-formed base image identity of the right format', async t => {
  const {snapshot, host, archive, stage, size} = setup(t);
  const check = baseImage => snapshot.validateArchiveSession(archive([host({disk: true, ...(baseImage ? {baseImage} : {})})]), stage);
  await assert.rejects(check(null), /Invalid base image identity for h1/);
  await assert.rejects(check({format: 'raw', size, sha256: 'not a digest'}), /Invalid base image identity for h1/);
  await assert.rejects(check({format: 'raw', size: 'big', sha256: ZERO}), /Invalid base image identity for h1/);
  await assert.rejects(check({format: 'raw', size, sha256: ZERO, extra: 1}), /Invalid base image identity for h1/);
  await assert.rejects(check({format: 'vdi', size, sha256: ZERO}), /Base image format incompatible: debian13-legacy/);
});

test('host.json may carry a baseImage', t => {
  const {snapshot, stage, host} = setup(t);
  const baseImage = {format: 'raw', size: 1, sha256: ZERO};
  fs.writeFileSync(path.join(stage, 'session.json'), JSON.stringify({schemaVersion: 4, engine: 'qemu', hosts: [HOST], switches: []}));
  fs.writeFileSync(path.join(stage, HOST, 'host.json'), JSON.stringify({...host(), baseImage}));
  const files = snapshot.archivedSessionFiles(stage, ['session.json', `${HOST}/host.json`]);
  assert.deepEqual(files.hosts[0].baseImage, baseImage);
  assert.equal(files.hosts[0].disk, false);
});
