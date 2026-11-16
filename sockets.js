'use strict';

// Socket.IO layer: forwards runner events to browsers and relays console input.
// Event names and payloads are the wire format the browser relies on.
// Rooms keep sessions apart:
//   session:<sessionId>           every browser of the session's owner, and of the admins
//                                 observing it (per-session events)
//   observers:<sessionId>         the admins observing the session (owner-view)
// While an admin controls a console of a session, the view goes the other way: the admin's
// page publishes controller-view, relayed to the session room and shown by the owner's pages.
//   node:<sessionId>:<nodeId>     browsers that selected that node (per-node events); a socket
//                                 joins it only for a node of its own or observed session
// The handshake must already have set socket.data.user (see lib/auth/). An admin observes
// another user's session with the handshake option auth: {observe: <login>}: the socket then
// reads that session (snapshots, console output, logs) but its input, clear-console and
// terminal-resize are refused, unless it took control of the node (input only), see
// lib/console-control.js.
const {ConsoleControl} = require('./lib/console-control');

function sessionRoom(session) { return `session:${session.id}`; }
function observerRoom(session) { return `observers:${session.id}`; }
function nodeRoom(session, nodeId) { return `node:${session.id}:${nodeId}`; }

// Why a socket may not type into a node's console, or null when it may.
// lock is the node's control lock (or null), holder the socket.
function inputRefusal({observer, lock, holder}) {
  if (observer) return lock?.holder === holder ? null : 'Read-only observation: take control to type into this console.';
  return lock ? `${lock.admin} controls this console.` : null;
}

// Audits observations once per (admin, observed login): the 'observe' line is written when
// the first observer socket of that pair opens; a page load opens several sockets.
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
    }
  };
}

// What the owner's page shows, from an owner-view event: its active node (a node of the session,
// else null), the view (terminals or graphic), the number of console panes (1, 2 or 4), whether
// switch consoles are shown, the console page, and the pane shown alone (or null). Unknown
// fields are dropped; returns null for an invalid view.
function ownerViewOf(view, session) {
  if (!view || typeof view !== 'object' || !['terminals', 'graphic'].includes(view.mode)) return null;
  if (![1, 2, 4].includes(view.layout) || typeof view.switches !== 'boolean') return null;
  if (!Number.isInteger(view.page) || view.page < 0 || view.page > 999) return null;
  if (view.expanded !== null && !(Number.isInteger(view.expanded) && view.expanded >= 0 && view.expanded < view.layout)) return null;
  const nodeId = typeof view.nodeId === 'string' && session.nodes.has(view.nodeId) ? view.nodeId : null;
  return {nodeId, mode: view.mode, layout: view.layout, switches: view.switches, page: view.page, expanded: view.expanded};
}

// Forwards the events of one session's runner to that session's browsers only.
function bindWorkspace(io, {session, runner}, control) {
  for (const event of ['state', 'log', 'logs-reset', 'serial', 'serial-reset']) {
    runner.events.on(event, payload => io.to(nodeRoom(session, payload.nodeId)).emit(event, payload));
  }
  runner.events.on('state', state => io.to(sessionRoom(session)).emit('nodes-changed', state));
  runner.events.on('nodes-removed', payload => {
    io.to(sessionRoom(session)).emit('nodes-removed', payload);
    for (const nodeId of payload.ids || []) control.release(session.id, nodeId, null, 'node deleted');
  });
}

