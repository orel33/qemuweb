'use strict';

// Registry of the live Socket.IO connections of the session namespace, with the transport each one
// really uses (`websocket` or `polling`), for the Connections panel of /admin and for the log line
// about connections stuck on polling. A UI socket asks for WebSocket first and falls back to
// polling; behind a reverse proxy that drops the Upgrade header everything still works, only
// slower, so nothing else would tell the administrator.
// An entry holds only {login, transport, since, main, observer}: no cookie, key, address or user agent.
// server/sockets.js calls track(socket, {login, main, observer}) once a connection is accepted.

// A connection still on polling this long after it connected is logged (once per login per WARN_EVERY_MS).
const POLLING_WARN_AFTER_MS = 20 * 1000;
const WARN_EVERY_MS = 10 * 60 * 1000;

const printable = text => String(text).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64);

// now() is the clock, timers {set, clear} the scheduler and warn(line) the log sink: all injected by tests.
function createTransportRegistry({now = Date.now, timers = {set: setTimeout, clear: clearTimeout}, warn = line => console.error(line)} = {}) {
  const entries = new Set();
  const lastWarned = new Map();

  function warnIfPolling(entry) {
    if (entry.transport !== 'polling') return;
    const time = now();
    for (const [login, at] of lastWarned) if (time - at >= WARN_EVERY_MS) lastWarned.delete(login);
    if (lastWarned.has(entry.login)) return;
    lastWarned.set(entry.login, time);
    warn(`[sockets] ${printable(entry.login)}: still on polling ${POLLING_WARN_AFTER_MS / 1000} s after connecting `
      + '(no WebSocket upgrade: check that the reverse proxy forwards Upgrade and Connection)');
  }

  return {
    track(socket, {login, main = false, observer = false}) {
      const entry = {login, transport: socket.conn.transport.name, since: new Date(now()).toISOString(), main: !!main, observer: !!observer};
      entries.add(entry);
      const timer = timers.set(() => warnIfPolling(entry), POLLING_WARN_AFTER_MS);
      timer?.unref?.();
      socket.conn.on('upgrade', transport => { entry.transport = transport.name; });
      socket.on('disconnect', () => {
        entries.delete(entry);
        timers.clear(timer);
      });
    },
    // {total, websocket, polling, items}: copies, oldest connection first.
    summary() {
      const items = [...entries].map(entry => ({...entry}));
      const polling = items.filter(item => item.transport === 'polling').length;
      return {total: items.length, websocket: items.filter(item => item.transport === 'websocket').length, polling, items};
    }
  };
}

module.exports = {createTransportRegistry, POLLING_WARN_AFTER_MS, WARN_EVERY_MS};
