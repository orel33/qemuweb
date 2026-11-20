'use strict';

// A capture lasts as long as the Capture dialog of the tab that started it: the tab leases the
// capture on its socket, and when that socket closes (tab closed, reload, crash, lost network) the
// capture is stopped and its file deleted, so nothing keeps recording with no dialog to show it.
// A lease belongs to one socket: another tab of the session can ask which captures are leased (to
// show them read-only and to leave them alone) but never takes one over. The server only relays to
// the runner. The owner, and an administrator holding the session's control lock, may use it; any
// other observer is refused.
//   socket -> server  'capture-lease' {nodeId, captureId}, ack {ok}|{error}
//                     'capture-unlease' {captureId}   (the dialog discarded the capture itself)
//                     'capture-leased' {nodeId}, ack {leased: [captureId]}   (leased by any tab)
const {isCaptureId} = require('../common/capture');

const MAX_LEASES = 64;
const keyOf = (nodeId, captureId) => `${nodeId}/${captureId}`;

// leases: the Map of the session shared by its sockets, `${nodeId}/${captureId}` -> socket ID.
// allowed(): whether this socket may capture. record(entry): the audit entry of a capture
// discarded at disconnect (an administrator's action; the owner's own tab is not logged).
function attachCaptureLease(socket, {runner, guard, allowed, leases, record = () => {}}) {
  const own = () => [...leases].filter(([, id]) => id === socket.id);
  const validNode = nodeId => typeof nodeId === 'string' && nodeId.length <= 64 && !nodeId.includes('/');

  socket.on('capture-lease', guard((request, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    const {nodeId, captureId} = request || {};
    if (!allowed()) return reply({error: 'Read-only observation: take control of the session to use captures.'});
    if (!validNode(nodeId) || !isCaptureId(captureId)) return reply({error: 'Unknown capture.'});
    const key = keyOf(nodeId, captureId);
    if (leases.has(key) && leases.get(key) !== socket.id) return reply({error: 'This capture belongs to another window.'});
    if (!leases.has(key) && own().length >= MAX_LEASES) return reply({error: 'Too many captures.'});
    leases.set(key, socket.id);
    reply({ok: true});
  }));

  socket.on('capture-unlease', guard(request => {
    const key = keyOf(request?.nodeId, request?.captureId);
    if (leases.get(key) === socket.id) leases.delete(key);
  }));

  socket.on('capture-leased', guard((request, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!allowed()) return reply({error: 'Read-only observation: take control of the session to use captures.'});
    if (!validNode(request?.nodeId)) return reply({error: 'Unknown node.'});
    const prefix = `${request.nodeId}/`;
    reply({leased: [...leases.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))});
  }));

  // Stop, then delete: the runner refuses to delete a recording capture, and a stopped one is
  // simply deleted. Errors (a node or a capture already gone) are of no use to anybody.
  socket.on('disconnect', async () => {
    const entries = own();
    for (const [key] of entries) leases.delete(key);
    for (const [key] of entries) {
      const [nodeId, captureId] = key.split('/');
      await runner.request('capture.stop', {nodeId, captureId}).catch(() => {});
      await runner.request('capture.delete', {nodeId, captureId}).then(() => record({nodeId, captureId}), () => {});
    }
  });
}

module.exports = {attachCaptureLease, MAX_LEASES};
