'use strict';

// Cross-site request protection: a state-changing request (any method but GET, HEAD and
// OPTIONS) and the Socket.IO handshake must carry an Origin header naming this server,
// that is matching the Host header, or listed in QEMUWEB_ALLOWED_ORIGINS
// (comma-separated, e.g. https://qemuweb.example.org).

function parseAllowedOrigins(value) {
  return new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean).map(item => {
    let url;
    try { url = new URL(item); }
    catch (_) { throw new Error(`Invalid origin in QEMUWEB_ALLOWED_ORIGINS: ${item}`); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Invalid origin in QEMUWEB_ALLOWED_ORIGINS: ${item}`);
    return url.origin;
  }));
}

// origin: the Origin header; host: the Host header.
function originAllowed(origin, host, allowedOrigins = new Set()) {
  if (typeof origin !== 'string' || !origin || origin === 'null') return false;
  let url;
  try { url = new URL(origin); }
  catch (_) { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (allowedOrigins.has(url.origin)) return true;
  return typeof host === 'string' && !!host && url.host === host.toLowerCase();
}

function isSafeMethod(method) { return ['GET', 'HEAD', 'OPTIONS'].includes(method); }

module.exports = {parseAllowedOrigins, originAllowed, isSafeMethod};
