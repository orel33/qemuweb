'use strict';

// Runner side of one protocol connection (common/runner-protocol.js Connection): sends hello,
// runs requests through the service (runner/service.js), forwards its events, and applies
// console input. Requests start in arrival order; their responses go out as they finish.
//
// Console output ('serial' events) is coalesced per node and flushed once per event-loop turn,
// always before any other event so that a node's events keep their order. While the
// connection's write buffer holds more than CONGESTED_BYTES, console sources are paused (the
// guest blocks on its UART), and resumed on 'drain': nothing is dropped.
const CONGESTED_BYTES = 8 * 1024 * 1024;

function serveConnection(connection, service) {
  const pendingSerial = new Map();
  let flushScheduled = false;

  function flushSerial() {
    flushScheduled = false;
    for (const [key, {sessionId, nodeId, data}] of pendingSerial) {
      pendingSerial.delete(key);
      connection.send({type: 'event', sessionId, event: 'serial', payload: {nodeId, data}});
    }
    if (connection.pendingBytes > CONGESTED_BYTES) service.setConsoleFlow(true);
  }

  function onEvent(sessionId, event, payload) {
    if (connection.closed) return;
    if (event === 'serial') {
      const key = `${sessionId}:${payload.nodeId}`;
      const pending = pendingSerial.get(key);
      if (pending) pending.data += payload.data;
      else pendingSerial.set(key, {sessionId, nodeId: payload.nodeId, data: payload.data});
      if (!flushScheduled) { flushScheduled = true; setImmediate(flushSerial); }
      return;
    }
    if (pendingSerial.size) flushSerial();
    connection.send({type: 'event', sessionId, event, payload});
  }

  function respond(id, work) {
    const after = [];
    const io = {
      incoming: streamId => connection.incoming(streamId),
      outgoing: () => connection.outgoing(),
      afterResponse: callback => after.push(callback)
    };
    // The command starts synchronously, so that it runs before the messages that follow it.
    let outcome;
    try { outcome = Promise.resolve(work(io)); } catch (error) { outcome = Promise.reject(error); }
    // Pending console output goes first: a console.attach snapshot already contains it.
    outcome.then(result => {
      if (pendingSerial.size) flushSerial();
      connection.send({type: 'response', id, result: result === undefined ? null : result});
      for (const callback of after) callback();
    }, error => {
      if (pendingSerial.size) flushSerial();
      connection.send({type: 'response', id, error: {message: error.message, ...(Number.isInteger(error.status) ? {status: error.status} : {})}});
    });
  }

  connection.on('message', message => {
    if (message.type === 'input') service.input(message.sessionId, message.nodeId, message.data);
    else if (message.type === 'request' && Number.isSafeInteger(message.id)) {
      respond(message.id, io => service.handle(message.command, message.sessionId, message.args || {}, io));
    }
  });
  connection.on('drain', () => service.setConsoleFlow(false));
  service.events.on('event', onEvent);
  connection.on('close', () => {
    service.events.off('event', onEvent);
    pendingSerial.clear();
    service.setConsoleFlow(false);
  });
  connection.send(service.hello());
}

module.exports = {serveConnection, CONGESTED_BYTES};
