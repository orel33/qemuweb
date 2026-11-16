'use strict';

// One workspace as the control plane sees it. Each user owns one session, created and tracked
// by lib/session-manager.js. The control plane chooses the session ID (random) and the runner
// that executes it; everything about nodes lives in that runner (see runner/session.js).
//   lastActivity  ISO date, memory only: the owner's latest API request or console input; an
//                 administrator observing the session does not change it
//   archiveBusy   an archive operation or the deletion is in progress: the session's API
//                 refuses changes meanwhile
const path = require('path');
const crypto = require('crypto');

class Session {
  constructor({runtimeRoot, runnerId, id = crypto.randomBytes(8).toString('hex'), owner = null, createdAt = new Date().toISOString()}) {
    this.id = id;
    this.owner = owner;
    this.createdAt = createdAt;
    this.runnerId = runnerId;
    this.lastActivity = null;
    this.archiveBusy = false;
    // Where a local runner keeps the session (runtime/users/<login> links to it).
    this.runtimeDir = path.join(runtimeRoot, 'sessions', id);
  }

  touch(time = Date.now()) { this.lastActivity = new Date(time).toISOString(); }

  // A session never used counts from its creation.
  get lastActivityAt() { return this.lastActivity || this.createdAt; }
}

module.exports = {Session};
