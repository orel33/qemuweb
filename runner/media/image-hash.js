'use strict';

// SHA-256 of base images. Base images are large and rarely change: the digest is cached by file identity.
const fs = require('fs');
const crypto = require('crypto');

const sha256Cache = new Map();

function fileSha256(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`Base image is not a regular file: ${file}`);
  const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const cached = sha256Cache.get(file);
  if (cached?.key === key) return {size: stat.size, sha256: cached.sha256};
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    let offset = 0;
    while (offset < stat.size) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
      if (!count) throw new Error(`Base image changed while reading: ${file}`);
      hash.update(chunk.subarray(0, count)); offset += count;
    }
  } finally { fs.closeSync(fd); }
  const sha256 = hash.digest('hex');
  sha256Cache.set(file, {key, sha256});
  return {size: stat.size, sha256};
}

module.exports = {fileSha256};
