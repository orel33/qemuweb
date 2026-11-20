'use strict';

// The VDI header reader (runner/media/vdi.js) that checks a disk.vdi loaded from a session archive: it
// must be a differencing image of the current base .vdi (same disk size, parent UUID = the base's UUID).
// The files are synthetic headers; no VirtualBox is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {readVdiHeader, checkVdiDisk, SIGNATURE, TYPE_DIFFERENCING, HEADER_BYTES} = require('../../runner/media/vdi');

const BASE_UUID = '11111111-2222-3333-4444-555555555555';
const OTHER_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NIL = '00000000-0000-0000-0000-000000000000';

// The 16 bytes VirtualBox stores for a UUID text: the first three groups little-endian.
function uuidBytes(text) {
  const groups = text.split('-').map(group => Buffer.from(group, 'hex'));
  return Buffer.concat([Buffer.from(groups[0]).reverse(), Buffer.from(groups[1]).reverse(), Buffer.from(groups[2]).reverse(), groups[3], groups[4]]);
}

function vdi({type = 1, size = 4 * 1024 ** 3, uuid = BASE_UUID, parentUuid = NIL, signature = SIGNATURE} = {}) {
  const buffer = Buffer.alloc(512);
  buffer.write('<<< Oracle VM VirtualBox Disk Image >>>\n', 0, 'latin1');
  buffer.writeUInt32LE(signature, 64);
  buffer.writeUInt32LE(0x00010001, 68);
  buffer.writeUInt32LE(type, 76);
  buffer.writeBigUInt64LE(BigInt(size), 368);
  uuidBytes(uuid).copy(buffer, 392);
  uuidBytes(parentUuid).copy(buffer, 424);
  return buffer;
}

function files(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-vdi-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return Object.fromEntries(Object.entries(entries).map(([name, content]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return [name, file];
  }));
}

test('the header gives the type, the disk size and the UUIDs', t => {
  const {base} = files(t, {base: vdi()});
  assert.deepEqual(readVdiHeader(base), {type: 1, size: 4 * 1024 ** 3, uuid: BASE_UUID, parentUuid: NIL});
  assert.ok(HEADER_BYTES <= 512);
});

test('a file that is not a VDI is refused', t => {
  const f = files(t, {text: 'not a disk', short: Buffer.alloc(10), signature: vdi({signature: 1})});
  for (const name of ['text', 'short', 'signature']) assert.throws(() => readVdiHeader(f[name]), /Not a VDI file/, name);
});

test('a differencing disk of the base is accepted', t => {
  const f = files(t, {base: vdi(), disk: vdi({type: TYPE_DIFFERENCING, uuid: OTHER_UUID, parentUuid: BASE_UUID})});
  assert.equal(checkVdiDisk(f.disk, f.base).parentUuid, BASE_UUID);
});

test('a disk that is not a differencing image of this base is refused: type, size, parent', t => {
  const f = files(t, {
    base: vdi(),
    normal: vdi({type: 1, uuid: OTHER_UUID, parentUuid: BASE_UUID}),
    bigger: vdi({type: TYPE_DIFFERENCING, size: 5 * 1024 ** 3, uuid: OTHER_UUID, parentUuid: BASE_UUID}),
    orphan: vdi({type: TYPE_DIFFERENCING, uuid: OTHER_UUID, parentUuid: OTHER_UUID}),
    rebuilt: vdi({type: TYPE_DIFFERENCING, uuid: OTHER_UUID, parentUuid: NIL})
  });
  for (const name of ['normal', 'bigger', 'orphan', 'rebuilt']) {
    assert.throws(() => checkVdiDisk(f[name], f.base), /Not a differencing VDI of the current base image/, name);
  }
});
