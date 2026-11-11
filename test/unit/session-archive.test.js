'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {writeArchive, readArchive, safeName} = require('../../session-archive');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-archive-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
function manifest() {
  return {format: 'qemuweb-session', version: 1, engine: 'qemu', hosts: [], switches: [], baseImages: {},
    view: {view: 'terminals', layoutSize: 1, showSwitchConsoles: true, graphicZoom: 1, positions: {}}};
}
test('session ZIP preserves bytes and validates its SHA-256 inventory', async t => {
  const dir = fixture(t), source = path.join(dir, 'source'), zip = path.join(dir, 'session.zip'), stage = path.join(dir, 'stage');
  fs.writeFileSync(source, Buffer.from([0, 1, 2, 255])); fs.mkdirSync(stage);
  const written = await writeArchive(zip, [{name: 'hosts/h-0123456789abcdef/startup/.env', file: source}], manifest());
  const loaded = await readArchive(zip, stage);
  assert.deepEqual(loaded, written.manifest);
  assert.deepEqual(fs.readFileSync(path.join(stage, 'hosts/h-0123456789abcdef/startup/.env')), Buffer.from([0, 1, 2, 255]));
});
test('session ZIP rejects modified payload and leaves staging as disposable data', async t => {
  const dir = fixture(t), source = path.join(dir, 'source'), zip = path.join(dir, 'session.zip'), stage = path.join(dir, 'stage');
  fs.writeFileSync(source, 'guest marker'); fs.mkdirSync(stage);
  await writeArchive(zip, [{name: 'hosts/h-0123456789abcdef/startup/marker', file: source}], manifest());
  const buffer = fs.readFileSync(zip);
  buffer[buffer.indexOf('guest marker')] ^= 1;
  fs.writeFileSync(zip, buffer);
  await assert.rejects(readArchive(zip, stage), /Checksum mismatch/);
});
test('session ZIP rejects symlink sources, unsafe and duplicate paths', async t => {
  const dir = fixture(t), source = path.join(dir, 'source'), link = path.join(dir, 'link');
  fs.writeFileSync(source, 'data'); fs.symlinkSync(source, link);
  assert.throws(() => safeName('../outside'), /Unsafe archive path/);
  await assert.rejects(writeArchive(path.join(dir, 'link.zip'), [{name: 'hosts/file', file: link}], manifest()), /regular file/);
  await assert.rejects(writeArchive(path.join(dir, 'duplicate.zip'), [
    {name: 'hosts/file', file: source}, {name: 'hosts/file', file: source}
  ], manifest()), /Duplicate archive path/);
});
test('session ZIP rejects unsupported manifest version', async t => {
  const dir = fixture(t), zip = path.join(dir, 'session.zip'), stage = path.join(dir, 'stage');
  fs.mkdirSync(stage);
  await writeArchive(zip, [], {...manifest(), version: 2});
  await assert.rejects(readArchive(zip, stage), /Unsupported session archive version/);
});

test('QCOW2 payload is compressed and restored as a sparse file', async t => {
  const dir = fixture(t), source = path.join(dir, 'disk.qcow2'), zip = path.join(dir, 'session.zip'), stage = path.join(dir, 'stage');
  const fd = fs.openSync(source, 'w');
  try {
    fs.writeSync(fd, Buffer.from('QCOW2 marker'), 0, 12, 0);
    fs.writeSync(fd, Buffer.from('end marker'), 0, 10, 8 * 1024 * 1024 - 10);
    fs.ftruncateSync(fd, 8 * 1024 * 1024);
  } finally { fs.closeSync(fd); }
  fs.mkdirSync(stage);
  await writeArchive(zip, [{name: 'hosts/h-0123456789abcdef/disk.qcow2', file: source}], manifest());
  assert.ok(fs.statSync(zip).size < 128 * 1024, 'sparse disk should compress to a small ZIP');
  await readArchive(zip, stage);
  const restored = path.join(stage, 'hosts/h-0123456789abcdef/disk.qcow2');
  assert.equal(fs.statSync(restored).size, 8 * 1024 * 1024);
  assert.ok(fs.statSync(restored).blocks * 512 < 128 * 1024, 'restored disk should remain sparse');
  const result = fs.openSync(restored, 'r');
  try {
    const head = Buffer.alloc(12), tail = Buffer.alloc(10);
    fs.readSync(result, head, 0, 12, 0); fs.readSync(result, tail, 0, 10, 8 * 1024 * 1024 - 10);
    assert.equal(head.toString(), 'QCOW2 marker'); assert.equal(tail.toString(), 'end marker');
  } finally { fs.closeSync(result); }
});
