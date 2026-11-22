'use strict';

// Control plane: one persistent session per user. Maps login -> workspace
// {owner, session, runner}, creates the session at the user's first request, and keeps it
// until it is deleted explicitly (closing the browser or logging out stops nothing).
//   session  server/session.js: ID, owner, dates, archive lock, and the ID of its runner
//   runner   the session's handle on its runner client (server/runner-client.js session())
// The control plane chooses the session ID and the runner (registry.pickRunner, once, at
// creation); the runner holds everything else. One rule for every runner, the local one included:
// a session whose runner is offline is kept for `graceSeconds` (--runner-grace; 0 drops it at once),
// during which its routes answer 503, then dropped like a deleted one. When the runner returns (same ID)
// with a hello that lists the session, the session is bound to the new connection again (the handle is
// the same object, so routers and sockets keep working); a session the runner no longer lists is dropped,
// and one the control plane dropped is deleted on the runner when it returns (session.delete, see resync).
// The server touches no file of any runner: aliases, session directories and their removal belong to the
// runner (runner/runtime-tidy.js), which removes a session's directory at session.delete.
// A server restart keeps the sessions: at start restore() turns each binding of bindings.json
// (server/session-bindings.js, written by the server itself) into a workspace behind a placeholder client
// (server/offline-runner.js), offline, for the owner of the binding. The hello of the bound runner
// then adopts it; the owner a hello announces is never used. Until then the user finds his own offline
// session (503), never a new one on another runner. The grace period of a restored session counts from the start.
// Life of a bound session: online -> offline (runner lost) -> online (hello lists it) | dropped (hello
// without it, grace over, runner revoked, forced loss); restored (server start) = offline.
// Events: 'connectivity' (workspace, online) when the runner of a kept session goes offline or returns,
// 'created' (workspace, {adopted, restored}) once a workspace exists (`restored`: from bindings.json at start,
// not a new session), 'adopted' (workspace) when a restored session is taken over by its runner, 'removed'
// (workspace, by, reason) after deletion, `by` being the login that asked for it (the owner or an
// administrator), or null with a reason ('runner lost', 'runner offline too long', 'creation failed')
// when the session was dropped.
const {EventEmitter} = require('events');
const {Session, SESSION_ID} = require('./session');
const {createSessionBindings} = require('./session-bindings');
const {createOfflineClient} = require('./offline-runner');

// The session IDs a hello announces, in order. Everything else a hello says about a session
// (its owner, its date) is ignored: the owner comes from the server's own bindings.
function reportedSessions(hello) {
  const reported = new Set();
  for (const item of Array.isArray(hello?.sessions) ? hello.sessions : []) {
    if (item && typeof item === 'object' && typeof item.sessionId === 'string' && SESSION_ID.test(item.sessionId)) reported.add(item.sessionId);
  }
  return reported;
}

class SessionManager extends EventEmitter {
  // registry: server/runner-registry.js. Sessions bound to a lost runner are kept for the grace period,
  // and on a runner's hello the sessions are resynchronised (see resync).
  constructor({registry, graceSeconds = 0, bindings = createSessionBindings()}) {
    super();
    this.registry = registry;
    this.bindings = bindings;
    this.workspaces = new Map();
    this.deleting = new Set();
    this.graceMs = graceSeconds * 1000;
    this.graceTimers = new Map();
    this.graceEnds = new Map();
    this.offlineClients = new Map();
    registry.on('lost', entry => this.runnerLost(entry));
    registry.on('online', (entry, hello) => {
      this.cancelGrace(entry.id);
      this.resync(entry, hello);
    });
  }

  sessionsOf(runnerId) { return this.list().filter(workspace => workspace.session.runnerId === runnerId).length; }

  // Whether the session's runner is connected and ready (else its routes answer 503).
  available(workspace) {
    const entry = this.registry.get(workspace.session.runnerId);
    return entry?.state === 'online' && entry.client === workspace.runner.client;
  }

  // Whole seconds before the sessions of an offline runner are dropped, or null when no grace period runs for it.
  graceLeft(runnerId) {
    const end = this.graceEnds.get(runnerId);
    return end === undefined ? null : Math.max(0, Math.ceil((end - Date.now()) / 1000));
  }

