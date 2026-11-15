'use strict';

// Signed session cookie: base64url(JSON {login, issued, expires}) + "." + HMAC-SHA256.
// The secret is generated once and kept in runtime/auth-secret (mode 0600); deleting it
// logs everybody out.
const crypto = require('crypto');
const fs = require('fs');

const COOKIE_NAME = 'qemuweb_session';

function loadSecret(file) {
  try {
    const secret = fs.readFileSync(file);
    if (secret.length >= 32) return secret;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const secret = crypto.randomBytes(32);
  try { fs.writeFileSync(file, secret, {mode: 0o600, flag: 'wx'}); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return fs.readFileSync(file);
  }
  return secret;
}

function mac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function signSession(secret, {login, issued, expires}) {
  const data = Buffer.from(JSON.stringify({login, issued, expires})).toString('base64url');
  return `${data}.${mac(secret, data)}`;
}

// Returns {login, issued, expires}, or null for a missing, forged or expired value.
function verifySession(secret, value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 1024) return null;
  const [data, signature, extra] = value.split('.');
  if (!data || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(secret, data));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); }
  catch (_) { return null; }
  if (!payload || typeof payload.login !== 'string' || !Number.isFinite(payload.expires) || !Number.isFinite(payload.issued)) return null;
  if (payload.expires <= now) return null;
  return payload;
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name || Object.hasOwn(cookies, name)) continue;
    try { cookies[name] = decodeURIComponent(part.slice(index + 1).trim()); }
    catch (_) { /* Ignore a malformed cookie. */ }
  }
  return cookies;
}

// Set-Cookie value; Secure only over HTTPS (directly or through a trusted proxy).
function sessionCookie(value, {maxAgeMs, secure}) {
  return [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`, ...(secure ? ['Secure'] : [])].join('; ');
}

module.exports = {COOKIE_NAME, loadSecret, signSession, verifySession, parseCookies, sessionCookie};
