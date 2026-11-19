'use strict';

// PCAP files written by QEMU's filter-dump: the length of the part made of whole packets.
const fs = require('fs');

const FILE_HEADER = 24;
const RECORD_HEADER = 16;
const MAX_PACKET = 0x40000;

// The byte length of the longest prefix of `file` (looking at its first `size` bytes only) that
// ends on a packet boundary; 0 when the file header is not complete or is not a PCAP. QEMU
// writes each packet with one write, but the file grows while it is read.
function completeLength(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(FILE_HEADER);
    if (size < FILE_HEADER || fs.readSync(fd, header, 0, FILE_HEADER, 0) < FILE_HEADER) return 0;
    const magic = header.readUInt32BE(0);
    const littleEndian = magic === 0xd4c3b2a1;
    if (!littleEndian && magic !== 0xa1b2c3d4) return 0;
    const record = Buffer.alloc(RECORD_HEADER);
    let offset = FILE_HEADER;
    for (;;) {
      if (offset + RECORD_HEADER > size || fs.readSync(fd, record, 0, RECORD_HEADER, offset) < RECORD_HEADER) return offset;
      const captured = littleEndian ? record.readUInt32LE(8) : record.readUInt32BE(8);
      if (captured > MAX_PACKET || offset + RECORD_HEADER + captured > size) return offset;
      offset += RECORD_HEADER + captured;
    }
  } finally { fs.closeSync(fd); }
}

module.exports = {completeLength};