  // What a user sees while the runner of his session is offline.
  offlineMessage(workspace) {
    const left = this.graceLeft(workspace.session.runnerId);
    return `The runner of your session is offline; it comes back or your session is dropped${left === null ? '' : ` after ${left} second${left === 1 ? '' : 's'}`}.`;
  }

  // The sessions of an offline runner are dropped after the grace period (a hello of the runner cancels it).
  armGrace(runnerId) {
    this.cancelGrace(runnerId);
    this.graceEnds.set(runnerId, Date.now() + this.graceMs);
    const timer = setTimeout(() => {
      this.graceTimers.delete(runnerId);
      this.graceEnds.delete(runnerId);
      this.dropRunnerSessions(runnerId, 'runner offline too long');
    }, this.graceMs);
    timer.unref();
    this.graceTimers.set(runnerId, timer);
  }

  cancelGrace(runnerId) {
    clearTimeout(this.graceTimers.get(runnerId));
    this.graceTimers.delete(runnerId);
    this.graceEnds.delete(runnerId);
  }

  // A lost runner keeps its sessions offline for the grace period (none: dropped at once).
  runnerLost(entry) {
    const kept = this.list().filter(workspace => workspace.session.runnerId === entry.id);
    if (!kept.length) return;
    if (!this.graceMs) return this.dropRunnerSessions(entry.id, 'runner lost');
    console.log(`Runner ${entry.id} is offline; its ${kept.length} session${kept.length === 1 ? '' : 's'} kept for ${this.graceMs / 1000} s.`);
    for (const workspace of kept) this.emit('connectivity', workspace, false);
    this.armGrace(entry.id);
  }

  // At server start: every binding of bindings.json becomes an offline workspace behind a placeholder
  // client, for its owner, until its runner reconnects and reports it. `record(runnerId)` gives the
  // runner's record ({revoked}) or null once it was forgotten: nothing will return for such a binding,
  // nor with --runner-grace 0 (nobody waits), so it is dropped at once ('runner lost'). The others wait
  // for their runner during the grace period, which counts from now. Call it once the 'created' listeners are in place.
  restore(record = () => ({})) {
    const waiting = new Set();
    for (const binding of this.bindings.list()) {
      if (this.workspaces.has(binding.owner)) { this.bindings.remove(binding.id); continue; }
      let client = this.offlineClients.get(binding.runnerId);
      if (!client) this.offlineClients.set(binding.runnerId, client = createOfflineClient());
      const session = new Session({runnerId: binding.runnerId, id: binding.id, owner: binding.owner, createdAt: binding.createdAt});
      session.touch(); // The last activity is unknown: it counts from the restore.
      const workspace = {owner: binding.owner, session, runner: client.session(binding.id), restored: true};
      this.workspaces.set(binding.owner, workspace);
      this.emit('created', workspace, {adopted: false, restored: true});
      const known = record(binding.runnerId);
      if (!known || known.revoked || !this.graceMs) this.drop(workspace, 'runner lost');
      else waiting.add(binding.runnerId);
    }
    for (const runnerId of waiting) {
      console.log(`Runner ${runnerId}: ${this.sessionsOf(runnerId)} session${this.sessionsOf(runnerId) === 1 ? '' : 's'} restored offline; kept for ${this.graceMs / 1000} s while it reconnects.`);
      this.armGrace(runnerId);
    }
  }

  get(login) { return this.workspaces.get(login) || null; }

  list() { return [...this.workspaces.values()]; }

  sessionIds() { return this.list().map(workspace => workspace.session.id); }

