'use strict';

// One workspace as the control plane sees it. Each user owns one session, implicit from the
// login, tracked by server/session-manager.js. The control plane chooses the session ID (random)
// and, once the session needs one, the runner that executes it; everything about nodes lives in
// that runner (see runner/session.js).
//   runnerId      the runner the session is placed on, or null while it is not placed (no node)
//   engine        the engine chosen while the session is not placed (null: the default of the
//                 runner it goes to), passed to that runner when it is placed; unused once placed
//   lastActivity  ISO date, memory only: the owner's latest API request or console input; an
//                 administrator observing the session does not change it
//   archiveBusy   an archive operation or the deletion is in progress: the session's API
//                 refuses changes meanwhile
const crypto = require('crypto');

// Session IDs are 8 hex characters, chosen by the control plane.
const SESSION_ID = /^[0-9a-f]{8}$/;

class Session {
  constructor({runnerId = null, id = crypto.randomBytes(4).toString('hex'), owner = null, createdAt = new Date().toISOString()}) {
    this.id = id;
    this.owner = owner;
    this.createdAt = createdAt;
    this.runnerId = runnerId;
    this.engine = null;
    this.lastActivity = null;
    this.archiveBusy = false;
  }

  touch(time = Date.now()) { this.lastActivity = new Date(time).toISOString(); }

  // A session never used counts from its creation.
  get lastActivityAt() { return this.lastActivity || this.createdAt; }
}

module.exports = {Session, SESSION_ID};
