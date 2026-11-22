'use strict';

// The outbound connection of a remote runner: a WebSocket to <server>/runner/connect, authenticated
// by `Authorization: Bearer <authToken>` and `X-Runner-Id`, carrying the frame protocol of
// common/runner-protocol.js unchanged (the `ws` duplex stream). The runner dials out, so it needs no
// inbound port. A lost connection is retried after 2 s, doubling up to 30 s (it keeps its machines
// meanwhile); both ends ping every 15 s and drop a connection that stops answering. The server
// refusing the token (401: unknown or revoked) ends the retries. The same code serves the registered remote runner
// and the local runner (runner/local-identity.js); only the way the token is obtained differs.
//   startRemote({url, runnerId, authToken, ca, onConnection, onLost, report, fatal, refusal})  -> {stop()}
//     authToken                 the token, or a function that returns it at EVERY attempt (the local runner re-reads its
//                               file, so a rotation needs no restart) and throws an Error when it is not available now
//                               (a missing file is a normal retry, never fatal)
//     onConnection(connection)  a new Connection, once the WebSocket is open (serve it)
//     onLost()                  an established connection ended (called before the retry is scheduled; stop() prevents it)
//     report(state, message)    waiting | token (not available now) | connected | lost | refused
//     fatal(message)            the server refused the token (401): no retry; only a network or server problem is retried
//     refusal                   the text of that message
//     delayFor(attempt)         the delay of a retry in ms (tests shorten it)
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

const REFUSAL = 'The server refused this runner: its token is unknown or revoked. Register it again with ./scripts/runner.sh register.';

function startRemote({url, runnerId, authToken, ca = null, onConnection, onLost = () => {}, report, fatal, refusal = REFUSAL, delayFor = retryDelay}) {
  const tokenNow = typeof authToken === 'function' ? authToken : () => authToken;
  const options = {handshakeTimeout: HANDSHAKE_MS, maxPayload: 20 * 1024 * 1024, ...(ca ? {ca: fs.readFileSync(ca)} : {})};
  let stopped = false;
  let attempt = 0;
  let timer = null;
  let current = null;

  function open() {
    timer = null;
    let token;
    try { token = tokenNow(); }
    catch (error) {
      report('token', `${error.message}; waiting for it, retrying…`);
      timer = setTimeout(open, delayFor(attempt++));
      return;
    }
    const ws = new WebSocket(url, {...options, headers: {Authorization: `Bearer ${token}`, 'X-Runner-Id': runnerId}});
    current = ws;
    let opened = false;
    let settled = false;
    const retry = () => {
      if (settled || stopped) return;
      settled = true;
      timer = setTimeout(open, delayFor(attempt++));
    };
    ws.on('error', error => { if (!opened && !settled) report('waiting', `Cannot reach the server (${error.message}); retrying…`); });
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      const status = response.statusCode;
      ws.terminate();
      if (status === 401) {
        // A token that changed since this attempt (a server restart that created a new file) is not a refusal: try again.
        let changed = false;
        try { changed = tokenNow() !== token; } catch (_) { changed = false; }
        if (changed) { report('refused', 'The token changed; retrying…'); retry(); }
        else { settled = true; fatal(refusal); }
      } else {
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
        onLost();
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

module.exports = {startRemote, REFUSAL, retryDelay, FIRST_RETRY_MS, MAX_RETRY_MS};