  // Returns the user's workspace, creating its session on first use. A user whose session is only
  // offline (a lost or not yet reconnected runner) gets that session back, never a new one elsewhere. The runner creates
  // it asynchronously; requests that follow on the same connection are handled after it, and a
  // failed creation drops the workspace.
  open(login) {
    if (typeof login !== 'string' || !login) throw new Error('A login is required to open a session.');
    const existing = this.workspaces.get(login);
    if (existing) return existing;
    if (this.deleting.has(login)) throw new Error('This session is being deleted; try again in a moment.');
    const entry = this.registry.pickRunner(login, id => this.sessionsOf(id));
    const ids = new Set(this.sessionIds());
    let session;
    do session = new Session({runnerId: entry.id, owner: login});
    while (ids.has(session.id));
    const runner = entry.client.session(session.id);
    const workspace = {owner: login, session, runner};
    // Bound before the runner is asked: a crash in between leaves a binding without a session, never the reverse.
    this.bindings.set({id: session.id, owner: login, runnerId: entry.id, createdAt: session.createdAt});
    this.workspaces.set(login, workspace);
    runner.request('session.create', {owner: login, createdAt: session.createdAt}).catch(error => {
      console.error(`Cannot create session ${session.id}: ${error.message}`);
      if (this.workspaces.get(login) === workspace) this.drop(workspace, 'creation failed');
    });
    this.emit('created', workspace, {adopted: false, restored: false});
    return workspace;
  }

  // Stops and removes every node of the user's session, then the session itself. Refused (503) while
  // the runner is offline: the runner is the one that deletes, so the session stays until it returns, the grace period
  // ends or an administrator forces the loss.
  async remove(login, by = login) {
    const workspace = this.workspaces.get(login);
    if (!workspace) return false;
    if (this.deleting.has(login)) throw new Error('This session is already being deleted.');
    if (workspace.session.archiveBusy) throw new Error('Session archive operation in progress.');
    this.deleting.add(login);
    try {
      workspace.session.archiveBusy = true;
      await workspace.runner.request('session.delete');
      this.forget(workspace);
      this.emit('removed', workspace, by, null);
      return true;
    } catch (error) {
      workspace.session.archiveBusy = false;
      throw error;
    } finally { this.deleting.delete(login); }
  }

  // Drops a session whose runner lost it (or never created it), like a deleted session.
  drop(workspace, reason) {
    if (this.workspaces.get(workspace.owner) !== workspace) return;
    this.forget(workspace);
    this.emit('removed', workspace, null, reason);
  }

  forget(workspace) {
    this.workspaces.delete(workspace.owner);
    this.bindings.remove(workspace.session.id);
    workspace.runner.client.release(workspace.session.id);
  }

  // Drops every session of a runner at once (nothing waits: revoked runner, forced loss, grace over);
  // returns how many. A runner that returns later is told to delete them (resync).
  dropRunnerSessions(runnerId, reason) {
    this.cancelGrace(runnerId);
    const dropped = this.list().filter(workspace => workspace.session.runnerId === runnerId);
    for (const workspace of dropped) this.drop(workspace, reason);
    return dropped.length;
  }

  // On a runner's hello: a session bound to it that it does not report is gone; one it reports
  // is bound to the new connection (a runner that came back, or the one a restored session waited for:
  // same handle, so its machines and consoles continue). A reported session the control plane does not know
  // is deleted on the runner, whatever owner it names (an unknown session, one dropped after the grace period,
  // or every session if bindings.json was lost): the server deletes only through session.delete.
  // Every binding has a workspace since restore(), so a binding the hello does not report goes with its session.
  resync(entry, hello) {
    const reported = reportedSessions(hello);
    for (const workspace of this.list()) {
      if (workspace.session.runnerId !== entry.id) continue;
      if (!reported.has(workspace.session.id)) this.drop(workspace, 'runner lost');
      else if (workspace.runner.client !== entry.client) {
        entry.client.adopt(workspace.runner);
        if (workspace.restored) {
          workspace.restored = false;
          this.emit('adopted', workspace);
        }
        this.emit('connectivity', workspace, true);
      }
    }
    const mine = new Set(this.list().filter(workspace => workspace.session.runnerId === entry.id).map(workspace => workspace.session.id));
    for (const sessionId of reported) {
      if (mine.has(sessionId)) continue;
      entry.client.request('session.delete', {}, sessionId).catch(error => console.error(`Cannot delete unknown session ${sessionId}: ${error.message}`));
    }
  }
}

module.exports = {SessionManager, reportedSessions};
