'use strict';
// Best-effort check, used by `prepare.sh --list`, of whether a Debian raw image enables the login on
// ttyS1 (serial-getty@ttyS1.service). The image is read offline and read-only with `debugfs -c -R`
// on the partition offset taken from its MBR or GPT: no root, no loop device, no mount, no write.
// The result is 'yes', 'no' or 'unknown' (debugfs missing, unreadable image, unexpected partition
// table, any error, or the time limit): it never throws.
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');

const ENABLED = '/etc/systemd/system/getty.target.wants/serial-getty@ttyS1.service'; // where `systemctl enable` links it
const ROOT_MARK = '/etc/os-release'; // present in the root filesystem, absent from an EFI or boot partition
const SECTOR = 512;
const MAX_PARTITIONS = 4;
const TIME_LIMIT_MS = 10000;

// Start offsets, in bytes, of the first partitions of a raw image (MBR, or GPT behind a protective MBR).
function partitionOffsets(fd) {
  const read = (position, length) => {
    const buffer = Buffer.alloc(length);
    return fs.readSync(fd, buffer, 0, length, position) === length ? buffer : null;
  };
  const mbr = read(0, SECTOR);
  if (!mbr || mbr.readUInt16LE(510) !== 0xaa55) return [];
  const offsets = [];
  if (mbr[446 + 4] === 0xee) {
    const header = read(SECTOR, 92);
    if (!header || header.toString('latin1', 0, 8) !== 'EFI PART') return [];
    const entries = Number(header.readBigUInt64LE(72)), size = header.readUInt32LE(84);
    if (size < 128 || size > 4096) return [];
    for (let index = 0; index < MAX_PARTITIONS; index++) {
      const entry = read(entries * SECTOR + index * size, 48);
      if (!entry) break;
      if (entry.subarray(0, 16).some(byte => byte)) offsets.push(Number(entry.readBigUInt64LE(32)) * SECTOR);
    }
  } else {
    for (let index = 0; index < MAX_PARTITIONS; index++) {
      const entry = read(446 + 16 * index, 16);
      if (entry && entry[4] !== 0) offsets.push(entry.readUInt32LE(8) * SECTOR);
    }
  }
  return offsets;
}

function ttys1Login(image, {timeoutMs = TIME_LIMIT_MS} = {}) {
  const deadline = Date.now() + timeoutMs;
  let fd;
  try {
    fd = fs.openSync(image, 'r');
    const offsets = partitionOffsets(fd);
    for (const offset of offsets) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return 'unknown';
      const stat = path => {
        const result = spawnSync('debugfs', ['-c', '-R', `stat ${path}`, `${image}?offset=${offset}`], {encoding: 'utf8', timeout: remaining, maxBuffer: 1 << 20});
        if (result.error || result.signal) throw result.error || new Error('debugfs timed out');
        return `${result.stdout}\n${result.stderr}`;
      };
      if (/Type: symlink/.test(stat(ENABLED))) return 'yes';
      // Not linked: "no" only on the root filesystem, any other partition is skipped.
      if (/Type: regular|Type: symlink/.test(stat(ROOT_MARK))) return 'no';
    }
  } catch { return 'unknown'; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* nothing to close */ } }
  return 'unknown';
}

// The text of the extra line of `prepare.sh --list`.
function describe(result, id) {
  if (result === 'yes') return 'ttyS1 login: yes';
  if (result === 'no') return `ttyS1 login: no (rebuild: bash scripts/prepare.sh --system ${id} --force)`;
  return 'ttyS1 login: unknown';
}

module.exports = {partitionOffsets, ttys1Login, describe};
