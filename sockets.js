'use strict';

// Socket.IO layer: forwards runner events to browsers and relays console input.
// Event names and payloads are the wire format the browser relies on.

function attachSockets(io, runner) {
  // Per-node events reach only the browsers that selected the node.
  for (const event of ['state', 'log', 'logs-reset', 'serial', 'serial-reset']) {
    runner.events.on(event, payload => io.to(payload.nodeId).emit(event, payload));
  }
  runner.events.on('state', state => io.emit('nodes-changed', state));
  runner.events.on('nodes-removed', payload => io.emit('nodes-removed', payload));

  io.on('connection', socket => {
    let selectionQueue = Promise.resolve();
    socket.on('select-node', (id, token, acknowledge) => {
      selectionQueue = selectionQueue.then(async () => {
        const node = runner.getNode(id);
        if (!node) throw new Error('Unknown node.');
        if (socket.nodeId && socket.nodeId !== id) {
          await socket.leave(socket.nodeId);
        }
        await socket.join(id);
        socket.nodeId = node.id;
        const {nodeId, state, logs, serial} = runner.attachConsole(id);
        socket.emit('node-snapshot', {nodeId, token, state, logs, serial});
        if (typeof acknowledge === 'function') acknowledge({ok: true});
      }).catch(error => {
        socket.emit('node-error', error.message);
        if (typeof acknowledge === 'function') acknowledge({error: error.message});
      });
    });
    socket.on('leave-node', id => {
      if (id !== socket.nodeId) return;
      socket.leave(id);
      socket.nodeId = null;
    });
    socket.on('input', data => {
      const node = socket.nodeId && runner.getNode(socket.nodeId);
      if (!node || typeof data !== 'string' || data.length > 4096) return;
      runner.writeConsoleInput(node, data);
    });
    socket.on('terminal-resize', request => {
      if (!request || request.id !== socket.nodeId) return;
      const node = runner.getNode(request.id);
      if (!node || node.kind !== 'switch' || !node.switchTerminal) return;
      const cols = Number(request.cols);
      const rows = Number(request.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) return;
      runner.resizeSwitchTerminal(node, cols, rows);
    });
    socket.on('clear-console', request => {
      if (!request || request.id !== socket.nodeId) return;
      const node = runner.getNode(request.id);
      if (!node) return;
      const line = typeof request.line === 'string' ? request.line.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 1024) : '';
      const column = Number.isInteger(request.column) ? Math.max(0, Math.min(request.column, 1024)) : line.length;
      runner.clearConsole(node, line, column);
    });
  });
}

module.exports = {attachSockets};
