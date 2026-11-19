'use strict';

// The identity given by the authenticating front end (for example Apache with mod_auth_openidc), for --auth proxy and
// --auth both. Apache sets X-Remote-User (and optionally X-User-DisplayName, X-User-Mail) and adds
// X-Proxy-Key, the secret it shares with the server (--proxy-key-file). The identity headers
// are trusted only on a request that carries the right key, whatever its address: the
// administrator's SSH tunnel reaches the same port from 127.0.0.1 without it.
const crypto = require('crypto');
const fs = require('fs');
const {LOGIN_PATTERN} = require('./users-store');

const KEY_HEADER = 'x-proxy-key';
const MIN_KEY_LENGTH = 16;
const MAX_KEY_LENGTH = 512;
// A refused key is logged at most this often, so that a client cannot flood users.log.
const REFUSAL_LOG_INTERVAL_MS = 10 * 1000;

// The first line of the key file. Throws an Error (with the cause) unless the file is readable,
// mode 0600 or stricter, and holds a key of 16 to 512 characters without spaces.
function readProxyKey(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${file} is not a regular file.`);
  if (stat.mode & 0o177) throw new Error(`${file} must be readable by its owner only (chmod 600): its mode is ${(stat.mode & 0o777).toString(8).padStart(4, '0')}.`);
  const key = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
    throw new Error(`${file} must hold the key on its first line: ${MIN_KEY_LENGTH} to ${MAX_KEY_LENGTH} characters, no space (openssl rand -hex 32).`);
  }
  return key;
}

// Constant-time comparison of two strings (their SHA-256 digests have the same length).
function sameKey(given, expected) {
  const digest = value => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

// Header values are decoded as Latin-1 by Node, while Apache forwards UTF-8: decode them again.
function textHeader(value, max) {
  if (typeof value !== 'string') return null;
  const text = Buffer.from(value, 'latin1').toString('utf8').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
  return text || null;
}

// store: the users store; userLog receives proxy-refused events; `now` is injected by tests only.
// resolve(headers) answers one of:
//   {status: 'none'}                          no X-Proxy-Key, or the key without X-Remote-User: no identity from the proxy
//   {status: 'refused', code, reason}         to answer with the HTTP status `code` (wrong key, invalid login, disabled account)
//   {status: 'ok', user: {login, role, via: 'proxy', displayName?, mail?}}
// A login that is not in users.json is a student; one that is has its role, and its "disabled" flag refuses it.
function createProxyIdentity({key, store, userLog = {record() {}}, now = Date.now}) {
  let lastRefusalLog = -Infinity;
  function refuse(code, reason, login) {
    const time = now();
    if (time - lastRefusalLog >= REFUSAL_LOG_INTERVAL_MS) {
      lastRefusalLog = time;
      userLog.record(login || '', 'proxy-refused', {reason});
    }
    return {status: 'refused', code, reason};
  }

  function resolve(headers) {
    const given = headers[KEY_HEADER];
    if (given === undefined) return {status: 'none'};
    if (typeof given !== 'string' || !sameKey(given, key)) return refuse(403, 'wrong proxy key');
    const login = headers['x-remote-user'];
    if (typeof login !== 'string' || !login) return {status: 'none', keyed: true};
    if (!LOGIN_PATTERN.test(login)) return refuse(403, 'invalid login');
    const account = store.get(login);
    if (account?.disabled) return refuse(403, 'account disabled', login);
    const user = {login, role: account ? account.role : 'student', via: 'proxy'};
    const displayName = textHeader(headers['x-user-displayname'], 100);
    const mail = textHeader(headers['x-user-mail'], 254);
    if (displayName) user.displayName = displayName;
    if (mail) user.mail = mail;
    return {status: 'ok', user};
  }

  // The account as it is now, for a connection opened earlier: the same rules as resolve().
  function current(login) {
    if (!LOGIN_PATTERN.test(login)) return null;
    const account = store.get(login);
    if (account?.disabled) return null;
    return {login, role: account ? account.role : 'student', via: 'proxy'};
  }

  return {resolve, current};
}

module.exports = {readProxyKey, createProxyIdentity, sameKey};
