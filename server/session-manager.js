'use strict';

// Control plane: one persistent session per user. Maps login -> workspace
// {owner, session, runner}, creates the session at the user's first request, and keeps it
// until it is deleted explicitly (closing the browser or logging out stops nothing).
//   session  server/session.js: ID, owner, dates, archive lock, and the ID of its runner
//   runner   the session's handle on its runner client (server/runner-client.js session())
// The control plane chooses the session ID and the runner (registry.pickRunner, once, at
// creation); the runner holds everything else. A session whose runner is lost is dropped
// like a deleted one, except that its sessions are kept for `graceSeconds`
// (--runner-grace; 0 drops them at once), during which they answer 503 "offline". When the
// runner returns (same ID) with a hello that lists a session, the session is bound to the new
// connection again (the handle is the same object, so routers and sockets keep working); a
// session the runner no longer lists is dropped, and one dropped after the grace period is
// deleted on the runner when it returns (it is then unknown to the control plane).
// The server touches no file of any runner: the users/<login> aliases, the session directories and their removal
// belong to the runner (runner/runtime-tidy.js), which removes a session's directory at session.delete.
// A runner that reconnects after a server restart keeps its sessions: the server adopts each one
// for the owner of its binding (server/session-bindings.js, written by the server itself); the owner
// a hello announces is never used (see resync).
// Events: 'connectivity' (workspace, online) when the runner of a kept session goes offline or returns,
// 'created' (workspace, {adopted}) once a workspace exists, `adopted` when it was
// taken over from a runner's hello instead of opened by the user, 'removed' (workspace, by, reason) after
// deletion, `by` being the login that asked for it (the owner or an administrator), or null
// with a reason ('runner lost', 'creation failed') when the session was dropped.
const {EventEmitter} = require('events');
const {Session, SESSION_ID} = require('./session');
const {createSessionBindings} = require('./session-bindings');

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
  // registry: server/runner-registry.js. Sessions bound to a lost runner are dropped, and on a
  // runner's hello the sessions are resynchronised (see resync).
  constructor({registry, graceSeconds = 0, bindings = createSessionBindings()}) {
    super();
    this.registry = registry;
    this.bindings = bindings;
    this.workspaces = new Map();
    this.deleting = new Set();
    this.graceMs = graceSeconds * 1000;
    this.graceTimers = new Map();
    registry.on('lost', entry => this.runnerLost(entry));
    registry.on('online', (entry, hello) => {
      clearTimeout(this.graceTimers.get(entry.id));
      this.graceTimers.delete(entry.id);
      this.resync(entry, hello);
    });
  }

  sessionsOf(runnerId) { return this.list().filter(workspace => workspace.session.runnerId === runnerId).length; }

  // Whether the session's runner is connected and ready (else its routes answer 503).
  available(workspace) {
    const entry = this.registry.get(workspace.session.runnerId);
    return entry?.state === 'online' && entry.client === workspace.runner.client;
  }

  // A lost runner drops its sessions at once when there is no grace period.
  runnerLost(entry) {
    if (!this.graceMs) return this.dropRunnerSessions(entry.id, 'runner lost');
    const kept = this.list().filter(workspace => workspace.session.runnerId === entry.id);
    if (!kept.length) return;
    console.log(`Runner ${entry.id} is offline; its ${kept.length} session${kept.length === 1 ? '' : 's'} kept for ${this.graceMs / 1000} s.`);
    for (const workspace of kept) this.emit('connectivity', workspace, false);
    const timer = setTimeout(() => {
      this.graceTimers.delete(entry.id);
      this.dropRunnerSessions(entry.id, 'runner offline too long');
    }, this.graceMs);
    timer.unref();
    this.graceTimers.set(entry.id, timer);
  }

  get(login) { return this.workspaces.get(login) || null; }

  list() { return [...this.workspaces.values()]; }

  sessionIds() { return this.list().map(workspace => workspace.session.id); }

  // Returns the user's workspace, creating its session on first use. The runner creates it
  // asynchronously; requests that follow on the same connection are handled after it, and a
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
    this.emit('created', workspace, {adopted: false});
    return workspace;
  }

  // Takes over a session a runner already runs, for the owner of its binding (same path as open() afterwards).
  adopt(entry, {sessionId, owner, createdAt}) {
    const session = new Session({runnerId: entry.id, id: sessionId, owner, createdAt});
    const workspace = {owner, session, runner: entry.client.session(sessionId)};
    this.workspaces.set(owner, workspace);
    this.emit('created', workspace, {adopted: true});
    return workspace;
  }

  // Stops and removes every node of the user's session, then the session itself.
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
    this.registry.get(workspace.session.runnerId)?.client.release(workspace.session.id);
  }

  dropRunnerSessions(runnerId, reason) {
    for (const workspace of this.list()) if (workspace.session.runnerId === runnerId) this.drop(workspace, reason);
  }

  // On a runner's hello: a session bound to it that it does not report is gone; one it reports
  // is bound to the new connection (a runner that came back). A reported session the control plane
  // does not know is ADOPTED only when the server's own binding says it belongs to this runner, for
  // the owner of that binding (the hello never chooses an owner); else it is deleted. One session
  // per user: if the owner already has a workspace, the other session is deleted. A binding of this
  // runner that the hello does not report is stale and dropped.
  resync(entry, hello) {
    const reported = reportedSessions(hello);
    for (const workspace of this.list()) {
      if (workspace.session.runnerId !== entry.id) continue;
      if (!reported.has(workspace.session.id)) this.drop(workspace, 'runner lost');
      else if (workspace.runner.client !== entry.client) {
        entry.client.adopt(workspace.runner);
        this.emit('connectivity', workspace, true);
      }
    }
    const known = new Set(this.sessionIds());
    for (const sessionId of reported) {
      if (known.has(sessionId)) continue;
      const binding = this.bindings.get(sessionId);
      if (binding && binding.runnerId === entry.id && !this.workspaces.has(binding.owner) && !this.deleting.has(binding.owner)) {
        this.adopt(entry, {sessionId, owner: binding.owner, createdAt: binding.createdAt});
      } else {
        if (binding && binding.runnerId === entry.id) this.bindings.remove(sessionId);
        entry.client.request('session.delete', {}, sessionId).catch(error => console.error(`Cannot delete unknown session ${sessionId}: ${error.message}`));
      }
    }
    for (const binding of this.bindings.list()) {
      if (binding.runnerId === entry.id && !reported.has(binding.id) && !known.has(binding.id)) this.bindings.remove(binding.id);
    }
  }
}

module.exports = {SessionManager, reportedSessions};
