'use strict';

// Header of a VirtualBox VDI file, read to check a working disk loaded from an archive. Layout (all
// little-endian): 72 bytes of pre-header (64 bytes of text, signature 0xBEDA107F, version), then
// the header: size, image type (1 normal, 2 fixed, 3 undo, 4 differencing), flags, comment (256),
// offsets, geometry, disk size in bytes (u64), block sizes and counts, then four UUIDs: the
// image's, its modification, its parent's (link) and the parent's modification.
const fs = require('fs');

const SIGNATURE = 0xbeda107f;
const TYPE_DIFFERENCING = 4;
const HEADER_BYTES = 456; // up to the end of the parent UUID (offset 424 + 16 = 440), rounded

function uuidText(buffer) {
  // VirtualBox stores the first three fields little-endian, the rest as they are.
  const hex = Buffer.from([...buffer.subarray(0, 4)].reverse()).toString('hex') + '-' +
    Buffer.from([...buffer.subarray(4, 6)].reverse()).toString('hex') + '-' +
    Buffer.from([...buffer.subarray(6, 8)].reverse()).toString('hex') + '-' +
    buffer.subarray(8, 10).toString('hex') + '-' + buffer.subarray(10, 16).toString('hex');
  return hex;
}

// {type, size, uuid, parentUuid} of a VDI file; throws when the file is not a VDI.
function readVdiHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    if (fs.readSync(fd, buffer, 0, HEADER_BYTES, 0) < HEADER_BYTES) throw new Error('Not a VDI file.');
    if (buffer.readUInt32LE(64) !== SIGNATURE) throw new Error('Not a VDI file.');
    const size = buffer.readBigUInt64LE(368);
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid VDI size.');
    return {type: buffer.readUInt32LE(76), size: Number(size), uuid: uuidText(buffer.subarray(392, 408)),
      parentUuid: uuidText(buffer.subarray(424, 440))};
  } finally { fs.closeSync(fd); }
}

// Throws unless `disk` is a differencing VDI of the base VDI: same disk size, parent UUID of the base.
function checkVdiDisk(disk, base) {
  const header = readVdiHeader(disk), parent = readVdiHeader(base);
  if (header.type !== TYPE_DIFFERENCING || header.size !== parent.size || header.parentUuid !== parent.uuid) {
    throw new Error('Not a differencing VDI of the current base image.');
  }
  return header;
}

module.exports = {readVdiHeader, checkVdiDisk, SIGNATURE, TYPE_DIFFERENCING, HEADER_BYTES};
