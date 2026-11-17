'use strict';

// Signed session cookie: base64url(JSON {login, issued, expires}) + "." + HMAC-SHA256.
// The secret is generated at every server start and kept in memory only: a restart makes the
// cookies of the previous run invalid, so every user has to log in again.
const crypto = require('crypto');

const COOKIE_NAME = 'qemuweb_session';

function newSecret() {
  return crypto.randomBytes(32);
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

module.exports = {COOKIE_NAME, newSecret, signSession, verifySession, parseCookies, sessionCookie};
