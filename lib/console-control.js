'use strict';

// Exclusive console control: an administrator observing a session takes the keyboard of one
// of its nodes. While the lock is held, only its holder (the admin's socket) may type into
// that node's console; the owner's input is refused. The lock is released by its holder
// (release-control), when the holder disconnects, when the node or the session is deleted, or
// after idleMs without input from the holder; never because the holder's pane shows another
// node. Typed text never goes through this module.
const CONTROL_IDLE_MS = 10 * 60 * 1000;

class ConsoleControl {
  // onRelease(lock, reason) runs once per released lock; lock is {sessionId, nodeId, admin, login, holder}.
  constructor({idleMs = CONTROL_IDLE_MS, onRelease = () => {}} = {}) {
    this.idleMs = idleMs;
    this.onRelease = onRelease;
    this.locks = new Map();
  }

  static key(sessionId, nodeId) { return `${sessionId}:${nodeId}`; }

  // The lock of a node, or null.
  get(sessionId, nodeId) { return this.locks.get(ConsoleControl.key(sessionId, nodeId)) || null; }

  // Takes the lock for `holder`, or renews it when the holder already has it. Returns true for
  // a new lock; throws when another holder has it.
  take(sessionId, nodeId, {admin, login, holder}) {
    const current = this.get(sessionId, nodeId);
    if (current && current.holder !== holder) throw new Error(`${current.admin} already controls this console.`);
    if (current) { this.touch(sessionId, nodeId, holder); return false; }
    const lock = {sessionId, nodeId, admin, login, holder, timer: null};
    this.locks.set(ConsoleControl.key(sessionId, nodeId), lock);
    this.arm(lock);
    return true;
  }

  // Restarts the idle timer when `holder` has the lock; returns whether it has it.
  touch(sessionId, nodeId, holder) {
    const lock = this.get(sessionId, nodeId);
    if (!lock || lock.holder !== holder) return false;
    this.arm(lock);
    return true;
  }

  arm(lock) {
    clearTimeout(lock.timer);
    lock.timer = setTimeout(() => this.release(lock.sessionId, lock.nodeId, lock.holder, 'idle'), this.idleMs);
    lock.timer.unref?.();
  }

  // Releases the lock of a node, if `holder` has it (any holder when holder is null).
  release(sessionId, nodeId, holder, reason) {
    const lock = this.get(sessionId, nodeId);
    if (!lock || (holder !== null && lock.holder !== holder)) return false;
    clearTimeout(lock.timer);
    this.locks.delete(ConsoleControl.key(sessionId, nodeId));
    const {timer, ...released} = lock;
    this.onRelease(released, reason);
    return true;
  }

  releaseHolder(holder, reason) {
    for (const lock of [...this.locks.values()]) if (lock.holder === holder) this.release(lock.sessionId, lock.nodeId, holder, reason);
  }

  releaseSession(sessionId, reason) {
    for (const lock of [...this.locks.values()]) if (lock.sessionId === sessionId) this.release(sessionId, lock.nodeId, null, reason);
  }
}

module.exports = {ConsoleControl, CONTROL_IDLE_MS};
