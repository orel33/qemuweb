'use strict';

// QemuWeb ZIP v1: UTF-8 files, data descriptors, Deflate for QCOW2 payloads,
// ZIP64 entry sizes when necessary, and a 32-bit archive/central directory.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const {Readable, Transform, Writable} = require('stream');
const {pipeline} = require('stream/promises');
const CHUNK = 1024 * 1024;
const MAX32 = 0xffffffff;
const MAX_LOGICAL_DISK = 64 * 1024 * 1024 * 1024;
const MAX_LOGICAL_TOTAL = 256 * 1024 * 1024 * 1024;
const crcTable = Array.from({length: 256}, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  return c >>> 0;
});
function crc32(buffer, start = 0xffffffff) {
  let c = start;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return c >>> 0;
}
function safeName(name) {
  if (typeof name !== 'string' || !name || name.length > 512 || name.includes('\\') ||
      name.startsWith('/') || /[\x00-\x1f\x7f]/.test(name) ||
      name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe archive path: ${name}`);
  return name;
}
function exactRead(fd, size, offset) {
  const buffer = Buffer.alloc(size);
  let done = 0;
  while (done < size) {
    const count = fs.readSync(fd, buffer, done, size - done, offset + done);
    if (!count) throw new Error('Truncated session archive.');
    done += count;
  }
  return buffer;
}
function put(fd, buffer) {
  let done = 0;
  while (done < buffer.length) done += fs.writeSync(fd, buffer, done, buffer.length - done);
}
function putAt(fd, buffer, offset) {
  let done = 0;
  while (done < buffer.length) done += fs.writeSync(fd, buffer, done, buffer.length - done, offset + done);
}
function zip64Extra(size, compressed) {
  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(1, 0); extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(BigInt(size), 4); extra.writeBigUInt64LE(BigInt(compressed), 12);
  return extra;
}
async function writeArchive(destination, sources, manifestData) {
  if (!Array.isArray(sources) || sources.length + 1 > 10000) throw new Error('Too many session archive files.');
  const fd = fs.openSync(destination, 'wx', 0o600);
  const records = [], inventory = [];
  let offset = 0;
  function append(buffer) { put(fd, buffer); offset += buffer.length; if (offset > MAX32) throw new Error('Session archive exceeds ZIP v1 total size limit (4 GiB).'); }
  async function add(name, source) {
    safeName(name);
    if (records.some(item => item.name === name)) throw new Error(`Duplicate archive path: ${name}`);
    const data = Buffer.isBuffer(source) ? source : null;
    const stat = data ? null : fs.lstatSync(source);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`Not a regular file: ${source}`);
    const size = data ? data.length : stat.size;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid archive file size: ${name}`);
    if (name.endsWith('/disk.qcow2') && size > MAX_LOGICAL_DISK) throw new Error('QCOW2 logical size exceeds 64 GiB limit.');
    const zip64 = size >= MAX32;
    const method = name.endsWith('/disk.qcow2') ? 8 : 0;
    const flags = 0x0808; // UTF-8 + data descriptor.
    const nameBytes = Buffer.from(name, 'utf8');
    const extra = zip64 ? zip64Extra(size, 0) : Buffer.alloc(0);
    const localOffset = offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(zip64 ? MAX32 : 0, 18); header.writeUInt32LE(zip64 ? MAX32 : 0, 22);
    header.writeUInt16LE(nameBytes.length, 26); header.writeUInt16LE(extra.length, 28);
    append(header); append(nameBytes); append(extra);
    const start = offset;
    let crc = 0xffffffff, copied = 0;
    const hash = crypto.createHash('sha256');
    const tap = new Transform({transform(chunk, _encoding, callback) {
      copied += chunk.length; crc = crc32(chunk, crc); hash.update(chunk); callback(null, chunk);
    }});
    const sink = new Writable({write(chunk, _encoding, callback) {
      try { append(chunk); callback(); } catch (error) { callback(error); }
    }});
    const input = data ? Readable.from([data]) : fs.createReadStream(source, {highWaterMark: CHUNK});
    if (method === 8) await pipeline(input, tap, zlib.createDeflateRaw({level: 6}), sink);
    else await pipeline(input, tap, sink);
    if (copied !== size || stat && fs.statSync(source).size !== size) throw new Error(`File changed during archive creation: ${name}`);
    const compressed = offset - start;
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(zip64 ? 24 : 16);
    descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc, 4);
    if (zip64) { descriptor.writeBigUInt64LE(BigInt(compressed), 8); descriptor.writeBigUInt64LE(BigInt(size), 16); }
    else { descriptor.writeUInt32LE(compressed, 8); descriptor.writeUInt32LE(size, 12); }
    append(descriptor);
    records.push({name, nameBytes, size, compressed, crc, localOffset, method, flags, zip64});
    return {path: name, size, sha256: hash.digest('hex')};
  }
  try {
    for (const item of sources) inventory.push(await add(item.name, item.file));
    const manifest = {...manifestData, files: inventory};
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    if (manifestBytes.length > 4 * 1024 * 1024) throw new Error('Session manifest exceeds 4 MiB limit.');
    await add('manifest.json', manifestBytes);
    const centralOffset = offset;
    for (const item of records) {
      const extra = item.zip64 ? zip64Extra(item.size, item.compressed) : Buffer.alloc(0);
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(item.zip64 ? 0x032d : 0x0314, 4);
      h.writeUInt16LE(item.zip64 ? 45 : 20, 6); h.writeUInt16LE(item.flags, 8); h.writeUInt16LE(item.method, 10);
      h.writeUInt32LE(item.crc, 16);
      h.writeUInt32LE(item.zip64 ? MAX32 : item.compressed, 20);
      h.writeUInt32LE(item.zip64 ? MAX32 : item.size, 24);
      h.writeUInt16LE(item.nameBytes.length, 28); h.writeUInt16LE(extra.length, 30);
      h.writeUInt32LE(0o100600 << 16, 38); h.writeUInt32LE(item.localOffset, 42);
      append(h); append(item.nameBytes); append(extra);
    }
    const centralSize = offset - centralOffset;
    if (records.length > 65535) throw new Error('Too many session archive files.');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(records.length, 8);
    end.writeUInt16LE(records.length, 10); end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16); append(end);
    return {manifest, bytes: offset};
  } catch (error) { fs.rmSync(destination, {force: true}); throw error; }
  finally { fs.closeSync(fd); }
}
function parseZip64(extra) {
  if (extra.length !== 20 || extra.readUInt16LE(0) !== 1 || extra.readUInt16LE(2) !== 16) throw new Error('Invalid ZIP64 entry size.');
  const size = Number(extra.readBigUInt64LE(4)), compressed = Number(extra.readBigUInt64LE(12));
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(compressed)) throw new Error('ZIP64 entry is too large.');
  return {size, compressed};
}
function writeSparse(fd, buffer, offset) {
  for (let p = 0; p < buffer.length; p += 4096) {
    const block = buffer.subarray(p, Math.min(p + 4096, buffer.length));
    if (block.some(byte => byte !== 0)) putAt(fd, block, offset + p);
  }
}
async function readArchive(filename, stage) {
  const fd = fs.openSync(filename, 'r');
  try {
    const length = fs.fstatSync(fd).size;
    if (length < 22 || length > MAX32) throw new Error('Invalid session ZIP size.');
    const tailSize = Math.min(length, 65557);
    const tail = exactRead(fd, tailSize, length - tailSize);
    let endAt = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { endAt = i; break; }
    if (endAt < 0) throw new Error('Missing ZIP end record.');
    const end = tail.subarray(endAt);
    if (end.readUInt16LE(4) || end.readUInt16LE(6) || end.readUInt16LE(8) !== end.readUInt16LE(10)) throw new Error('Multi-volume ZIP archives are unsupported.');
    const count = end.readUInt16LE(10), centralSize = end.readUInt32LE(12), centralOffset = end.readUInt32LE(16);
    if (count > 10000 || centralSize > count * (46 + 512 + 20) || centralOffset + centralSize !== length - tailSize + endAt) throw new Error('Invalid ZIP directory.');
    const central = exactRead(fd, centralSize, centralOffset);
    const entries = new Map(), spans = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > central.length || central.readUInt32LE(p) !== 0x02014b50) throw new Error('Invalid ZIP entry.');
      const flags = central.readUInt16LE(p + 8), method = central.readUInt16LE(p + 10), crc = central.readUInt32LE(p + 16);
      let compressed = central.readUInt32LE(p + 20), size = central.readUInt32LE(p + 24);
      const n = central.readUInt16LE(p + 28), extraLength = central.readUInt16LE(p + 30), comment = central.readUInt16LE(p + 32);
      const external = central.readUInt32LE(p + 38), localOffset = central.readUInt32LE(p + 42);
      if (flags !== 0x0808 || ![0, 8].includes(method) || comment || (external >>> 16 & 0o170000) !== 0o100000 ||
          p + 46 + n + extraLength > central.length) throw new Error('Unsupported or unsafe ZIP entry.');
      const rawName = central.subarray(p + 46, p + 46 + n);
      const name = rawName.toString('utf8');
      if (!Buffer.from(name).equals(rawName)) throw new Error('Invalid UTF-8 ZIP path.');
      safeName(name);
      if (method === 8 && !name.endsWith('/disk.qcow2')) throw new Error('Only working disks may be compressed.');
      if (entries.has(name)) throw new Error(`Duplicate archive path: ${name}`);
      const zip64 = compressed === MAX32 || size === MAX32;
      const extra = central.subarray(p + 46 + n, p + 46 + n + extraLength);
      if (zip64) {
        if (compressed !== MAX32 || size !== MAX32) throw new Error('Invalid ZIP64 entry size.');
        ({size, compressed} = parseZip64(extra));
      } else if (extraLength) throw new Error('Unexpected ZIP extra field.');
      if (method === 0 && compressed !== size) throw new Error('Stored ZIP entry size mismatch.');
      const local = exactRead(fd, 30, localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method) throw new Error('ZIP headers disagree.');
      const localName = exactRead(fd, local.readUInt16LE(26), localOffset + 30);
      if (!localName.equals(rawName)) throw new Error('ZIP entry path mismatch.');
      const localExtra = exactRead(fd, local.readUInt16LE(28), localOffset + 30 + localName.length);
      if (zip64) {
        const values = parseZip64(localExtra);
        if (values.size !== size || values.compressed !== 0 || local.readUInt32LE(18) !== MAX32 || local.readUInt32LE(22) !== MAX32) throw new Error('ZIP64 local header mismatch.');
      } else if (localExtra.length || local.readUInt32LE(18) || local.readUInt32LE(22)) throw new Error('ZIP local header mismatch.');
      const dataOffset = localOffset + 30 + localName.length + localExtra.length;
      const descriptorOffset = dataOffset + compressed;
      const descriptor = exactRead(fd, zip64 ? 24 : 16, descriptorOffset);
      if (descriptor.readUInt32LE(0) !== 0x08074b50 || descriptor.readUInt32LE(4) !== crc ||
          (zip64 ? Number(descriptor.readBigUInt64LE(8)) !== compressed || Number(descriptor.readBigUInt64LE(16)) !== size
            : descriptor.readUInt32LE(8) !== compressed || descriptor.readUInt32LE(12) !== size)) throw new Error('ZIP data descriptor mismatch.');
      const endOffset = descriptorOffset + descriptor.length;
      if (endOffset > centralOffset) throw new Error('ZIP entry overlaps directory.');
      spans.push([localOffset, endOffset]);
      entries.set(name, {size, compressed, crc, dataOffset, method});
      p += 46 + n + extraLength;
    }
    spans.sort((a, b) => a[0] - b[0]);
    if (spans[0]?.[0] !== 0) throw new Error('Invalid ZIP entry layout.');
    for (let i = 1; i < spans.length; i++) if (spans[i][0] !== spans[i - 1][1]) throw new Error('Overlapping or hidden ZIP entries.');
    if (spans.at(-1)?.[1] !== centralOffset || p !== central.length || !entries.has('manifest.json')) throw new Error('Invalid session ZIP directory.');
    const logicalTotal = [...entries.values()].reduce((sum, item) => sum + item.size, 0);
    if (logicalTotal > MAX_LOGICAL_TOTAL || [...entries].some(([name, item]) => name.endsWith('/disk.qcow2') && item.size > MAX_LOGICAL_DISK)) throw new Error('Session archive logical disk size exceeds supported limit.');
    async function consume(name, destination, expected) {
      const item = entries.get(name);
      if (!item) throw new Error(`Missing archive file: ${name}`);
      if (expected && item.size !== expected.size) throw new Error(`File size mismatch: ${name}`);
      const hash = crypto.createHash('sha256');
      let crc = 0xffffffff, copied = 0;
      const output = destination ? fs.openSync(destination, 'wx', 0o600) : null;
      const chunks = destination ? null : [];
      const sparse = !!destination && name.endsWith('/disk.qcow2');
      let input = item.compressed ? fs.createReadStream(filename, {start: item.dataOffset, end: item.dataOffset + item.compressed - 1, highWaterMark: CHUNK}) : Readable.from([]);
      if (item.method === 8) {
        const inflator = zlib.createInflateRaw();
        input.on('error', error => inflator.destroy(error));
        input = input.pipe(inflator);
      }
      try {
        for await (const part of input) {
          if (copied + part.length > item.size) throw new Error(`ZIP file size mismatch: ${name}`);
          if (output !== null) {
            if (sparse) writeSparse(output, part, copied);
            else put(output, part);
          } else chunks.push(part);
          hash.update(part); crc = crc32(part, crc); copied += part.length;
        }
        if (output !== null && sparse) fs.ftruncateSync(output, item.size);
      } finally { if (output !== null) fs.closeSync(output); }
      if (copied !== item.size || ((crc ^ 0xffffffff) >>> 0) !== item.crc ||
          expected && hash.digest('hex') !== expected.sha256) throw new Error(`Checksum mismatch: ${name}`);
      return chunks ? Buffer.concat(chunks) : undefined;
    }
    if (entries.get('manifest.json').size > 4 * 1024 * 1024 || entries.get('manifest.json').method !== 0) throw new Error('Invalid session manifest entry.');
    const manifest = JSON.parse((await consume('manifest.json')).toString('utf8'));
    if (!manifest || manifest.format !== 'qemuweb-session' || manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Unsupported session archive version.');
    const expected = new Map();
    for (const item of manifest.files) {
      if (!item || typeof item !== 'object') throw new Error('Invalid manifest file inventory.');
      safeName(item.path);
      if (item.path === 'manifest.json' || expected.has(item.path) || !Number.isSafeInteger(item.size) || item.size < 0 || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error('Invalid manifest file inventory.');
      expected.set(item.path, item);
    }
    if (expected.size + 1 !== entries.size) throw new Error('Manifest file inventory does not match ZIP entries.');
    const required = [...expected].reduce((sum, [name, item]) => sum + (name.endsWith('/disk.qcow2') ? entries.get(name).compressed : item.size), 0);
    const free = fs.statfsSync(stage);
    if (required + 64 * 1024 * 1024 > free.bavail * free.bsize) throw new Error('Insufficient disk space to load session archive.');
    for (const [name, item] of expected) {
      const target = path.join(stage, name);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      await consume(name, target, item);
    }
    const after = fs.statfsSync(stage);
    if (after.bavail * after.bsize < 64 * 1024 * 1024) throw new Error('Insufficient disk space to finish session import.');
    return manifest;
  } finally { fs.closeSync(fd); }
}
module.exports = {writeArchive, readArchive, safeName};
