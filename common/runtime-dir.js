'use strict';

// The runtime directories (docs/runner-model.md, R1 and R2). Each process owns its own directory:
//   server  <server dir>/  server-<port>.pid, bindings.json, local-runner.token; no socket, so NO length limit
//   runner  <runner dir>/  sessions/<id>/ (the node sockets), users/<login> aliases, runner.pid
// The node sockets of a runner live under its directory and a Unix socket path is limited to 107 bytes, so the
// DEFAULTS are short private directories per account, in /tmp (the runner link is a WebSocket, no socket):
//
//   /tmp/qw-<login>/<port>       the server (the port is its --listen, default 3002)
//   /tmp/qw-<login>/l-<port>     the local runner, started with --port <port> (7 characters at most)
//   /tmp/qw-<login>/r-<id6>      a remote runner: the first 6 hex digits of its runner id (8 characters)
//
// Two runners of one account never share a directory by default, and a runner never shares the server's.
// <login> is the account that runs the process (os.userInfo().username, `id -un` in the scripts, which call
// this file: `node common/runtime-dir.js path server|local PORT`), each character outside [A-Za-z0-9._-] replaced by "_";
// an empty name, or one of more than 32 characters, is replaced by the numeric user ID. --runtime DIR
// replaces the default and is used as given (the CREMI services pass /var/lib/qemuweb/server and /var/lib/qemuweb/runner).
// Nothing in /tmp survives a reboot of the machine: sessions are disposable, Save session (ZIP) keeps work.
//
// The default directories are created with mode 0700 and, when they exist already, REFUSED unless they are
// real directories (no symbolic link) owned by this user and closed to group and others: /tmp is shared,
// and anyone may create /tmp/qw-<login> first. Nothing is repaired and no other place is tried.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SOCKET_LIMIT = 107;
const TMP_ROOT = '/tmp';
const MAX_LOGIN = 32;
const TMPFS_MAGIC = 0x01021994;
const LOW_SPACE_BYTES = 5 * 1024 ** 3;
const HEX8 = '01234567';
// The socket files of a node directory (runner/session-runtime.js builds its paths from them; qga.sock is the
// QEMU guest agent channel of a host, runner/guest-agent.js); a switch
// also has mgmt.sock and the VDE directory, where vde_switch creates its control socket.
const NODE_FILES = {serial0: 'serial0.sock', serial1: 'serial1.sock', monitor: 'mon.sock', qga: 'qga.sock', mgmt: 'mgmt.sock', vde: 'vde'};
const VDE_CONTROL = 'ctl';

function currentIdentity() {
  try { const {username, uid} = os.userInfo(); return {username, uid}; }
  catch (_) { return {username: '', uid: process.getuid()}; }
}

