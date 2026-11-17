'use strict';

// Control plane: one persistent session per user. Maps login -> workspace
// {owner, session, runner}, creates the session at the user's first request, and keeps it
// until it is deleted explicitly (closing the browser or logging out stops nothing).
//   session  lib/session.js: ID, owner, dates, archive lock, and the ID of its runner
//   runner   the session's handle on its runner client (lib/runner-client.js session())
// The control plane chooses the session ID and the runner (registry.pickRunner, once, at
// creation); the runner holds everything else. A session whose runner is lost is dropped
// like a deleted one.
// A readable alias runtime/users/<login> -> ../sessions/<id> helps administrators of a runner
// that shares this server's runtime/ (its hello announces the same runtimeRoot); the server
// never touches the files of any other runner.
// A trusted runner (the local one) that reconnects after a server restart keeps its sessions:
// the server adopts them, each for its owner (see resync).
// Events: 'created' (workspace, {adopted}) once a workspace exists, `adopted` when it was
// taken over from a runner's hello instead of opened by the user, 'removed' (workspace, by, reason) after
// deletion, `by` being the login that asked for it (the owner or an administrator), or null
// with a reason ('runner lost', 'creation failed') when the session was dropped.
const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');
const {Session, SESSION_ID} = require('./session');
const {LOGIN_PATTERN} = require('./auth/users-store');

// Same encoding as the hostname aliases of runner/session-runtime.js.
function userAliasName(login) {
  const encoded = encodeURIComponent(login);
  return encoded === '.' || encoded === '..' ? encoded.replaceAll('.', '%2E') : encoded;
}

// The sessions a hello announces, as a Map of session ID -> {sessionId, owner, createdAt}.
// Everything is checked here: an entry without a valid ID is ignored; an owner that is not a
// valid login becomes null (the session is then never adopted); a bad date becomes the
// adoption time.
function reportedSessions(hello) {
  const reported = new Map();
  for (const item of Array.isArray(hello?.sessions) ? hello.sessions : []) {
    if (!item || typeof item !== 'object' || typeof item.sessionId !== 'string' || !SESSION_ID.test(item.sessionId) || reported.has(item.sessionId)) continue;
    const owner = typeof item.owner === 'string' && LOGIN_PATTERN.test(item.owner) ? item.owner : null;
    const createdAt = typeof item.createdAt === 'string' && item.createdAt.length <= 40 && Number.isFinite(Date.parse(item.createdAt))
      ? item.createdAt : new Date().toISOString();
    reported.set(item.sessionId, {sessionId: item.sessionId, owner, createdAt});
  }
  return reported;
}

class SessionManager extends EventEmitter {
  // registry: lib/runner-registry.js. Sessions bound to a lost runner are dropped, and on a
  // runner's hello the sessions are resynchronised (see resync).
  constructor({runtimeRoot, registry}) {
    super();
    this.runtimeRoot = runtimeRoot;
    this.usersDir = path.join(runtimeRoot, 'users');
    this.registry = registry;
    this.workspaces = new Map();
    this.deleting = new Set();
    registry.on('lost', entry => this.dropRunnerSessions(entry.id, 'runner lost'));
    registry.on('online', (entry, hello) => this.resync(entry, hello));
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
    const entry = this.registry.pickRunner(login);
    const ids = new Set(this.sessionIds());
    let session;
    do session = new Session({runtimeRoot: this.runtimeRoot, runnerId: entry.id, owner: login});
    while (ids.has(session.id));
    const runner = entry.client.session(session.id);
    const workspace = {owner: login, session, runner};
    this.workspaces.set(login, workspace);
    runner.request('session.create', {owner: login, createdAt: session.createdAt}).catch(error => {
      console.error(`Cannot create session ${session.id}: ${error.message}`);
      if (this.workspaces.get(login) === workspace) this.drop(workspace, 'creation failed');
    });
    this.linkUserAlias(workspace, entry);
    this.emit('created', workspace, {adopted: false});
    return workspace;
  }

