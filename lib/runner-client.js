'use strict';

// Control-plane side of one runner connection (see "Runner interface" in docs/architecture.md).
// One client per runner connection, never shared between runners. The control plane reaches a
// session only through its handle, client.session(sessionId):
//   request(command, args)   Promise of the runner's result; rejects with an Error carrying
//                            the runner's message and, when the runner chose it, .status
//   input(nodeId, data)      console keystrokes, no response
//   events                   EventEmitter of the session's runner events (state, log, ...)
//   outgoing()               {id, stream}: a Writable sent to the runner (archive upload)
//   incoming(id)             the Readable of a runner stream (archive download)
// The client emits 'hello' (the runner's hello message) and 'close' (error or null).
// Events for a session that has no handle on this client are dropped: a runner only speaks
// for the sessions bound to it.
const {EventEmitter} = require('events');

class RunnerClient extends EventEmitter {
  constructor(connection) {
    super();
    this.connection = connection;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
    this.hello = null;
    connection.on('message', message => this.receive(message));
    connection.on('close', error => {
      const lost = Object.assign(new Error('Runner connection lost.'), {status: 503});
      for (const {reject} of this.pending.values()) reject(lost);
      this.pending.clear();
      this.emit('close', error);
    });
  }

  get closed() { return this.connection.closed; }

  receive(message) {
    if (message.type === 'hello') {
      this.hello = message;
      this.emit('hello', message);
    } else if (message.type === 'response') {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(typeof message.error.message === 'string' ? message.error.message : 'Runner error.');
        if (Number.isInteger(message.error.status) && message.error.status >= 400 && message.error.status < 600) error.status = message.error.status;
        entry.reject(error);
      } else entry.resolve(message.result);
    } else if (message.type === 'event') {
      const handle = typeof message.sessionId === 'string' && this.sessions.get(message.sessionId);
      if (handle && typeof message.event === 'string') handle.events.emit(message.event, message.payload);
    }
  }

  // A request outside any session (runner.shutdown) when sessionId is null.
  request(command, args = {}, sessionId = null) {
    if (this.closed) return Promise.reject(Object.assign(new Error('Runner connection lost.'), {status: 503}));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.connection.send({type: 'request', id, command, ...(sessionId ? {sessionId} : {}), args});
    });
  }

  // The handle of one session bound to this runner (created on first use).
  session(sessionId) {
    let handle = this.sessions.get(sessionId);
    if (handle) return handle;
    handle = {
      sessionId,
      events: new EventEmitter(),
      request: (command, args = {}) => this.request(command, args, sessionId),
      input: (nodeId, data) => this.connection.send({type: 'input', sessionId, nodeId, data}),
      outgoing: () => this.connection.outgoing(),
      incoming: id => this.connection.incoming(id)
    };
    this.sessions.set(sessionId, handle);
    return handle;
  }

  // Forgets a session: its events are dropped from now on.
  release(sessionId) {
    const handle = this.sessions.get(sessionId);
    if (!handle) return;
    handle.events.removeAllListeners();
    this.sessions.delete(sessionId);
  }

  close() { this.connection.close(); }
}

module.exports = {RunnerClient};
