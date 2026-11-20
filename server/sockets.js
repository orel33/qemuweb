'use strict';

// Socket.IO layer: forwards runner events to browsers and relays console input. A session is
// reached only through its runner handle (server/runner-client.js): node existence, kinds and
// consoles are the runner's business.
// Event names and payloads are the wire format the browser relies on.
// Rooms keep sessions apart:
//   session:<sessionId>           every browser of the session's owner, and of the admins
//                                 observing it (per-session events)
//   observers:<sessionId>         the admins observing the session (owner-view)
//   node:<sessionId>:<nodeId>     browsers that selected that node (state, log, logs-reset); a
//                                 socket joins it only for a node of its own or observed session
//   console:<sessionId>:<consoleId>  browsers that selected that console (serial, serial-reset);
//                                 a console ID is the node ID, or '<nodeId>:1' for a host's
//                                 second serial port (common/console-id.js)
// select-node, input and clear-console take a console ID. runner-state {online} tells the session's
// pages that its runner went offline or came back.
// The handshake must already have set socket.data.user (see server/auth/). An admin observes
// another user's session with the handshake option auth: {observe: <login>}: the socket then
// reads that session (snapshots, console output, logs) but its input, clear-console and
// terminal-resize are refused, unless that admin took control of the session (input only, on
// every node), see server/console-control.js. console-control {admin, active} tells every socket
// of the session (owner and observers) the control state, also at connection. While an admin
// controls a session, the view goes the other way: the admin's page publishes controller-view,
// relayed to the session room and shown by the owner's pages.
const {ConsoleControl} = require('./console-control');
const {attachCaptureLive} = require('./capture-live');
const {attachCaptureLease} = require('./capture-lease');
const {normalizeView} = require('../public/view-state');
const {baseNodeId} = require('../common/console-id');
const {createTransportRegistry} = require('./ws-transports');

function sessionRoom(session) { return `session:${session.id}`; }
function observerRoom(session) { return `observers:${session.id}`; }
function nodeRoom(session, nodeId) { return `node:${session.id}:${nodeId}`; }
function consoleRoom(session, consoleId) { return `console:${session.id}:${consoleId}`; }

// Why a socket may not type into a console, or null when it may.
// lock is the session's control lock (or null), admin the socket's login.
function inputRefusal({observer, lock, admin}) {
  if (observer) return lock?.admin === admin ? null : 'Read-only observation: take control to type into this session.';
  return lock ? `${lock.admin} controls this session.` : null;
}

// Counts the open observer sockets per (admin, observed login) and audits each observation
// period: the 'observe' line is written when the first socket of that pair opens (a page load
// opens several). closed() returns how many remain.
function createObservationTracker(audit) {
  const open = new Map();
  const key = (admin, login) => JSON.stringify([admin, login]);
  return {
    opened(admin, login) {
      const count = open.get(key(admin, login)) || 0;
      open.set(key(admin, login), count + 1);
      if (!count) audit.record(admin, 'observe', {login});
    },
    closed(admin, login) {
      const count = (open.get(key(admin, login)) || 0) - 1;
      if (count > 0) open.set(key(admin, login), count);
      else open.delete(key(admin, login));
      return Math.max(0, count);
    }
  };
}

// Forwards the events of one session's runner to that session's browsers only. Per-node
// events need a payload naming a node.
function bindWorkspace(io, {session, runner}) {
  for (const event of ['state', 'log', 'logs-reset']) {
    runner.events.on(event, payload => {
      if (typeof payload?.nodeId === 'string') io.to(nodeRoom(session, payload.nodeId)).emit(event, payload);
    });
  }
  // Console output goes to the room of its console (payload.nodeId is a console ID).
  for (const event of ['serial', 'serial-reset']) {
    runner.events.on(event, payload => {
      if (typeof payload?.nodeId === 'string') io.to(consoleRoom(session, payload.nodeId)).emit(event, payload);
    });
  }
  runner.events.on('state', state => io.to(sessionRoom(session)).emit('nodes-changed', state));
  for (const event of ['nodes-removed', 'nodes-changed', 'node-renamed', 'general-settings-changed', 'captures']) {
    runner.events.on(event, payload => io.to(sessionRoom(session)).emit(event, payload));
  }
}

