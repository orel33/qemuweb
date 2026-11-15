'use strict';

// Socket.IO layer: forwards runner events to browsers and relays console input.
// Event names and payloads are the wire format the browser relies on.
// Rooms keep sessions apart:
//   session:<sessionId>           every browser of the session's owner (per-session events)
//   node:<sessionId>:<nodeId>     browsers that selected that node (per-node events); a socket
//                                 joins it only for a node of its own session
// The handshake must already have set socket.data.user (see lib/auth/).

function sessionRoom(session) { return `session:${session.id}`; }
function nodeRoom(session, nodeId) { return `node:${session.id}:${nodeId}`; }

// Forwards the events of one session's runner to that session's browsers only.
function bindWorkspace(io, {session, runner}) {
  for (const event of ['state', 'log', 'logs-reset', 'serial', 'serial-reset']) {
    runner.events.on(event, payload => io.to(nodeRoom(session, payload.nodeId)).emit(event, payload));
  }
  runner.events.on('state', state => io.to(sessionRoom(session)).emit('nodes-changed', state));
  runner.events.on('nodes-removed', payload => io.to(sessionRoom(session)).emit('nodes-removed', payload));
}

function attachSockets(io, manager) {
  for (const workspace of manager.list()) bindWorkspace(io, workspace);
  manager.on('created', workspace => bindWorkspace(io, workspace));

  io.on('connection', socket => {
    let workspace;
    try { workspace = manager.open(socket.data.user.login); }
    catch (error) {
      socket.emit('node-error', error.message);
      socket.disconnect(true);
      return;
    }
    const {session, runner} = workspace;
    socket.join(sessionRoom(session));
    // Only nodes of this socket's own session are ever looked up.
    const ownNode = id => (typeof id === 'string' && session.nodes.get(id)) || null;
    let selectionQueue = Promise.resolve();
    socket.on('select-node', (id, token, acknowledge) => {
      selectionQueue = selectionQueue.then(async () => {
        const node = ownNode(id);
        if (!node) throw new Error('Unknown node.');
        if (socket.data.nodeId && socket.data.nodeId !== node.id) {
          await socket.leave(nodeRoom(session, socket.data.nodeId));
        }
        await socket.join(nodeRoom(session, node.id));
        socket.data.nodeId = node.id;
        const {nodeId, state, logs, serial} = runner.attachConsole(node.id);
        socket.emit('node-snapshot', {nodeId, token, state, logs, serial});
        if (typeof acknowledge === 'function') acknowledge({ok: true});
      }).catch(error => {
        socket.emit('node-error', error.message);
        if (typeof acknowledge === 'function') acknowledge({error: error.message});
      });
    });
    socket.on('leave-node', id => {
      if (id !== socket.data.nodeId) return;
      socket.leave(nodeRoom(session, id));
      socket.data.nodeId = null;
    });
    socket.on('input', data => {
      const node = ownNode(socket.data.nodeId);
      if (!node || typeof data !== 'string' || data.length > 4096) return;
      runner.writeConsoleInput(node, data);
    });
    socket.on('terminal-resize', request => {
      if (!request || request.id !== socket.data.nodeId) return;
      const node = ownNode(request.id);
      if (!node || node.kind !== 'switch' || !node.switchTerminal) return;
      const cols = Number(request.cols);
      const rows = Number(request.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) return;
      runner.resizeSwitchTerminal(node, cols, rows);
    });
    socket.on('clear-console', request => {
      if (!request || request.id !== socket.data.nodeId) return;
      const node = ownNode(request.id);
      if (!node) return;
      const line = typeof request.line === 'string' ? request.line.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 1024) : '';
      const column = Number.isInteger(request.column) ? Math.max(0, Math.min(request.column, 1024)) : line.length;
      runner.clearConsole(node, line, column);
    });
  });
}

module.exports = {attachSockets, sessionRoom, nodeRoom};
