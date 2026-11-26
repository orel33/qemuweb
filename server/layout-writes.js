'use strict';

// Bounds on the node-position events of the Graphic view (server/sockets.js), so that a page or a
// script cannot flood the runner with disk writes:
//   createEventBudget  at most `max` events per `windowMs` for one socket; the excess is dropped;
//   createLayoutWriter the final positions of one session, coalesced: the latest position of each
//                      node is kept, and sent with layout.set at most once per `intervalMs` (the
//                      last one is always delivered).

function createEventBudget({max = 20, windowMs = 1000, now = Date.now} = {}) {
  let start = -Infinity;
  let count = 0;
  return {
    take() {
      const time = now();
      if (time - start >= windowMs) { start = time; count = 0; }
      if (count >= max) return false;
      count += 1;
      return true;
    }
  };
}

// write(nodeId, {x, y}) sends one position (a promise; a failure is ignored: the node may have
// been removed meanwhile). onIdle() is called when nothing is pending any more.
function createLayoutWriter({write, intervalMs = 250, onIdle = () => {}, setTimer = setTimeout}) {
  const pending = new Map();
  let timer = null;
  let flushing = false;
  async function flush() {
    timer = null;
    flushing = true;
    const batch = [...pending];
    pending.clear();
    for (const [nodeId, position] of batch) {
      try { await write(nodeId, position); } catch (_) { /* A removed node, or the runner is offline. */ }
    }
    flushing = false;
    if (pending.size) schedule(); else onIdle();
  }
  function schedule() {
    if (timer === null && !flushing) timer = setTimer(flush, intervalMs);
  }
  return {
    set(nodeId, position) {
      pending.set(nodeId, position);
      schedule();
    },
    get pending() { return pending.size; }
  };
}

module.exports = {createEventBudget, createLayoutWriter};
