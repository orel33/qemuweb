'use strict';

// SHA-256 and size of base images, used to detect that an archive was saved on another image.
//
// Hashing a multi-gigabyte image takes seconds, so the digest is looked up in this order:
//   1. an in-memory cache keyed by the file identity (device, inode, size, modification time);
//   2. a hash file next to the image, `<image>.sha256`, written by `scripts/prepare.sh` in the
//      format of sha256sum ("<digest>  <file name>"). It is trusted only while it is not older than
//      the image: replacing or rebuilding the image makes it stale and it is ignored;
//   3. the digest computed from the file, without blocking the server in fileSha256Async.
// The server never writes next to the images: only prepare.sh does.
const fs = require('fs');
const crypto = require('crypto');

const HASH_FILE_SUFFIX = '.sha256';
const CHUNK = 1024 * 1024;
const sha256Cache = new Map();

const hashFilePath = file => `${file}${HASH_FILE_SUFFIX}`;

function imageStat(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`Base image is not a regular file: ${file}`);
  return stat;
}

const identity = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;

// The digest recorded in the hash file, or null when it is missing, malformed or older than the image.
function readHashFile(file, stat) {
  try {
    const hashStat = fs.statSync(hashFilePath(file));
    if (!hashStat.isFile() || hashStat.mtimeMs < stat.mtimeMs) return null;
    return /^([0-9a-f]{64})(?:\s|$)/.exec(fs.readFileSync(hashFilePath(file), 'utf8'))?.[1] ?? null;
  } catch (_) { return null; }
}

// Known digest from memory or the hash file, or null when it has to be computed.
function knownDigest(file, stat) {
  const key = identity(stat);
  const cached = sha256Cache.get(file);
  if (cached?.key === key) return cached.sha256;
  const recorded = readHashFile(file, stat);
  if (recorded) sha256Cache.set(file, {key, sha256: recorded});
  return recorded;
}

function remember(file, stat, sha256) {
  sha256Cache.set(file, {key: identity(stat), sha256});
  return {size: stat.size, sha256};
}

function computeSync(file, stat) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(CHUNK);
  try {
    let offset = 0;
    while (offset < stat.size) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
      if (!count) throw new Error(`Base image changed while reading: ${file}`);
      hash.update(chunk.subarray(0, count)); offset += count;
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

async function computeAsync(file, stat) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, {highWaterMark: CHUNK});
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  if (identity(fs.statSync(file)) !== identity(stat)) throw new Error(`Base image changed while reading: ${file}`);
  return hash.digest('hex');
}

// {size, sha256}. Blocks while the image is read when no digest is known: prefer fileSha256Async.
function fileSha256(file) {
  const stat = imageStat(file);
  return remember(file, stat, knownDigest(file, stat) ?? computeSync(file, stat));
}

// Same result as fileSha256, reading the image asynchronously so that the server stays responsive.
async function fileSha256Async(file) {
  const stat = imageStat(file);
  return remember(file, stat, knownDigest(file, stat) ?? await computeAsync(file, stat));
}

// {size, sha256} without reading the image: sha256 is null when no digest is known yet;
// null when the file is missing.
function knownImageIdentity(file) {
  let stat;
  try { stat = imageStat(file); } catch (_) { return null; }
  return {size: stat.size, sha256: knownDigest(file, stat)};
}

module.exports = {fileSha256, fileSha256Async, knownImageIdentity, hashFilePath};
