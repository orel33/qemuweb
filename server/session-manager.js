'use strict';

// Control plane: one persistent session per user. Maps login -> workspace {owner, session, runner}.
// A user's session is implicit (UXS02): it exists from the user's first request (open), empty,
// with a random ID, and stays until an administrator deletes it (closing the browser or logging
// out stops nothing); the next request then opens a new, empty one.
//   session  server/session.js: ID, owner, dates, archive lock, and the ID of its runner (or null)
//   runner   the session's handle (server/runner-client.js session()), the same object for the
//            whole life of the workspace, whichever client holds it
// Placement is lazy. A new session is not placed on any runner: its handle lives on the unbound
// client (server/unbound-runner.js), which answers its reads as an empty session. It is placed
// (place: registry.pickRunner, then session.create) when it first needs a runner: its first node
// is created or a topology, example or archive is loaded (the routes that do it await place). Once
// empty again (Reset, its last node removed, a load that created nothing), it is released
// (release: the runner deletes it, session.delete {ifEmpty}) and is unbound again, so that its
// next node may go to another runner. Only placed sessions are in bindings.json.
// One rule for every runner, the local one included: a placed session whose runner is offline is
// kept for `graceSeconds` (--runner-grace; 0 drops it at once), during which its routes answer 503,
// then dropped like a deleted one. When the runner returns (same ID) with a hello that lists the
// session, the session is bound to the new connection again (the handle is the same object, so
// routers and sockets keep working); a session the runner no longer lists is dropped, and one the
// control plane does not hold on that runner is deleted on the runner (session.delete, see resync).
// The server touches no file of any runner: aliases, session directories and their removal belong to the
// runner (runner/runtime-tidy.js), which removes a session's directory at session.delete.
// A server restart keeps the placed sessions: at start restore() turns each binding of bindings.json
// (server/session-bindings.js, written by the server itself) into a workspace behind a placeholder client
// (server/offline-runner.js), offline, for the owner of the binding. The hello of the bound runner
// then adopts it; the owner a hello announces is never used. Until then the user finds his own offline
// session (503), never a new one on another runner. The grace period of a restored session counts from
// the start. An unplaced session has nothing to restore: it is simply implicit again after a restart.
// Life of a session: unplaced -> placed (online) -> offline (runner lost) -> online (hello lists it)
// | dropped (hello without it, grace over, runner revoked, forced loss); placed -> unplaced (released);
// restored (server start) = offline.
// Events: 'connectivity' (workspace, online) when the runner of a kept session goes offline or returns,
// 'created' (workspace, {restored}) once a workspace exists (`restored`: from bindings.json at start,
// not a new session), 'placed' (workspace) once its runner created it, 'adopted' (workspace) when a
// restored session is taken over by its runner, 'reset' (workspace, by) after a Reset, 'removed'
// (workspace, by, reason) after deletion, `by` being the login that asked for it (an administrator),
// or null with a reason ('runner lost', 'runner offline too long') when the session was dropped.
const {EventEmitter} = require('events');
const {Session, SESSION_ID} = require('./session');
const {createSessionBindings} = require('./session-bindings');
const {createOfflineClient} = require('./offline-runner');
const {UnboundClient} = require('./unbound-runner');

const ENGINES = ['qemu', 'vbox'];
const statusError = (message, status) => Object.assign(new Error(message), {status});

// The session IDs a hello announces, in order. Everything else a hello says about a session
// (its owner, its date) is ignored: the owner comes from the server's own bindings.
function reportedSessions(hello) {
  const reported = new Set();
  for (const item of Array.isArray(hello?.sessions) ? hello.sessions : []) {
    if (item && typeof item === 'object' && typeof item.sessionId === 'string' && SESSION_ID.test(item.sessionId)) reported.add(item.sessionId);
  }
  return reported;
}

