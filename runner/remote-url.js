'use strict';

// The server URL of a remote runner (--url, or the runner file): https:// anywhere, http:// (or ws://) only
// for this machine unless --insecure is given. Gives the HTTP address of the registration and the WebSocket address of
// the connection. http, https, ws and wss are accepted and normalised to the first two.
const {isLoopbackHostname} = require('../common/bind');

// {base, registerUrl, connectUrl, plain}: `plain` is true for an unencrypted URL that was allowed
// by --insecure (the caller prints a warning). Throws an Error with the reason otherwise.
function serverUrls(text, {insecure = false} = {}) {
  let url;
  try { url = new URL(text); }
  catch (_) { throw new Error(`Invalid server URL: ${text}`); }
  const protocol = {'http:': 'http:', 'ws:': 'http:', 'https:': 'https:', 'wss:': 'https:'}[url.protocol];
  if (!protocol) throw new Error(`Unsupported server URL scheme ${url.protocol} (use https://).`);
  if (url.username || url.password) throw new Error('The server URL must not contain a login or password.');
  const plain = protocol === 'http:';
  if (plain && !insecure && !isLoopbackHostname(url.hostname)) {
    throw new Error(`Refusing the unencrypted URL ${text}: the token and the traffic would be readable on the network. Use https://, or add --insecure.`);
  }
  const base = `${protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  return {base, registerUrl: `${base}/api/runner/register`, connectUrl: `${base.replace(/^http/, 'ws')}/runner/connect`, plain: plain && !isLoopbackHostname(url.hostname)};
}

module.exports = {serverUrls};
