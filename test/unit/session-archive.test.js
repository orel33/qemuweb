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
  const session = path.join(dir, 'session.json');
  fs.writeFileSync(session, '{"schemaVersion":4,"engine":"qemu","hosts":[],"switches":[],"baseImages":{}}\n');
  return {dir, session};
}
const host = 'h-0123456789abcdef';

test('session ZIP mirrors the durable runtime paths and preserves bytes', async t => {
  const {dir, session} = fixture(t);
  const source = path.join(dir, 'source'), zip = path.join(dir, 'session.zip'), stage = path.join(dir, 'stage');
  fs.writeFileSync(source, Buffer.from([0, 1, 2, 255])); fs.mkdirSync(stage);
  const names = await writeArchive(zip, [
    {name: 'session.json', file: session}, {name: `${host}/startup/.env`, file: source}
  ]);
  assert.ok(names.bytes > 0);
  assert.deepEqual(await readArchive(zip, stage), ['session.json', `${host}/startup/.env`]);
  assert.deepEqual(fs.readFileSync(path.join(stage, host, 'startup/.env')), Buffer.from([0, 1, 2, 255]));
  assert.equal(fs.readFileSync(path.join(stage, 'session.json'), 'utf8'), fs.readFileSync(session, 'utf8'));
});

test('session ZIP rejects modified payload', async t => {
  const {dir, session} = fixture(t);
  const source = path.join(dir, 'source'), zip = path.join(dir, 'session.zip'), stage = path.join(dir, 'stage');
  fs.writeFileSync(source, 'guest marker'); fs.mkdirSync(stage);
  await writeArchive(zip, [{name: 'session.json', file: session}, {name: `${host}/startup/marker`, file: source}]);
  const buffer = fs.readFileSync(zip);
  buffer[buffer.indexOf('guest marker')] ^= 1;
  fs.writeFileSync(zip, buffer);
  await assert.rejects(readArchive(zip, stage), /Checksum mismatch/);
});

test('session ZIP rejects symlink sources, unsafe and duplicate paths', async t => {
  const {dir, session} = fixture(t);
  const link = path.join(dir, 'link');
  fs.symlinkSync(session, link);
  assert.throws(() => safeName('../outside'), /Unsafe archive path/);
  await assert.rejects(writeArchive(path.join(dir, 'link.zip'), [{name: 'session.json', file: link}]), /regular file/);
  await assert.rejects(writeArchive(path.join(dir, 'duplicate.zip'), [
    {name: 'session.json', file: session}, {name: 'session.json', file: session}
  ]), /Duplicate archive path/);
});

test('session ZIP requires session.json', async t => {
  const {dir, session} = fixture(t), zip = path.join(dir, 'session.zip'), stage = path.join(dir, 'stage');
  fs.mkdirSync(stage);
  await writeArchive(zip, [{name: `${host}/host.json`, file: session}]);
  await assert.rejects(readArchive(zip, stage), /Invalid session ZIP directory/);
});

test('QCOW2 payload is compressed and restored as a sparse file', async t => {
  const {dir, session} = fixture(t), source = path.join(dir, 'disk.qcow2'), zip = path.join(dir, 'session.zip'), stage = path.join(dir, 'stage');
  const fd = fs.openSync(source, 'w');
  try {
    fs.writeSync(fd, Buffer.from('QCOW2 marker'), 0, 12, 0);
    fs.writeSync(fd, Buffer.from('end marker'), 0, 10, 8 * 1024 * 1024 - 10);
    fs.ftruncateSync(fd, 8 * 1024 * 1024);
  } finally { fs.closeSync(fd); }
  fs.mkdirSync(stage);
  await writeArchive(zip, [{name: 'session.json', file: session}, {name: `${host}/disk.qcow2`, file: source}]);
  assert.ok(fs.statSync(zip).size < 128 * 1024, 'sparse disk should compress to a small ZIP');
  await readArchive(zip, stage);
  const restored = path.join(stage, host, 'disk.qcow2');
  assert.equal(fs.statSync(restored).size, 8 * 1024 * 1024);
  assert.ok(fs.statSync(restored).blocks * 512 < 128 * 1024, 'restored disk should remain sparse');
  const result = fs.openSync(restored, 'r');
  try {
    const head = Buffer.alloc(12), tail = Buffer.alloc(10);
    fs.readSync(result, head, 0, 12, 0); fs.readSync(result, tail, 0, 10, 8 * 1024 * 1024 - 10);
    assert.equal(head.toString(), 'QCOW2 marker'); assert.equal(tail.toString(), 'end marker');
  } finally { fs.closeSync(result); }
});
