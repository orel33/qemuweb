'use strict';

// Socket.IO layer: forwards runner events to browsers and relays console input.
// Event names and payloads are the wire format the browser relies on.
// Rooms keep sessions apart:
//   session:<sessionId>           every browser of the session's owner, and of the admins
//                                 observing it (per-session events)
//   observers:<sessionId>         the admins observing the session (owner-selected-node)
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

// audit: lib/audit.js. Returns {disconnectUser(login)}.
function attachSockets(io, manager, {audit, control: options = {}}) {
  const control = new ConsoleControl({...options, onRelease: (lock, reason) => {
    io.to(`session:${lock.sessionId}`).emit('console-control', {nodeId: lock.nodeId, admin: lock.admin, active: false});
    audit.record(lock.admin, 'control-end', {login: lock.login, nodeId: lock.nodeId, reason});
  }});
  for (const workspace of manager.list()) bindWorkspace(io, workspace, control);
  manager.on('created', workspace => bindWorkspace(io, workspace, control));
  // Browsers of a deleted session reload, which opens the user's new session.
  manager.on('removed', ({session}) => {
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
      socket.emit('node-error', error.message);
      socket.disconnect(true);
      return;
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
    let selectionQueue = Promise.resolve();
    socket.on('select-node', (id, token, acknowledge) => {
      selectionQueue = selectionQueue.then(async () => {
        const node = sessionNode(id);
        if (!node) throw new Error('Unknown node.');
        if (socket.data.nodeId && socket.data.nodeId !== node.id) {
          control.release(session.id, socket.data.nodeId, socket, 'released');
          await socket.leave(nodeRoom(session, socket.data.nodeId));
        }
        await socket.join(nodeRoom(session, node.id));
        socket.data.nodeId = node.id;
        const {nodeId, state, logs, serial} = runner.attachConsole(node.id);
        socket.emit('node-snapshot', {nodeId, token, state, logs, serial, control: controlInfo(nodeId)});
        // Observers follow the node the owner selects.
        if (!observer) io.to(observerRoom(session)).emit('owner-selected-node', {nodeId});
        if (typeof acknowledge === 'function') acknowledge({ok: true});
      }).catch(error => {
        socket.emit('node-error', error.message);
        if (typeof acknowledge === 'function') acknowledge({error: error.message});
      });
    });
    socket.on('leave-node', id => {
      if (id !== socket.data.nodeId) return;
      control.release(session.id, id, socket, 'released');
      socket.leave(nodeRoom(session, id));
      socket.data.nodeId = null;
    });
    socket.on('input', data => {
      const node = sessionNode(socket.data.nodeId);
      if (!node || typeof data !== 'string' || data.length > 4096) return;
      const refusal = inputRefusal({observer, lock: control.get(session.id, node.id), holder: socket});
      // The owner's UI shows the control banner: their refused keys are dropped silently.
      if (refusal) { if (observer) refuse(refusal); return; }
      if (observer) control.touch(session.id, node.id, socket);
      else session.touch();
      runner.writeConsoleInput(node, data);
    });
    // Resizing and clearing change what every viewer of the node sees: never for observers.
    socket.on('terminal-resize', request => {
      if (observer) return refuse('Read-only observation: the console cannot be resized.');
      if (!request || request.id !== socket.data.nodeId) return;
      const node = sessionNode(request.id);
      if (!node || node.kind !== 'switch' || !node.switchTerminal) return;
      const cols = Number(request.cols);
      const rows = Number(request.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) return;
      runner.resizeSwitchTerminal(node, cols, rows);
    });
    socket.on('clear-console', request => {
      if (observer) return refuse('Read-only observation: the console cannot be cleared.');
      if (!request || request.id !== socket.data.nodeId) return;
      const node = sessionNode(request.id);
      if (!node) return;
      const line = typeof request.line === 'string' ? request.line.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 1024) : '';
      const column = Number.isInteger(request.column) ? Math.max(0, Math.min(request.column, 1024)) : line.length;
      runner.clearConsole(node, line, column);
    });
    // Exclusive control of the selected node's console, for observers.
    socket.on('take-control', (id, acknowledge) => {
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
    });
    socket.on('release-control', (id, acknowledge) => {
      const released = typeof id === 'string' && control.release(session.id, id, socket, 'released');
      if (typeof acknowledge === 'function') acknowledge({ok: released});
    });
    socket.on('disconnect', () => control.releaseHolder(socket, 'disconnected'));
  });

  return {
    // Closes every socket of a user (account disabled or role changed).
    disconnectUser(login) {
      for (const socket of io.sockets.sockets.values()) if (socket.data.user?.login === login) socket.disconnect(true);
    }
  };
}

module.exports = {attachSockets, sessionRoom, nodeRoom, inputRefusal};
