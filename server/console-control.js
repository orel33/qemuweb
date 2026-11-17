'use strict';

// Exclusive control of a session's consoles: an administrator observing a session takes its
// keyboard. While the lock is held, the owner's console input is refused on every node of the
// session, and the controlling administrator (a login, through any of their observer sockets on
// that session) may type into any of them. The lock is released by that administrator
// (release-control), when their last observer socket on the session closes, when the session is
// deleted, or after idleMs without input from them. Typed text never goes through this module.
const CONTROL_IDLE_MS = 10 * 60 * 1000;

class ConsoleControl {
  // onRelease(lock, reason) runs once per released lock; lock is {sessionId, admin, login}.
  constructor({idleMs = CONTROL_IDLE_MS, onRelease = () => {}} = {}) {
    this.idleMs = idleMs;
    this.onRelease = onRelease;
    this.locks = new Map();
  }

  // The lock of a session, or null.
  get(sessionId) { return this.locks.get(sessionId) || null; }

  // Takes the lock for `admin`, or renews it when they already have it. Returns true for a new
  // lock; throws when another administrator has it. login is the session's owner.
  take(sessionId, {admin, login}) {
    const current = this.get(sessionId);
    if (current && current.admin !== admin) throw new Error(`${current.admin} already controls this session.`);
    if (current) { this.arm(current); return false; }
    const lock = {sessionId, admin, login, timer: null};
    this.locks.set(sessionId, lock);
    this.arm(lock);
    return true;
  }

  // Restarts the idle timer when `admin` has the lock; returns whether they have it.
  touch(sessionId, admin) {
    const lock = this.get(sessionId);
    if (!lock || lock.admin !== admin) return false;
    this.arm(lock);
    return true;
  }

  arm(lock) {
    clearTimeout(lock.timer);
    lock.timer = setTimeout(() => this.release(lock.sessionId, lock.admin, 'idle'), this.idleMs);
    lock.timer.unref?.();
  }

  // Releases the lock of a session, if `admin` has it (whoever has it when admin is null).
  release(sessionId, admin, reason) {
    const lock = this.get(sessionId);
    if (!lock || (admin !== null && lock.admin !== admin)) return false;
    clearTimeout(lock.timer);
    this.locks.delete(sessionId);
    const {timer, ...released} = lock;
    this.onRelease(released, reason);
    return true;
  }

  heldBy(sessionId, admin) { return this.get(sessionId)?.admin === admin; }

  hasLock(sessionId) { return this.locks.has(sessionId); }
}

module.exports = {ConsoleControl, CONTROL_IDLE_MS};
