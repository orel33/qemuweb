'use strict';

// The live view of the Capture dialog, on one browser socket (the page's session socket): the socket asks for the text of a
// capture and receives it as it arrives. The server only relays: the runner reads the PCAP and runs
// tcpdump (runner/capture-live.js). A socket has at most one view; it ends when the dialog asks, when
// the socket closes, or by itself (the runner says why). The owner, and an administrator holding
// the session's control lock, may use it; any other observer is refused.
//   socket -> server  'capture-live' {nodeId, captureId, filter?}, ack {ok}|{error}
//                     'capture-live-stop'
//   server -> socket  'capture-live-data' {data}, 'capture-live-end' {message}
const crypto = require('crypto');
const {isCaptureId, FILTER_MAX} = require('../common/capture');

// allowed(): whether this socket may capture. record(request): the audit entry of a started view
// (an administrator's actions; the owner's own view is not logged).
function attachCaptureLive(socket, {runner, guard, allowed, record = () => {}}) {
  let live = null; // {id, onEvent}

  function release() {
    if (!live) return null;
    const {id, onEvent} = live;
    live = null;
    runner.events.off('capture-live', onEvent);
    return id;
  }

  // Ends the view and tells the runner (which kills tcpdump); a runner that cannot be reached
  // ends the view with its connection.
  async function stop() {
    const id = release();
    if (id) await runner.request('capture.live.stop', {liveId: id}).catch(() => {});
  }

  socket.on('capture-live', guard(async (request, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    try {
      if (!allowed()) throw new Error('Read-only observation: take control of the session to use captures.');
      const {nodeId, captureId, filter} = request || {};
      if (typeof nodeId !== 'string' || nodeId.length > 64 || !isCaptureId(captureId)) throw new Error('Unknown capture.');
      if (filter !== undefined && (typeof filter !== 'string' || filter.length > FILTER_MAX)) throw new Error(`The filter is too long (at most ${FILTER_MAX} characters).`);
      await stop();
      const id = crypto.randomBytes(8).toString('hex');
      // Listening starts before the request: the first text can come right behind the answer.
      const onEvent = payload => {
        if (payload?.liveId !== id) return;
        if (typeof payload.data === 'string') socket.emit('capture-live-data', {data: payload.data});
        if (typeof payload.end === 'string') { release(); socket.emit('capture-live-end', {message: payload.end}); }
      };
      live = {id, onEvent};
      runner.events.on('capture-live', onEvent);
      try { await runner.request('capture.live.start', {liveId: id, nodeId, captureId, filter}); }
      catch (error) { release(); throw error; }
      record({nodeId, captureId});
      reply({ok: true});
    } catch (error) { reply({error: error.message}); }
  }));
  socket.on('capture-live-stop', () => { stop(); });
  socket.on('disconnect', () => { stop(); });
}

module.exports = {attachCaptureLive};
