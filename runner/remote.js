'use strict';

// The outbound connection of a remote runner: a WebSocket to <server>/runner/connect, authenticated
// by `Authorization: Bearer <authToken>` and `X-Runner-Id`, carrying the frame protocol of
// common/runner-protocol.js unchanged (the `ws` duplex stream). The runner dials out, so it needs no
// inbound port. A lost connection is retried after 2 s, doubling up to 30 s (it keeps its machines
// meanwhile); both ends ping every 15 s and drop a connection that stops answering. The server
// refusing the token (401: unknown or revoked) ends the retries.
//   startRemote({url, runnerId, authToken, ca, onConnection, report, fatal})  -> {stop()}
//     onConnection(connection)  a new Connection, once the WebSocket is open (serve it)
//     report(state, message)    waiting | connected | lost | refused
//     fatal(message)            the server refused the token: no retry
const fs = require('fs');
const WebSocket = require('ws');
const {Connection} = require('../common/runner-protocol');
const {keepAlive} = require('../common/ws-heartbeat');

const FIRST_RETRY_MS = 2000;
const MAX_RETRY_MS = 30000;
const HANDSHAKE_MS = 15000;

// Delay before attempt number `attempt` (0 for the first retry): 2 s, 4 s, ... 30 s.
function retryDelay(attempt) {
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** attempt);
}

function startRemote({url, runnerId, authToken, ca = null, onConnection, report, fatal}) {
  const headers = {Authorization: `Bearer ${authToken}`, 'X-Runner-Id': runnerId};
  const options = {headers, handshakeTimeout: HANDSHAKE_MS, maxPayload: 20 * 1024 * 1024, ...(ca ? {ca: fs.readFileSync(ca)} : {})};
  let stopped = false;
  let attempt = 0;
  let timer = null;
  let current = null;

  function open() {
    timer = null;
    const ws = new WebSocket(url, options);
    current = ws;
    let opened = false;
    let settled = false;
    const retry = () => {
      if (settled || stopped) return;
      settled = true;
      timer = setTimeout(open, retryDelay(attempt++));
    };
    ws.on('error', error => { if (!opened && !settled) report('waiting', `Cannot reach the server (${error.message}); retrying…`); });
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      const status = response.statusCode;
      ws.terminate();
      if (status === 401) { settled = true; fatal('The server refused this runner: its token is unknown or revoked. Register it again with ./scripts/runner.sh register.'); }
      else {
        report('refused', status === 409 ? 'The server already has a connection of this runner (the previous one may still be closing). Retrying…' : `The server answered HTTP ${status}. Retrying…`);
        retry();
      }
    });
    ws.once('close', () => { if (!opened) retry(); });
    ws.once('open', () => {
      opened = true;
      attempt = 0;
      keepAlive(ws);
      const connection = new Connection(WebSocket.createWebSocketStream(ws));
      connection.on('close', error => {
        if (stopped) return;
        report('lost', `Connection to the server lost${error ? ` (${error.message})` : ''}, reconnecting…`);
        settled = false;
        retry();
      });
      report('connected', 'Connected to the server.');
      onConnection(connection);
    });
  }

  open();
  return {stop() { stopped = true; clearTimeout(timer); if (current) current.terminate(); }};
}

module.exports = {startRemote, retryDelay, FIRST_RETRY_MS, MAX_RETRY_MS};