// The session IDs a hello announces without any node.
function reportedEmpty(hello) {
  const empty = new Set();
  for (const item of Array.isArray(hello?.sessions) ? hello.sessions : []) {
    if (item && typeof item === 'object' && typeof item.sessionId === 'string' && Array.isArray(item.nodes) && !item.nodes.length) empty.add(item.sessionId);
  }
  return empty;
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
    this.unbound = new UnboundClient({
      settings: sessionId => this.unplacedSettings(this.bySession(sessionId)),
      setEngine: (sessionId, body) => this.setUnplacedEngine(this.bySession(sessionId), body),
      forward: (sessionId, command, args) => this.forward(this.bySession(sessionId), command, args)
    });
    registry.on('lost', entry => this.runnerLost(entry));
    registry.on('online', (entry, hello) => {
      this.cancelGrace(entry.id);
      this.resync(entry, hello);
    });
  }

  sessionsOf(runnerId) { return this.list().filter(workspace => workspace.session.runnerId === runnerId).length; }

  bySession(sessionId) {
    const workspace = this.list().find(item => item.session.id === sessionId);
    if (!workspace) throw statusError('Unknown session.', 404);
    return workspace;
  }

  // Whether the session is placed on a runner.
  placed(workspace) { return workspace.session.runnerId !== null; }

  // The runner an unplaced session would go to now (nothing is placed), or null when none is available.
  candidate(login) {
    try { return this.registry.pickRunner(login, id => this.sessionsOf(id), {log: false}); }
    catch (_) { return null; }
  }

  // The general settings of an unplaced session: its chosen engine, else the default of the runner it would go to.
  unplacedSettings({owner, session}) {
    const engines = this.candidate(owner)?.capabilities.engines || [];
    const engine = session.engine || engines[0] || 'qemu';
    return {sessionId: session.id, engine, availableEngines: engines.length ? engines : [engine], unavailableHosts: [], hostsInUse: 0};
  }

  // Chooses the engine of an unplaced session (validated like the runner's session.setEngine), kept until it is placed.
  setUnplacedEngine(workspace, body) {
    const engine = body?.engine;
    if (!ENGINES.includes(engine) || Object.keys(body || {}).some(key => key !== 'engine')) throw new Error('Invalid session engine.');
    const engines = this.candidate(workspace.owner)?.capabilities.engines;
    if (engines && !engines.includes(engine)) throw new Error('VirtualBox is unavailable on this server.');
    if (engine !== this.unplacedSettings(workspace).engine) {
      workspace.session.engine = engine;
      workspace.runner.events.emit('general-settings-changed', {sessionId: workspace.session.id, engine});
      workspace.runner.events.emit('nodes-changed', {nodeId: null});
    }
    return {sessionId: workspace.session.id, engine, unavailableHosts: []};
  }

  // A catalog read of an unplaced session (catalog.systems, topology.preview, archive.check), asked
  // without a session from the runner it would go to, with its engine. Without a runner: no system, else 503.
  async forward(workspace, command, args) {
    let entry;
    try { entry = this.registry.pickRunner(workspace.owner, id => this.sessionsOf(id), {log: command !== 'catalog.systems'}); }
    catch (error) {
      if (command === 'catalog.systems') return [];
      throw error;
    }
    const engine = workspace.session.engine;
    return entry.client.request(command, {...args, ...(engine && entry.capabilities.engines.includes(engine) ? {engine} : {})});
  }

  // A request that creates nodes (a host, a switch, a load) starts: until the returned end() is called
  // (idempotent), no release runs, so that the creation never reaches a session its runner deleted
  // as empty meanwhile. The request then awaits place(), which waits for a release already running.
  beginCreation(workspace) {
    workspace.creations = (workspace.creations || 0) + 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      workspace.creations -= 1;
    };
  }

  // Places an unplaced session on a runner (registry.pickRunner; 503 when there is none) and has the
  // runner create it. Resolves once the session is placed; concurrent calls share one placement, and a
  // placement waits for a release in progress. A failed creation leaves the session unplaced.
  async place(workspace) {
    if (this.workspaces.get(workspace.owner) !== workspace) throw statusError('This session was deleted; reload the page.', 409);
    if (workspace.releasing) await workspace.releasing;
    if (workspace.placing) return workspace.placing;
    if (this.placed(workspace)) return;
    workspace.placing = (async () => {
      const {session, runner, owner} = workspace;
      const entry = this.registry.pickRunner(owner, id => this.sessionsOf(id));
      // Bound before the runner is asked: a crash in between leaves a binding without a session, never the reverse.
      this.bindings.set({id: session.id, owner, runnerId: entry.id, createdAt: session.createdAt});
      session.runnerId = entry.id;
      entry.client.adopt(runner);
      try {
        await runner.request('session.create', {owner, createdAt: session.createdAt, ...(session.engine ? {engine: session.engine} : {})});
      } catch (error) {
        console.error(`Cannot create session ${session.id} on runner ${entry.id}: ${error.message}`);
        if (this.workspaces.get(owner) === workspace && session.runnerId === entry.id) this.unplace(workspace);
        throw error;
      }
      session.engine = null;
      this.emit('placed', workspace);
    })().finally(() => { workspace.placing = null; });
    return workspace.placing;
  }

  // Back to unplaced: the handle returns to the unbound client and the binding goes. `engine` is
  // the engine the session keeps for its next placement (null: the default).
  unplace(workspace, engine = null) {
    this.bindings.remove(workspace.session.id);
    workspace.session.runnerId = null;
    workspace.session.engine = engine;
    this.unbound.adopt(workspace.runner);
  }

  // Releases a placed session that has no node any more: the runner deletes it only if it is still
  // empty (session.delete {ifEmpty}), then it is unplaced and keeps its engine for the next placement.
  // Never throws: a session that cannot be released stays placed (logged). Skipped while a creation is in
  // flight (beginCreation): the next time the session becomes empty releases it.
  async release(workspace) {
    if (!this.placed(workspace) || workspace.creations > 0 || workspace.placing || workspace.releasing || !this.available(workspace)) return;
    workspace.releasing = (async () => {
      try {
        if ((await workspace.runner.request('nodes.ids')).length) return;
        const {engine} = await workspace.runner.request('session.settings');
        const {deleted} = await workspace.runner.request('session.delete', {ifEmpty: true});
        if (deleted && this.workspaces.get(workspace.owner) === workspace) this.unplace(workspace, ENGINES.includes(engine) ? engine : null);
      } catch (error) { console.error(`Cannot release session ${workspace.session.id}: ${error.message}`); }
    })().finally(() => { workspace.releasing = null; });
    return workspace.releasing;
  }

  // Reset session: stops and removes every node; the session stays, empty and unplaced, and keeps its
  // engine for its next placement (the Load dialog resets before it loads with the page's engine). Refused while an archive operation or a deletion runs, and (503) while the runner is offline.
  async reset(workspace, by = workspace.owner) {
    if (this.deleting.has(workspace.owner)) throw statusError('This session is being deleted.', 409);
    if (workspace.session.archiveBusy) throw statusError('Session archive operation in progress.', 409);
    workspace.session.archiveBusy = true;
    try {
      if (workspace.placing) await workspace.placing.catch(() => {});
      if (workspace.releasing) await workspace.releasing;
      if (this.placed(workspace)) {
        const {engine} = await workspace.runner.request('session.settings');
        await workspace.runner.request('session.delete');
        if (this.workspaces.get(workspace.owner) === workspace) this.unplace(workspace, ENGINES.includes(engine) ? engine : null);
      }
      workspace.runner.events.emit('nodes-changed', {nodeId: null});
      this.emit('reset', workspace, by);
      return {reset: true};
    } finally { workspace.session.archiveBusy = false; }
  }

  // Whether the session's runner is connected and ready (else its routes answer 503). An unplaced
  // session needs no runner.
  available(workspace) {
    if (!this.placed(workspace)) return true;
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
  // A timer already running is kept: the period runs from the first loss (or from the restore), never from a later one.
  armGrace(runnerId) {
    if (this.graceTimers.has(runnerId)) return;
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
      const workspace = {owner: binding.owner, session, runner: client.session(binding.id), restored: true, placing: null, releasing: null, creations: 0};
      this.workspaces.set(binding.owner, workspace);
      this.emit('created', workspace, {restored: true});
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

  // Returns the user's workspace, opening its implicit session on first use: empty and unplaced,
  // which needs no runner. A user whose session is only offline (a lost or not yet reconnected
  // runner) gets that session back, never a new one.
  open(login) {
    if (typeof login !== 'string' || !login) throw new Error('A login is required to open a session.');
    const existing = this.workspaces.get(login);
    if (existing) return existing;
    if (this.deleting.has(login)) throw new Error('This session is being deleted; try again in a moment.');
    const ids = new Set(this.sessionIds());
    let session;
    do session = new Session({owner: login});
    while (ids.has(session.id));
    const workspace = {owner: login, session, runner: this.unbound.session(session.id), placing: null, releasing: null, creations: 0};
    this.workspaces.set(login, workspace);
    this.emit('created', workspace, {restored: false});
    return workspace;
  }

  // Stops and removes every node of the user's session, then the session itself (an administrator,
  // from /admin); the user's next request opens a new, empty session. Refused (503) while the runner
  // is offline: the runner is the one that deletes, so the session stays until it returns, the grace
  // period ends or an administrator forces the loss.
  async remove(login, by) {
    const workspace = this.workspaces.get(login);
    if (!workspace) return false;
    if (this.deleting.has(login)) throw new Error('This session is already being deleted.');
    if (workspace.session.archiveBusy) throw new Error('Session archive operation in progress.');
    this.deleting.add(login);
    try {
      workspace.session.archiveBusy = true;
      if (workspace.placing) await workspace.placing.catch(() => {});
      if (workspace.releasing) await workspace.releasing;
      await workspace.runner.request('session.delete');
      this.forget(workspace);
      this.emit('removed', workspace, by, null);
      return true;
    } catch (error) {
      workspace.session.archiveBusy = false;
      throw error;
    } finally { this.deleting.delete(login); }
  }

  // Drops a session whose runner lost it, like a deleted session.
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
  // A session adopted again that the hello reports without any node is released (unplaced).
  resync(entry, hello) {
    // Every session of this runner is reconciled below (adopted or dropped): nothing is left to wait for.
    this.cancelGrace(entry.id);
    const reported = reportedSessions(hello);
    const empty = reportedEmpty(hello);
    for (const workspace of this.list()) {
      if (workspace.session.runnerId !== entry.id || workspace.placing) continue;
      if (!reported.has(workspace.session.id)) this.drop(workspace, 'runner lost');
      else if (workspace.runner.client !== entry.client) {
        entry.client.adopt(workspace.runner);
        if (workspace.restored) {
          workspace.restored = false;
          this.emit('adopted', workspace);
        }
        this.emit('connectivity', workspace, true);
        if (empty.has(workspace.session.id)) this.release(workspace);
      }
    }
    const mine = new Set(this.list().filter(workspace => workspace.session.runnerId === entry.id).map(workspace => workspace.session.id));
    for (const sessionId of reported) {
      if (mine.has(sessionId)) continue;
      entry.client.request('session.delete', {}, sessionId).catch(error => console.error(`Cannot delete unknown session ${sessionId}: ${error.message}`));
    }
  }
}

module.exports = {SessionManager, reportedSessions, reportedEmpty};