// audit: lib/audit.js. currentUser(login) returns the account as it is now ({login, role}),
// or null once it is disabled or removed (lib/auth). Returns {disconnectUser(login), browsers(login)}.
function attachSockets(io, manager, {audit, currentUser, control: options = {}}) {
  // The controlling admin's last view, per session ID, kept only while a lock exists there.
  const controllerViews = new Map();
  const control = new ConsoleControl({...options, onRelease: (lock, reason) => {
    if (!control.hasLock(lock.sessionId)) controllerViews.delete(lock.sessionId);
    io.to(`session:${lock.sessionId}`).emit('console-control', {nodeId: lock.nodeId, admin: lock.admin, active: false});
    audit.record(lock.admin, 'control-end', {login: lock.login, nodeId: lock.nodeId, reason});
  }});
  const observations = createObservationTracker(audit);
  // Connected browser tabs per login: each tab opens one session socket (auth.main) besides
  // its console sockets. Observers are not counted.
  const browsers = new Map();
  // What the owner last showed, per session ID: {nodeId, mode}, sent to a new observer.
  const ownerViews = new Map();
  for (const workspace of manager.list()) bindWorkspace(io, workspace, control);
  manager.on('created', workspace => bindWorkspace(io, workspace, control));
  // Browsers of a deleted session reload, which opens the user's new session.
  manager.on('removed', ({session}) => {
    ownerViews.delete(session.id);
    controllerViews.delete(session.id);
    control.releaseSession(session.id, 'session deleted');
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
    // Console access is where an observation really starts: audited here, once per admin and
    // observed login while their sockets stay open.
    if (observer) {
      observations.opened(user.login, workspace.owner);
      socket.on('disconnect', () => observations.closed(user.login, workspace.owner));
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
    // Only nodes of this socket's session are ever looked up.
    const sessionNode = id => (typeof id === 'string' && session.nodes.get(id)) || null;
    const controlInfo = nodeId => {
      const lock = control.get(session.id, nodeId);
      return lock ? {admin: lock.admin} : null;
    };
    const refuse = message => socket.emit('node-error', message);
    // A socket outlives the checks of its handshake: every privileged event re-reads the
    // account, and the socket is closed once it is disabled, removed, or (for an observer)
    // no longer admin.
    const authorized = () => {
      const current = currentUser(user.login);
      if (current && (!observer || current.role === 'admin')) return true;
      socket.emit('node-error', 'Your account is no longer allowed to use this session.');
      socket.disconnect(true);
      return false;
    };
    const guard = handler => (...args) => { if (authorized()) handler(...args); };
    let selectionQueue = Promise.resolve();
    socket.on('select-node', guard((id, token, acknowledge) => {
      selectionQueue = selectionQueue.then(async () => {
        const node = sessionNode(id);
        if (!node) throw new Error('Unknown node.');
        // A console lock is not released here: the admin's page reassigns its panes on its own
        // (layout, node list, follow), which must never hand the keyboard back to the owner.
        // The holder types only into the node it holds (inputRefusal) and releases it explicitly.
        if (socket.data.nodeId && socket.data.nodeId !== node.id) await socket.leave(nodeRoom(session, socket.data.nodeId));
        await socket.join(nodeRoom(session, node.id));
        socket.data.nodeId = node.id;
        const {nodeId, state, logs, serial} = runner.attachConsole(node.id);
        socket.emit('node-snapshot', {nodeId, token, state, logs, serial, control: controlInfo(nodeId)});
        if (typeof acknowledge === 'function') acknowledge({ok: true});
      }).catch(error => {
        socket.emit('node-error', error.message);
        if (typeof acknowledge === 'function') acknowledge({error: error.message});
      });
    }));
    // What the owner looks at (ownerViewOf), published by the owner's page itself whenever it
    // changes. Console sockets attaching in the background (select-node) say nothing about it.
    // Relayed to observers as owner-view.
    socket.on('owner-view', guard(received => {
      const view = !observer && ownerViewOf(received, session);
      if (!view) return;
      ownerViews.set(session.id, view);
      io.to(observerRoom(session)).emit('owner-view', view);
    }));
    if (observer && ownerViews.has(session.id)) socket.emit('owner-view', ownerViews.get(session.id));
    // The reverse direction, while this observer's user holds control of a node of the session:
    // the owner's pages show the controller's view (validated like an owner view).
    socket.on('controller-view', guard(received => {
      const view = observer && control.heldBy(session.id, user.login) && ownerViewOf(received, session);
      if (!view) return;
      controllerViews.set(session.id, view);
      io.to(sessionRoom(session)).emit('controller-view', view);
    }));
    if (!observer && controllerViews.has(session.id)) socket.emit('controller-view', controllerViews.get(session.id));
    socket.on('leave-node', id => {
      if (id !== socket.data.nodeId) return;
      socket.leave(nodeRoom(session, id));
      socket.data.nodeId = null;
    });
    socket.on('input', guard(data => {
      const node = sessionNode(socket.data.nodeId);
      if (!node || typeof data !== 'string' || data.length > 4096) return;
      const refusal = inputRefusal({observer, lock: control.get(session.id, node.id), holder: socket});
      // The owner's UI shows the control banner: their refused keys are dropped silently.
      if (refusal) { if (observer) refuse(refusal); return; }
      if (observer) control.touch(session.id, node.id, socket);
      else session.touch();
      runner.writeConsoleInput(node, data);
    }));
    // Resizing and clearing change what every viewer of the node sees: never for observers.
    socket.on('terminal-resize', guard(request => {
      if (observer) return refuse('Read-only observation: the console cannot be resized.');
      if (!request || request.id !== socket.data.nodeId) return;
      const node = sessionNode(request.id);
      if (!node || node.kind !== 'switch' || !node.switchTerminal) return;
      const cols = Number(request.cols);
      const rows = Number(request.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) return;
      runner.resizeSwitchTerminal(node, cols, rows);
    }));
    socket.on('clear-console', guard(request => {
      if (observer) return refuse('Read-only observation: the console cannot be cleared.');
      if (!request || request.id !== socket.data.nodeId) return;
      const node = sessionNode(request.id);
      if (!node) return;
      const line = typeof request.line === 'string' ? request.line.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 1024) : '';
      const column = Number.isInteger(request.column) ? Math.max(0, Math.min(request.column, 1024)) : line.length;
      runner.clearConsole(node, line, column);
    }));
    // Exclusive control of the selected node's console, for observers.
    socket.on('take-control', guard((id, acknowledge) => {
      const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
      const node = sessionNode(id);
      if (!observer) return reply({error: 'Only an administrator observing this session can take control.'});
      if (!node || node.id !== socket.data.nodeId) return reply({error: 'Select this node before taking control.'});
      try {
        if (control.take(session.id, node.id, {admin: user.login, login: workspace.owner, holder: socket})) {
          audit.record(user.login, 'control-start', {login: workspace.owner, nodeId: node.id});
          io.to(sessionRoom(session)).emit('console-control', {nodeId: node.id, admin: user.login, active: true});
        }
        reply({ok: true});
      } catch (error) { reply({error: error.message}); }
    }));
    socket.on('release-control', guard((id, acknowledge) => {
      const released = typeof id === 'string' && control.release(session.id, id, socket, 'released');
      if (typeof acknowledge === 'function') acknowledge({ok: released});
    }));
    socket.on('disconnect', () => control.releaseHolder(socket, 'disconnected'));
  });

  return {
    browsers: login => browsers.get(login) || 0,
    // Closes every socket of a user at once (account disabled or role changed from /admin),
    // so that passive sockets stop receiving console output too.
    disconnectUser(login) {
      for (const socket of io.sockets.sockets.values()) if (socket.data.user?.login === login) socket.disconnect(true);
    }
  };
}

module.exports = {attachSockets, sessionRoom, nodeRoom, inputRefusal, createObservationTracker, ownerViewOf};
