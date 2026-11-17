'use strict';

// Where runners reach the server: the Unix socket runtime/runner-<port>.sock (mode 0600, so
// only the server's own user can connect). A runner always dials the server, never the reverse.
// A connection is registered as the runner "local", trusted: whoever can open this socket is
// the server's own user. One runner at a time; a second connection is closed at once.
//   start()   removes a stale socket (refuses the one of a live server) and listens
//   close()   stops listening and removes the socket
// Runners that are not on this machine or this user come with 5c (tokens, TLS); they will
// never be trusted by this path.
const fs = require('fs');
const net = require('net');
const path = require('path');
const {Connection} = require('../common/runner-protocol');
const {RunnerClient} = require('./runner-client');

function createRunnerGateway({root, runtimeRoot, port, registry}) {
  const socketPath = path.join(runtimeRoot, `runner-${port}.sock`);
  let server = null;
  const gateway = {socketPath, start, close};

  // Refuses to take over the socket of a live server on the same port; removes a stale one.
  async function prepareSocket() {
    if (Buffer.byteLength(socketPath) > 107) throw new Error('Runner socket path is too long; move the project to a shorter directory.');
    if (!fs.existsSync(socketPath)) return;
    const alive = await new Promise(resolve => {
      const probe = net.createConnection(socketPath);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (alive) throw new Error(`Port ${port} is already in use by another QemuWeb server (${path.relative(root, socketPath)}).`);
    fs.unlinkSync(socketPath);
  }

  function onConnection(socket) {
    const current = registry.get('local');
    if (current && current.state !== 'lost') { socket.destroy(); return; }
    registry.add({id: 'local', client: new RunnerClient(new Connection(socket)), trusted: true});
  }

  async function start() {
    await prepareSocket();
    server = net.createServer(onConnection);
    const umask = process.umask(0o177);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
    } finally { process.umask(umask); }
    fs.chmodSync(socketPath, 0o600);
  }

  function close() {
    if (server) server.close();
    try { fs.unlinkSync(socketPath); } catch (_) {}
  }

  return gateway;
}

module.exports = {createRunnerGateway};
