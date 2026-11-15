'use strict';

// Control plane: one persistent session per user. Maps login -> workspace
// {owner, session, runner}, creates the session at the user's first request, and keeps it
// until it is deleted explicitly (closing the browser or logging out stops nothing).
// A readable alias runtime/users/<login> -> ../sessions/<id> helps administrators.
// Events: 'created' (workspace) once a workspace exists, 'removed' (workspace) after deletion.
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
  // createRunner(session, hostNodes) returns the runner of a new session.
  constructor({runtimeRoot, createRunner}) {
    super();
    this.runtimeRoot = runtimeRoot;
    this.sessionsDir = path.join(runtimeRoot, 'sessions');
    this.usersDir = path.join(runtimeRoot, 'users');
    this.createRunner = createRunner;
    this.workspaces = new Map();
    this.deleting = new Set();
  }

  get(login) { return this.workspaces.get(login) || null; }

  list() { return [...this.workspaces.values()]; }

  sessionIds() { return this.list().map(workspace => workspace.session.id); }

  // Every node of every session: QEMU/KVM and VirtualBox exclusion is machine-wide.
  hostNodes() { return this.list().flatMap(workspace => [...workspace.session.nodes.values()]); }

  // Returns the user's workspace, creating its session on first use.
  open(login) {
    if (typeof login !== 'string' || !login) throw new Error('A login is required to open a session.');
    const existing = this.workspaces.get(login);
    if (existing) return existing;
    if (this.deleting.has(login)) throw new Error('This session is being deleted; try again in a moment.');
    fs.mkdirSync(this.sessionsDir, {recursive: true});
    let session;
    do session = new Session({runtimeRoot: this.runtimeRoot, owner: login});
    while (fs.existsSync(session.runtimeDir));
    fs.mkdirSync(session.runtimeDir);
    session.saveMetadata();
    const runner = this.createRunner(session, () => this.hostNodes());
    const workspace = {owner: login, session, runner};
    this.workspaces.set(login, workspace);
    this.linkUserAlias(workspace);
    runner.startResourceSampling();
    this.emit('created', workspace);
    return workspace;
  }

  // Stops and removes every node of the user's session, then the session itself.
  async remove(login) {
    const workspace = this.workspaces.get(login);
    if (!workspace) return false;
    if (this.deleting.has(login)) throw new Error('This session is already being deleted.');
    this.deleting.add(login);
    try {
      workspace.session.archiveBusy = true;
      await workspace.runner.shutdown();
      if (workspace.session.nodes.size) throw new Error('Some nodes could not be deleted; see the server log.');
      this.workspaces.delete(login);
      this.unlinkUserAlias(workspace);
      fs.rmSync(workspace.session.runtimeDir, {recursive: true, force: true});
      workspace.runner.events.removeAllListeners();
      this.emit('removed', workspace);
      return true;
    } catch (error) {
      workspace.session.archiveBusy = false;
      workspace.runner.startResourceSampling();
      throw error;
    } finally { this.deleting.delete(login); }
  }

  // Server shutdown: stops every node of every session.
  async shutdown() {
    await Promise.all(this.list().map(workspace => workspace.runner.shutdown()
      .catch(error => console.error(`Session ${workspace.session.id} shutdown:`, error))));
  }

  // Process exit: removes the empty runtime directories and the user aliases.
  removeEmptyRuntimeSessions() {
    for (const workspace of this.list()) {
      workspace.session.removeIfEmpty();
      if (!fs.existsSync(workspace.session.runtimeDir)) this.unlinkUserAlias(workspace);
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

  // Startup: removes runtime/users aliases whose session directory no longer exists.
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