  // Takes over a session a runner already runs, for its owner (same path as open() afterwards).
  adopt(entry, {sessionId, owner, createdAt}) {
    const session = new Session({runtimeRoot: this.runtimeRoot, runnerId: entry.id, id: sessionId, owner, createdAt});
    const workspace = {owner, session, runner: entry.client.session(sessionId)};
    this.workspaces.set(owner, workspace);
    this.linkUserAlias(workspace, entry);
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
    this.unlinkUserAlias(workspace);
    this.registry.get(workspace.session.runnerId)?.client.release(workspace.session.id);
  }

  dropRunnerSessions(runnerId, reason) {
    // A lost runner that shared this runtime/ cannot remove its sessions' directories any more
    // (a runner killed by SIGKILL): they are removed here, with the sessions.
    const shared = this.registry.get(runnerId)?.runtimeRoot === path.resolve(this.runtimeRoot);
    for (const workspace of this.list()) {
      if (workspace.session.runnerId !== runnerId) continue;
      this.drop(workspace, reason);
      if (shared) fs.rmSync(workspace.session.runtimeDir, {recursive: true, force: true});
    }
  }

  // On a runner's hello: a session bound to it that it does not report is gone. A reported
  // session the control plane does not know is ADOPTED when all of these hold, else deleted:
  //   - the runner is trusted (entry.trusted: the local runner only; a hello is untrusted input
  //     and a later, remote runner never chooses the owner of a session);
  //   - its owner is a valid login (LOGIN_PATTERN) and has no workspace yet: one session per
  //     user, so a second session of the same owner is deleted, never adopted.
  resync(entry, hello) {
    const reported = reportedSessions(hello);
    for (const workspace of this.list()) {
      if (workspace.session.runnerId === entry.id && !reported.has(workspace.session.id)) this.drop(workspace, 'runner lost');
    }
    for (const item of reported.values()) {
      if (this.sessionIds().includes(item.sessionId)) continue;
      if (entry.trusted === true && item.owner && !this.workspaces.has(item.owner) && !this.deleting.has(item.owner)) {
        this.adopt(entry, item);
      } else {
        entry.client.request('session.delete', {}, item.sessionId).catch(error => console.error(`Cannot delete unknown session ${item.sessionId}: ${error.message}`));
      }
    }
  }

  userAliasPath(login) { return path.join(this.usersDir, userAliasName(login)); }

  // Only for a runner that shares this runtime/ (same runtimeRoot in its hello).
  linkUserAlias({owner, session}, entry) {
    if (entry.runtimeRoot !== path.resolve(this.runtimeRoot)) return;
    const alias = this.userAliasPath(owner);
    const target = path.relative(this.usersDir, session.runtimeDir);
    try {
      fs.mkdirSync(this.usersDir, {recursive: true});
      const temporary = `${alias}.${process.pid}.tmp`;
      fs.rmSync(temporary, {force: true});
      fs.symlinkSync(target, temporary, 'dir');
      fs.renameSync(temporary, alias);
    } catch (error) { console.warn(`Cannot create ${path.relative(this.runtimeRoot, alias)}: ${error.message}`); }
  }

  unlinkUserAlias({owner, session}) {
    const alias = this.userAliasPath(owner);
    try {
      if (fs.readlinkSync(alias) === path.relative(this.usersDir, session.runtimeDir)) fs.unlinkSync(alias);
    } catch (_) {}
    try { fs.rmdirSync(this.usersDir); } catch (_) {}
  }

  // Startup and exit: removes runtime/users aliases whose session directory no longer exists.
  pruneUserAliases() {
    let names;
    try { names = fs.readdirSync(this.usersDir); } catch (_) { return; }
    for (const name of names) {
      const alias = path.join(this.usersDir, name);
      try {
        if (fs.lstatSync(alias).isSymbolicLink() && !fs.existsSync(alias)) fs.unlinkSync(alias);
      } catch (_) {}
    }
    try { fs.rmdirSync(this.usersDir); } catch (_) {}
  }
}

module.exports = {SessionManager, userAliasName, reportedSessions};