// The account part of the directory name.
function accountLabel({username, uid}) {
  const name = String(username ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  return name && name.length <= MAX_LOGIN ? name : String(uid);
}

function accountRoot({tmpRoot = TMP_ROOT, identity = currentIdentity()} = {}) {
  return path.join(tmpRoot, `qw-${accountLabel(identity)}`);
}

// The default directory of the server of a port, of the local runner that dials that port, and of a remote runner
// (runnerId is `r-` and 8 hex digits, runner/store).
const serverRuntime = (port, options = {}) => path.join(accountRoot(options), String(port));
const localRunnerRuntime = (port, options = {}) => path.join(accountRoot(options), `l-${port}`);
function remoteRunnerRuntime(runnerId, options = {}) {
  const match = /^r-([0-9a-f]{6})[0-9a-f]*$/.exec(String(runnerId));
  if (!match) throw new Error(`Invalid runner ID "${runnerId}": cannot name its default runtime directory.`);
  return path.join(accountRoot(options), `r-${match[1]}`);
}

const isDefaultRuntime = (runtime, options = {}) => path.dirname(path.resolve(runtime)) === accountRoot(options);

// Creates `directory` (0700), or checks the one that exists. Throws a clear error, never repairs.
function ensurePrivateDirectory(directory, uid) {
  const read = () => { try { return fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  let stat = read();
  if (!stat) {
    try { fs.mkdirSync(directory, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    stat = read();
  }
  const refuse = reason => new Error(`${directory} ${reason}; refusing to use it. Remove it, or choose another place with --runtime DIR.`);
  if (!stat) throw refuse('cannot be created');
  if (stat.isSymbolicLink()) throw refuse('is a symbolic link');
  if (!stat.isDirectory()) throw refuse('is not a directory');
  if (stat.uid !== uid) throw refuse(`belongs to another user (uid ${stat.uid})`);
  if (stat.mode & 0o077) throw refuse(`is accessible by group or others (mode ${(stat.mode & 0o777).toString(8).padStart(4, '0')}, expected 0700)`);
}

// Every Unix socket path the runner builds (the node sockets), relative to the runtime directory, for the longest
// identifiers (an 8 hex session ID, h-/s- and 8 hex node IDs).
function socketPathsBelowRuntime() {
  const session = path.join('sessions', HEX8);
  const files = [];
  for (const prefix of ['h', 's']) {
    const node = path.join(session, `${prefix}-${HEX8}`);
    files.push(...[NODE_FILES.serial0, NODE_FILES.serial1, NODE_FILES.monitor, NODE_FILES.qga].map(name => path.join(node, name)));
    if (prefix === 's') files.push(path.join(node, NODE_FILES.mgmt), path.join(node, NODE_FILES.vde, VDE_CONTROL));
  }
  return files;
}

// The longest of them, and the longest runtime directory that keeps it within the socket limit.
function runtimeBudget() {
  const longest = socketPathsBelowRuntime().reduce((a, b) => (Buffer.byteLength(b) >= Buffer.byteLength(a) ? b : a));
  return {longest, maxRuntimeLength: SOCKET_LIMIT - Buffer.byteLength(longest) - 1};
}

// The message for a runtime directory that is too long, or null.
function runtimeTooLong(runtime) {
  const {longest, maxRuntimeLength} = runtimeBudget();
  const length = Buffer.byteLength(path.resolve(runtime));
  if (length <= maxRuntimeLength) return null;
  return `The runtime directory ${path.resolve(runtime)} is too long (${length} bytes): the longest path QemuWeb builds in it, ` +
    `${path.join(path.resolve(runtime), longest)}, would take ${length + 1 + Buffer.byteLength(longest)} bytes and a Unix socket path is limited to ${SOCKET_LIMIT} ` +
    `(at most ${maxRuntimeLength} bytes for the runtime directory). Use a shorter --runtime.`;
}

// A one-line warning when the runtime directory is in memory (tmpfs) or short of space, else null.
function storageWarning(directory, {statfs = fs.statfsSync, lowSpace = LOW_SPACE_BYTES} = {}) {
  try {
    const info = statfs(directory);
    const free = Number(info.bavail) * Number(info.bsize);
    const reasons = [];
    if (info.type === TMPFS_MAGIC) reasons.push('is on a tmpfs, in memory');
    if (free < lowSpace) reasons.push(`has only ${(free / 1024 ** 3).toFixed(1)} GB free`);
    if (!reasons.length) return null;
    return `runtime directory ${directory} ${reasons.join(' and ')}: the working disks of the sessions live there; use --runtime DIR on a larger disk for big sessions.`;
  } catch (_) { return null; }
}

// Prepares a runtime directory at startup (before anything is created in it): a default one is created
// private or refused; one given with --runtime is only created. `options` is for tests: {tmpRoot, identity, statfs}.
function prepareDirectory(runtime, options) {
  const existed = fs.existsSync(runtime);
  if (isDefaultRuntime(runtime, options)) {
    const uid = options.identity ? options.identity.uid : process.getuid();
    ensurePrivateDirectory(accountRoot(options), uid);
    ensurePrivateDirectory(path.resolve(runtime), uid);
  } else {
    fs.mkdirSync(runtime, {recursive: true});
  }
  fs.accessSync(runtime, fs.constants.W_OK);
  return {created: !existed, warning: storageWarning(runtime, options)};
}

// The server directory holds no socket: no length limit, no sessions/. Returns {created, warning}.
const prepareServerRuntime = (runtime, options = {}) => prepareDirectory(runtime, options);

// A runner directory: refused when too long for the node sockets, sessions/ created. Returns {created, warning}.
function prepareRunnerRuntime(runtime, options = {}) {
  const tooLong = runtimeTooLong(runtime);
  if (tooLong) throw new Error(tooLong);
  const result = prepareDirectory(runtime, options);
  fs.mkdirSync(path.join(runtime, 'sessions'), {recursive: true});
  return result;
}

// At the end of a server or a runner: removes a default directory once nothing is left in it
// (a directory given with --runtime is never removed).
function removeEmptyDefaultRuntime(runtime, options = {}) {
  if (!isDefaultRuntime(runtime, options)) return;
  try { fs.rmdirSync(runtime); } catch (_) { /* Not empty (the other process still uses it), or gone. */ }
}

module.exports = {NODE_FILES, removeEmptyDefaultRuntime, SOCKET_LIMIT, MAX_LOGIN, accountLabel, accountRoot, serverRuntime, localRunnerRuntime, remoteRunnerRuntime, isDefaultRuntime, ensurePrivateDirectory,
  socketPathsBelowRuntime, runtimeBudget, runtimeTooLong, storageWarning, prepareServerRuntime, prepareRunnerRuntime};

// The scripts ask for the default directory: `node common/runtime-dir.js path server PORT|local PORT|remote ID`, or `root` for
// /tmp/qw-<login>; with `prepare` instead of `path` it is also created or refused.
if (require.main === module) {
  const [command, kind, value] = process.argv.slice(2);
  const usage = () => { console.error('Usage: node common/runtime-dir.js path|prepare server PORT | local PORT | remote ID\n       node common/runtime-dir.js root'); process.exit(2); };
  if (command === 'root' && !kind) { console.log(accountRoot()); process.exit(0); }
  const port = /^\d{1,5}$/.test(value || '') && Number(value) >= 1 && Number(value) <= 65535;
  if (!['path', 'prepare'].includes(command) || !((['server', 'local'].includes(kind) && port) || (kind === 'remote' && /^r-[0-9a-f]{8}$/.test(value || '')))) usage();
  const runtime = kind === 'server' ? serverRuntime(value) : kind === 'local' ? localRunnerRuntime(value) : remoteRunnerRuntime(value);
  try { if (command === 'prepare') (kind === 'server' ? prepareServerRuntime : prepareRunnerRuntime)(runtime); }
  catch (error) { console.error(error.message); process.exit(1); }
  console.log(runtime);
}