// audit: server/audit.js. currentUser(login, via) returns the account as it is now ({login, role}),
// or null once it is disabled or removed (server/auth). transports is the registry of live connections and their
// transport (server/ws-transports.js). Returns {disconnectUser(login), browsers(login), connections()}.
function attachSockets(io, manager, {audit, currentUser, control: options = {}, transports = createTransportRegistry()}) {
  // The controlling admin's last view, per session ID, kept only while a lock exists there.
  const controllerViews = new Map();
  // The capture leases of each session, shared by its sockets (server/capture-lease.js).
  const leaseRegistry = new Map();
  const leasesOf = sessionId => { if (!leaseRegistry.has(sessionId)) leaseRegistry.set(sessionId, new Map()); return leaseRegistry.get(sessionId); };
  const control = new ConsoleControl({...options, onRelease: (lock, reason) => {
    controllerViews.delete(lock.sessionId);
    io.to(`session:${lock.sessionId}`).emit('console-control', {admin: lock.admin, active: false});
    audit.record(lock.admin, 'control-end', {login: lock.login, reason});
  }});
  const observations = createObservationTracker(audit);
  // Connected browser tabs per login: each tab opens one session socket (auth.main) besides
  // its console sockets. Observers are not counted.
  const browsers = new Map();
  // What the owner last showed, per session ID: {nodeId, mode}, sent to a new observer.
  const ownerViews = new Map();
  for (const workspace of manager.list()) bindWorkspace(io, workspace);
  manager.on('created', workspace => bindWorkspace(io, workspace));
  // The runner of a session went offline or came back (a remote runner after a network cut): the
  // pages say so, and re-select their consoles when it is back (the runner kept the output).
  manager.on('connectivity', (workspace, online) => io.to(sessionRoom(workspace.session)).emit('runner-state', {online}));
  // Browsers of a deleted session reload, which opens the user's new session.
  manager.on('removed', ({session}) => {
    ownerViews.delete(session.id);
    controllerViews.delete(session.id);
    control.release(session.id, null, 'session deleted');
    io.to(sessionRoom(session)).emit('session-deleted', {sessionId: session.id});
    io.in(sessionRoom(session)).disconnectSockets(true);
  });

  io.on('connection', socket => {
    const user = socket.data.user;
    const target = socket.handshake.auth?.observe;
    const observer = typeof target === 'string' && target !== '' && target !== user.login;
    let workspace;
    try {
      if (observer && user.role !== 'admin') throw new Error('Administrator role required to observe a session.');
      // Observing never creates a session.
      workspace = observer ? manager.get(target) : manager.open(user.login);
      if (!workspace) throw new Error(`No session for ${target}.`);
    } catch (error) {
      // An observer whose target has no session (never used since the server started, or
      // deleted) gets a distinct event, so that its page can say so instead of breaking.
      if (observer && user.role === 'admin') socket.emit('observe-unavailable', {login: target, error: error.message});
      socket.emit('node-error', error.message);
      socket.disconnect(true);
      return;
    }
    transports.track(socket, {login: user.login, main: socket.handshake.auth?.main === true, observer});
    // Console access is where an observation really starts: audited here, once per admin and
    // observed login while their sockets stay open.
    // Control ends when the controlling admin's last observer socket on the session closes.
    if (observer) {
      observations.opened(user.login, workspace.owner);
      socket.on('disconnect', () => {
        if (!observations.closed(user.login, workspace.owner)) control.release(workspace.session.id, user.login, 'disconnected');
      });
    }
    if (!observer && socket.handshake.auth?.main === true) {
      browsers.set(user.login, (browsers.get(user.login) || 0) + 1);
      socket.on('disconnect', () => {
        const count = browsers.get(user.login) - 1;
        if (count > 0) browsers.set(user.login, count); else browsers.delete(user.login);
      });
    }
    const {session, runner} = workspace;
    socket.data.observer = observer;
    socket.join(sessionRoom(session));
    if (observer) socket.join(observerRoom(session));
    // Only nodes of this socket's session are ever looked up: the handle names the session.
    const validId = id => typeof id === 'string' && id.length <= 64;
    // The control state of the session, for this socket's page (also after a reconnection).
    const controlLock = control.get(session.id);
    socket.emit('console-control', {admin: controlLock ? controlLock.admin : null, active: !!controlLock});
    const refuse = message => socket.emit('node-error', message);
    // A socket outlives the checks of its handshake: every privileged event re-reads the
    // account, and the socket is closed once it is disabled, removed, or (for an observer)
    // no longer admin.
    const authorized = () => {
      const current = currentUser(user.login, user.via);
      if (current && (!observer || current.role === 'admin')) return true;
      socket.emit('node-error', 'Your account is no longer allowed to use this session.');
      socket.disconnect(true);
      return false;
    };
    const guard = handler => (...args) => { if (authorized()) handler(...args); };
    let selectionQueue = Promise.resolve();
    // The node and console rooms are joined before the snapshot is asked for: output produced
    // meanwhile reaches the page before the snapshot, which replaces it. The previous
    // selection's rooms are left once the runner confirmed the new one.
    const joinRooms = id => Promise.all([socket.join(nodeRoom(session, baseNodeId(id))), socket.join(consoleRoom(session, id))]);
    const leaveRooms = async (id, keep = null) => {
      if (baseNodeId(id) !== baseNodeId(keep)) await socket.leave(nodeRoom(session, baseNodeId(id)));
      if (id !== keep) await socket.leave(consoleRoom(session, id));
    };
    socket.on('select-node', guard((id, token, acknowledge) => {
      selectionQueue = selectionQueue.then(async () => {
        if (!validId(id)) throw new Error('Unknown node.');
        const previous = socket.data.nodeId;
        await joinRooms(id);
        let snapshot;
        try { snapshot = await runner.request('console.attach', {nodeId: id}); }
        catch (error) {
          if (id !== previous) await leaveRooms(id, previous);
          throw error;
        }
        if (previous && previous !== id) await leaveRooms(previous, id);
        socket.data.nodeId = id;
        const {nodeId, state, logs, serial} = snapshot;
        socket.emit('node-snapshot', {nodeId, token, state, logs, serial});
        if (typeof acknowledge === 'function') acknowledge({ok: true});
      }).catch(error => {
        socket.emit('node-error', error.message);
        if (typeof acknowledge === 'function') acknowledge({error: error.message});
      });
    }));
    // View states are validated against the session's node IDs, asked from the runner; a
    // queue keeps them in the order they were published.
    let viewQueue = Promise.resolve();
    const withNodeIds = task => {
      viewQueue = viewQueue.then(async () => task(await runner.request('nodes.ids'))).catch(() => {});
    };
    // What the owner looks at (a view state, public/view-state.js, validated by normalizeView
    // against the session's nodes), published by the owner's page itself whenever it changes. Console sockets attaching in the background (select-node) say nothing about it.
    // Relayed to observers as owner-view.
    socket.on('owner-view', guard(received => {
      if (observer) return;
      withNodeIds(nodeIds => {
        const view = normalizeView(received, nodeIds);
        if (!view) return;
        ownerViews.set(session.id, view);
        io.to(observerRoom(session)).emit('owner-view', view);
      });
    }));
    if (observer && ownerViews.has(session.id)) socket.emit('owner-view', ownerViews.get(session.id));
    // The reverse direction, while this observer's user holds control of a node of the session:
    // the owner's pages show the controller's view (validated like an owner view).
    socket.on('controller-view', guard(received => {
      if (!observer || !control.heldBy(session.id, user.login)) return;
      withNodeIds(nodeIds => {
        const view = control.heldBy(session.id, user.login) && normalizeView(received, nodeIds);
        if (!view) return;
        controllerViews.set(session.id, view);
        io.to(sessionRoom(session)).emit('controller-view', view);
      });
    }));
    if (!observer && controllerViews.has(session.id)) socket.emit('controller-view', controllerViews.get(session.id));
    socket.on('leave-node', id => {
      if (id !== socket.data.nodeId) return;
      leaveRooms(id);
      socket.data.nodeId = null;
    });
    socket.on('input', guard(data => {
      const nodeId = socket.data.nodeId;
      if (!nodeId || typeof data !== 'string' || data.length > 4096) return;
      const refusal = inputRefusal({observer, lock: control.get(session.id), admin: user.login});
      // The owner's UI shows the control banner: their refused keys are dropped silently.
      if (refusal) { if (observer) refuse(refusal); return; }
      if (observer) control.touch(session.id, user.login);
      else session.touch();
      runner.input(nodeId, data);
    }));
    // Resizing and clearing change what every viewer of the node sees: never for observers.
    socket.on('terminal-resize', guard(request => {
      if (observer) return refuse('Read-only observation: the console cannot be resized.');
      if (!request || !request.id || request.id !== socket.data.nodeId) return;
      const cols = Number(request.cols);
      const rows = Number(request.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) return;
      runner.request('console.resize', {nodeId: request.id, cols, rows}).catch(() => {});
    }));
    // The live view of the Capture dialog (server/capture-live.js): the owner, or the admin holding the control lock.
    attachCaptureLive(socket, {runner, guard, allowed: () => !observer || control.heldBy(session.id, user.login),
      record: ({nodeId, captureId}) => { if (observer) audit.record(user.login, 'capture-viewed', {login: workspace.owner, nodeId, captureId}); }});
    // A capture lasts as long as the dialog of the tab that started it (server/capture-lease.js).
    attachCaptureLease(socket, {runner, guard, leases: leasesOf(session.id), allowed: () => !observer || control.heldBy(session.id, user.login),
      record: ({nodeId, captureId}) => { if (observer) audit.record(user.login, 'capture-discarded', {login: workspace.owner, nodeId, captureId}); }});
    socket.on('clear-console', guard(request => {
      if (observer) return refuse('Read-only observation: the console cannot be cleared.');
      if (!request || !request.id || request.id !== socket.data.nodeId) return;
      const line = typeof request.line === 'string' ? request.line.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 1024) : '';
      const column = Number.isInteger(request.column) ? Math.max(0, Math.min(request.column, 1024)) : line.length;
      runner.request('console.clear', {nodeId: request.id, line, column}).catch(() => {});
    }));
    // Exclusive control of the session's consoles, for observers: from any of the admin's
    // observer sockets on the session, whatever node it shows.
    socket.on('take-control', guard(acknowledge => {
      const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
      if (!observer) return reply({error: 'Only an administrator observing this session can take control.'});
      try {
        if (control.take(session.id, {admin: user.login, login: workspace.owner})) {
          audit.record(user.login, 'control-start', {login: workspace.owner});
          io.to(sessionRoom(session)).emit('console-control', {admin: user.login, active: true});
        }
        reply({ok: true});
      } catch (error) { reply({error: error.message}); }
    }));
    socket.on('release-control', guard(acknowledge => {
      const released = observer && control.release(session.id, user.login, 'released');
      if (typeof acknowledge === 'function') acknowledge({ok: released});
    }));
  });

  return {
    browsers: login => browsers.get(login) || 0,
    connections: () => transports.summary(),
    // Whether `admin` holds the console-control lock of a session (the capture routes of an observing admin).
    controlHeld: (sessionId, admin) => control.heldBy(sessionId, admin),
    // Closes every socket of a user at once (account disabled or role changed from /admin),
    // so that passive sockets stop receiving console output too.
    disconnectUser(login) {
      for (const socket of io.sockets.sockets.values()) if (socket.data.user?.login === login) socket.disconnect(true);
    }
  };
}

module.exports = {attachSockets, sessionRoom, nodeRoom, consoleRoom, inputRefusal, createObservationTracker};
