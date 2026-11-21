'use strict';
// Best-effort checks, used by `prepare.sh --list`, of what a raw image contains: whether a Debian image enables
// the login on ttyS1 (serial-getty@ttyS1.service) and whether an image carries the QEMU guest agent with the
// QemuWeb allowlist (docs/guest-agent.md). The image is read offline and read-only with `debugfs -c -R` on the
// partition offset taken from its MBR or GPT: no root, no loop device, no mount, no write. Every result is
// 'unknown' (debugfs missing, unreadable image, unexpected partition table, any error, or the time limit of 10 s)
// when it cannot be established: nothing here ever throws.
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');

const ENABLED = '/etc/systemd/system/getty.target.wants/serial-getty@ttyS1.service'; // where `systemctl enable` links it
const ROOT_MARK = '/etc/os-release'; // present in the root filesystem, absent from an EFI or boot partition
// The guest agent binary: /usr/sbin on Debian, /usr/bin in the Alpine and OpenWrt packages (not verified on
// those two images: both places are tried), and the QemuWeb configuration written by the builds.
const AGENT_BINARIES = ['/usr/sbin/qemu-ga', '/usr/bin/qemu-ga'];
const AGENT_CONF = '/etc/qemu/qemu-ga.conf';
const ALLOW_LINE = /^[ \t]*allow-rpcs[ \t]*=[ \t]*\S/m;
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

// Runs visit({stat, cat}) on each of the first partitions, in order, until it returns a result; 'unknown' when
// none does, on any error or at the time limit. stat(path) and cat(path) are the text debugfs prints.
function scanPartitions(image, timeoutMs, visit) {
  const deadline = Date.now() + timeoutMs;
  let fd;
  try {
    fd = fs.openSync(image, 'r');
    for (const offset of partitionOffsets(fd)) {
      if (deadline - Date.now() <= 0) return 'unknown';
      const debugfs = request => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('debugfs timed out');
        const result = spawnSync('debugfs', ['-c', '-R', request, `${image}?offset=${offset}`], {encoding: 'utf8', timeout: remaining, maxBuffer: 1 << 20});
        if (result.error || result.signal) throw result.error || new Error('debugfs timed out');
        return result;
      };
      const stat = path => { const result = debugfs(`stat ${path}`); return `${result.stdout}\n${result.stderr}`; };
      const cat = path => debugfs(`cat ${path}`).stdout;
      const found = visit({stat, cat});
      if (found) return found;
    }
  } catch { return 'unknown'; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* nothing to close */ } }
  return 'unknown';
}

const isFile = text => /Type: regular|Type: symlink/.test(text);

function ttys1Login(image, {timeoutMs = TIME_LIMIT_MS} = {}) {
  return scanPartitions(image, timeoutMs, ({stat}) => {
    if (/Type: symlink/.test(stat(ENABLED))) return 'yes';
    // Not linked: "no" only on the root filesystem, any other partition is skipped.
    if (isFile(stat(ROOT_MARK))) return 'no';
    return null;
  });
}

// The guest agent of an image: 'restricted' (binary and the QemuWeb configuration with its allow-rpcs line),
// 'open' (binary, no such configuration: the agent would accept every command), 'none' (root filesystem
// without the binary) or 'unknown'.
function guestAgent(image, {timeoutMs = TIME_LIMIT_MS} = {}) {
  return scanPartitions(image, timeoutMs, ({stat, cat}) => {
    if (!isFile(stat(ROOT_MARK))) return null;
    if (!AGENT_BINARIES.some(binary => /Type: regular/.test(stat(binary)))) return 'none';
    return ALLOW_LINE.test(cat(AGENT_CONF)) ? 'restricted' : 'open';
  });
}

// The text of the extra line of `prepare.sh --list`.
function describe(result) {
  if (result === 'yes') return 'ttyS1 login: yes';
  if (result === 'no') return 'ttyS1 login: no';
  return 'ttyS1 login: unknown';
}

// The text of the guest agent line of `prepare.sh --list`.
function describeGuestAgent(result) {
  if (result === 'restricted') return 'guest agent: yes (restricted)';
  if (result === 'open') return 'guest agent: yes (NOT restricted)';
  if (result === 'none') return 'guest agent: no';
  return 'guest agent: unknown';
}

module.exports = {partitionOffsets, ttys1Login, guestAgent, describe, describeGuestAgent};
