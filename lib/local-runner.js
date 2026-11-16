'use strict';

// The local runner: a child process of the server (runner/main.js), reached over the Unix
// socket runtime/runner-<port>.sock with the runner protocol, and registered as "local".
//   start()  listens on the socket, spawns the runner and resolves with its hello; rejects
//            when the first runner cannot start (the server then exits)
//   stop()   server stop, after registry.shutdown(): closes the connection (the runner exits),
//            waits for the process, kills what is left and removes the socket
//   kill()   last resort at process exit: SIGKILL to the runner's process group
// The runner runs in its own process group (detached), with QEMU and vde_switch: a terminal
// Ctrl+C reaches the server only, and one signal to the group ends them all. The runner is
// started with --exit-on-disconnect, so it destroys every node and exits when the server's
// connection drops, including when the server is killed.
//
// Runner loss (its connection drops or its process exits) while the server runs: the process
// group is killed, the runtime directories of its sessions are removed (the session manager
// drops the sessions themselves), and the runner is started again after 1, 2, then 4 s.
// onFatal(error) is called when three restarts in a row fail.
const fs = require('fs');
const net = require('net');
const path = require('path');
const {spawn} = require('child_process');
const {Connection} = require('../common/runner-protocol');
const {RunnerClient} = require('./runner-client');

const HELLO_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 5000;
const RESTART_DELAYS_MS = [1000, 2000, 4000];

// boundSessions() lists the IDs of the sessions bound to the local runner.
function createLocalRunner({root, runtimeRoot, configPath, port, registry, boundSessions, onFatal}) {
  const socketPath = path.join(runtimeRoot, `runner-${port}.sock`);
  let server = null;
  let current = null;
  let stopping = false;

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

  async function listen() {
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

  // A connection is accepted only from the runner being started, one at a time.
  function onConnection(socket) {
    const launch = current;
    if (!launch || launch.client || launch.lost) { socket.destroy(); return; }
    launch.client = new RunnerClient(new Connection(socket));
    registry.add({id: 'local', client: launch.client, onLost: () => lose(launch)});
    launch.client.once('hello', hello => {
      clearTimeout(launch.timer);
      launch.online = true;
      launch.resolve(hello);
    });
  }

  // Spawns one runner process; resolves with its hello.
  function launch() {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'runner', 'main.js'), '--connect', socketPath,
        '--runtime', runtimeRoot, '--config', configPath, '--exit-on-disconnect'],
      {cwd: root, detached: true, stdio: ['ignore', 'inherit', 'inherit']});
      const attempt = {child, client: null, online: false, lost: false, resolve, reject, timer: null};
      current = attempt;
      attempt.timer = setTimeout(() => {
        attempt.failure = new Error(`The runner did not start within ${HELLO_TIMEOUT_MS / 1000} s.`);
        lose(attempt);
      }, HELLO_TIMEOUT_MS);
      child.once('error', error => { attempt.failure = error; lose(attempt); });
      child.once('exit', (code, signal) => {
        attempt.exited = true;
        if (!attempt.online) attempt.failure = attempt.failure || new Error(`The runner exited (${signal || code}) before it was ready.`);
        lose(attempt);
      });
    });
  }

  function killGroup(attempt) {
    if (attempt.child.pid && !attempt.exitedGroup) {
      try { process.kill(-attempt.child.pid, 'SIGKILL'); } catch (_) { attempt.exitedGroup = true; }
    }
  }

  // Once per runner process: kills its group, removes its sessions' directories, closes the
  // connection (the registry then marks it lost and the sessions are dropped), and restarts.
  function lose(attempt) {
    if (attempt.lost) return;
    attempt.lost = true;
    clearTimeout(attempt.timer);
    if (stopping) return;
    killGroup(attempt);
    for (const id of boundSessions()) fs.rmSync(path.join(runtimeRoot, 'sessions', id), {recursive: true, force: true});
    if (attempt.client) attempt.client.close();
    if (!attempt.online) { attempt.reject(attempt.failure || new Error('The runner connection closed before it was ready.')); return; }
    console.error('The local runner stopped unexpectedly; its sessions were closed. Restarting it.');
    restart();
  }

  async function restart() {
    for (const delay of RESTART_DELAYS_MS) {
      await new Promise(resolve => setTimeout(resolve, delay));
      if (stopping) return;
      try {
        await launch();
        console.log('The local runner was restarted.');
        return;
      } catch (error) { console.error(`Cannot restart the local runner: ${error.message}`); }
    }
    onFatal(new Error(`The local runner could not be restarted (${RESTART_DELAYS_MS.length} attempts).`));
  }

  async function start() {
    await prepareSocket();
    await listen();
    return launch();
  }

  async function stop() {
    stopping = true;
    const attempt = current;
    if (attempt && !attempt.exited) {
      const exited = new Promise(resolve => attempt.child.once('exit', resolve));
      if (attempt.client) attempt.client.close();
      else attempt.child.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, STOP_TIMEOUT_MS))]);
    }
    if (attempt) killGroup(attempt);
    if (server) server.close();
    try { fs.unlinkSync(socketPath); } catch (_) {}
  }

  function kill() {
    if (current) killGroup(current);
  }

  return {start, stop, kill, socketPath};
}

module.exports = {createLocalRunner};
