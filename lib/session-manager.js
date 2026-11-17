'use strict';

// Control plane: one persistent session per user. Maps login -> workspace
// {owner, session, runner}, creates the session at the user's first request, and keeps it
// until it is deleted explicitly (closing the browser or logging out stops nothing).
//   session  lib/session.js: ID, owner, dates, archive lock, and the ID of its runner
//   runner   the session's handle on its runner client (lib/runner-client.js session())
// The control plane chooses the session ID and the runner (registry.pickRunner, once, at
// creation); the runner holds everything else. A session whose runner is lost is dropped
// like a deleted one.
// A readable alias runtime/users/<login> -> ../sessions/<id> helps administrators of a local
// runner.
// Events: 'created' (workspace) once a workspace exists, 'removed' (workspace, by, reason) after
// deletion, `by` being the login that asked for it (the owner or an administrator), or null
// with a reason ('runner lost', 'creation failed') when the session was dropped.
const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');
const {Session} = require('./session');

// Same encoding as the hostname aliases of runner/session-runtime.js.
function userAliasName(login) {
  const encoded = encodeURIComponent(login);
  return encoded === '.' || encoded === '..' ? encoded.replaceAll('.', '%2E') : encoded;
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
    this.linkUserAlias(workspace);
    this.emit('created', workspace);
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
    for (const workspace of this.list()) if (workspace.session.runnerId === runnerId) this.drop(workspace, reason);
  }

  // On a runner's hello: a session bound to it that it does not report is gone; a session it
  // reports that the control plane does not know is deleted.
  resync(entry, hello) {
    const reported = new Set((Array.isArray(hello.sessions) ? hello.sessions : []).map(item => item?.sessionId));
    for (const workspace of this.list()) {
      if (workspace.session.runnerId === entry.id && !reported.has(workspace.session.id)) this.drop(workspace, 'runner lost');
    }
    const known = new Set(this.sessionIds());
    for (const sessionId of reported) {
      if (typeof sessionId === 'string' && !known.has(sessionId)) {
        entry.client.request('session.delete', {}, sessionId).catch(error => console.error(`Cannot delete unknown session ${sessionId}: ${error.message}`));
      }
    }
  }

  userAliasPath(login) { return path.join(this.usersDir, userAliasName(login)); }

  linkUserAlias({owner, session}) {
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

module.exports = {SessionManager, userAliasName};
