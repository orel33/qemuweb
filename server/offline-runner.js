'use strict';

// The placeholder client of a runner that has not (yet) reconnected after a server restart.
// A session restored from bindings.json lives behind this client: it is a RunnerClient over a connection
// that is closed for good, so every request answers 503 ("offline"), console input is dropped and
// streams are refused, while the session handle (its events, its identity) already exists for the
// routers and sockets. When the bound runner says hello and reports the session, the real client
// adopts the handle (RunnerClient.adopt): same object, same session ID, machines and consoles continue.
// Nothing here reaches a runner or a file.
const {EventEmitter} = require('events');
const {RunnerClient} = require('./runner-client');

const offline = () => Object.assign(new Error('The runner is offline; reconnecting…'), {status: 503});

class OfflineConnection extends EventEmitter {
  get closed() { return true; }
  send() {}
  outgoing() { throw offline(); }
  incoming() { throw offline(); }
  close() {}
}

function createOfflineClient() { return new RunnerClient(new OfflineConnection()); }

module.exports = {createOfflineClient, OfflineConnection};
