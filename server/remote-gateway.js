'use strict';

// Where remote runners reach the server: a WebSocket on the HTTP server, path /runner/connect
// (nginx terminates TLS and passes the upgrade; the Node server stays on 127.0.0.1). The frame
// protocol of common/runner-protocol.js runs unchanged over it (the `ws` duplex stream).
// The runner dials out with `Authorization: Bearer <authToken>` and `X-Runner-Id: <id>`; the
// token is checked against the hash in runners.json (server/runner-store.js) before the upgrade:
//   401  unknown runner, wrong token or revoked token (the runner stops retrying)
//   409  this runner is already connected (one live connection per runner ID)
// Nobody is trusted by transport: what a runner may do is decided by its record (server/runner-store.js).
// The local runner (id "local") comes through this same path, from 127.0.0.1, with the token of the file
// the server created (server/local-runner-token.js). The server listens on 127.0.0.1 behind nginx or Apache,
// which reach it from 127.0.0.1 too: the address proves nothing, so the TOKEN is the only proof. The id "local"
// is accepted only when the server runs with --local-runner, only with the token that matches the in-memory hash
// (constant time), and never through store.verify() (the record has no token hash); a revoked or forgotten record
// is refused (401) and nothing un-revokes it but the administrator.
// Only the path /runner/connect is handled here; Socket.IO keeps its own upgrades. Both ends
// ping every 15 seconds and drop a connection that stops answering (common/ws-heartbeat.js).
const WebSocket = require('ws');
const {Connection} = require('../common/runner-protocol');
const {keepAlive} = require('../common/ws-heartbeat');
const {RunnerClient} = require('./runner-client');
const {LOCAL_ID} = require('./runner-store');

const CONNECT_PATH = '/runner/connect';
const MAX_ADDRESS = 64;

function reject(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

// The remote end shown to administrators: the proxy's X-Forwarded-For only when the server is
// configured to trust a proxy.
function remoteAddress(req, trustProxy) {
  const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return (forwarded || req.socket.remoteAddress || '').replace(/[^0-9A-Za-z.:%[\]-]/g, '').slice(0, MAX_ADDRESS) || null;
}

function bearerToken(req) {
  const match = /^Bearer (\S{1,256})$/.exec(String(req.headers.authorization || ''));
  return match ? match[1] : null;
}

// `localRunner`: {matches(token)} of server/local-runner-token.js, or null when the server has no --local-runner.
function createRemoteGateway({server, registry, store, trustProxy = false, localRunner = null}) {
  const sockets = new WebSocket.Server({noServer: true, maxPayload: 20 * 1024 * 1024});

  function accept(ws, record, address) {
    keepAlive(ws);
    const client = new RunnerClient(new Connection(WebSocket.createWebSocketStream(ws)));
    registry.add({id: record.id, client, name: record.name, paused: record.paused === true, registeredAt: Date.parse(record.createdAt) || 0, address});
  }

  let refusalLogged = false;
  // The record of the runner that presents this ID and token, else null.
  function authenticate(id, token) {
    if (id !== LOCAL_ID) return store.verify(id, token);
    if (!localRunner || !token || !localRunner.matches(token)) return null;
    const record = store.get(LOCAL_ID);
    if (!record || record.revoked) {
      if (!refusalLogged) console.log(`The local runner is ${record ? 'revoked' : 'forgotten'}: its connection is refused (forget the record in /admin if needed, then restart the server).`);
      refusalLogged = true;
      return null;
    }
    refusalLogged = false;
    return record;
  }

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) { return; }
    if (pathname !== CONNECT_PATH) return;
    socket.on('error', () => {});
    const record = authenticate(String(req.headers['x-runner-id'] || ''), bearerToken(req));
    if (!record) return reject(socket, 401, 'Unauthorized');
    const current = registry.get(record.id);
    if (current && current.state !== 'lost') return reject(socket, 409, 'Conflict');
    sockets.handleUpgrade(req, socket, head, ws => accept(ws, record, remoteAddress(req, trustProxy)));
  });

  return {close() { for (const ws of sockets.clients) ws.terminate(); sockets.close(); }};
}

module.exports = {createRemoteGateway, CONNECT_PATH};
