'use strict';

// Detects a dead WebSocket, as the control plane and a remote runner both need (a network cut
// leaves a TCP connection open for a long time): a ping every HEARTBEAT_MS, and the connection is
// terminated when the previous ping got no pong. Worst case, a cut is noticed after two periods.
// `ws` is the WebSocket object of the `ws` library; the returned function stops the timer
// (also stopped when the socket closes).
const HEARTBEAT_MS = 15000;

function keepAlive(ws, {intervalMs = HEARTBEAT_MS} = {}) {
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const timer = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    alive = false;
    try { ws.ping(); } catch (_) { ws.terminate(); }
  }, intervalMs);
  timer.unref();
  const stop = () => clearInterval(timer);
  ws.once('close', stop);
  return stop;
}

module.exports = {keepAlive, HEARTBEAT_MS};
