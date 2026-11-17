'use strict';

// Password hashing with Node's built-in scrypt. A stored hash carries its own parameters
// and random salt: scrypt$<N>$<r>$<p>$<salt base64>$<key base64>.
const crypto = require('crypto');
const {promisify} = require('util');

const scrypt = promisify(crypto.scrypt);
const DEFAULTS = {N: 16384, r: 8, p: 1, keyLength: 64, saltLength: 16};
const HASH_PATTERN = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;

async function hashPassword(password, options = {}) {
  if (typeof password !== 'string' || !password) throw new Error('The password must not be empty.');
  const {N, r, p, keyLength, saltLength} = {...DEFAULTS, ...options};
  const salt = crypto.randomBytes(saltLength);
  const key = await scrypt(password.normalize('NFC'), salt, keyLength, {N, r, p, maxmem: 256 * N * r + 1024 * 1024});
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function isPasswordHash(value) {
  const match = typeof value === 'string' && HASH_PATTERN.exec(value);
  if (!match) return false;
  const [N, r, p] = match.slice(1, 4).map(Number);
  return N >= 2 && (N & (N - 1)) === 0 && N <= 1048576 && r >= 1 && r <= 32 && p >= 1 && p <= 16;
}

// Constant-time comparison; false for a malformed hash.
async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !isPasswordHash(stored)) return false;
  const [, N, r, p, salt, key] = HASH_PATTERN.exec(stored);
  const expected = Buffer.from(key, 'base64');
  if (!expected.length) return false;
  const actual = await scrypt(password.normalize('NFC'), Buffer.from(salt, 'base64'), expected.length,
    {N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * Number(N) * Number(r) + 1024 * 1024});
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = {hashPassword, verifyPassword, isPasswordHash};
