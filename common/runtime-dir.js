'use strict';

// The runtime directory: where a server and its local runner keep the sessions (<runtime>/sessions/<id>/),
// the users/ aliases, server-<port>.pid and .session and the socket runner-<port>.sock. Every Unix socket
// of QemuWeb lives under it and a socket path is limited to 107 bytes, so the DEFAULT is a short private
// directory per account and per server port, in /tmp:
//
//   /tmp/qw-<login>/<port>      server and local runner (the port is the server's --listen, default 3002)
//   /tmp/qw-<login>/runner      a remote runner (runner.sh run) without --runtime
//
// <login> is the account that runs the process (os.userInfo().username, `id -un` in the scripts, which call
// this file: `node common/runtime-dir.js path PORT`), each character outside [A-Za-z0-9._-] replaced by "_";
// an empty name, or one of more than 32 characters, is replaced by the numeric user ID. --runtime DIR
// replaces the default and is used as given (the CREMI services pass /var/lib/qemuweb). Nothing in /tmp
// survives a reboot of the machine: sessions are disposable, Save session (ZIP) keeps work.
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
const HEX16 = '0123456789abcdef';
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

// name: the server port, or "runner" for a remote runner.
function defaultRuntime(name, options = {}) {
  return path.join(accountRoot(options), String(name));
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

// Every socket path the runner and the server build, relative to the runtime directory, for the longest
// identifiers (a 16 hex session ID, h-/s- and 16 hex node IDs, a 5 digit port).
function socketPathsBelowRuntime() {
  const session = path.join('sessions', HEX16);
  const files = [];
  for (const prefix of ['h', 's']) {
    const node = path.join(session, `${prefix}-${HEX16}`);
    files.push(...[NODE_FILES.serial0, NODE_FILES.serial1, NODE_FILES.monitor, NODE_FILES.qga].map(name => path.join(node, name)));
    if (prefix === 's') files.push(path.join(node, NODE_FILES.mgmt), path.join(node, NODE_FILES.vde, VDE_CONTROL));
  }
  files.push('runner-65535.sock');
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

// Prepares the runtime directory at startup (before any session exists): the default one is created
// private or refused; one given with --runtime is only created. Refuses a directory too long for the
// sockets. Returns {created, warning}. `options` is for tests: {tmpRoot, identity, statfs}.
function prepareRuntime(runtime, options = {}) {
  const tooLong = runtimeTooLong(runtime);
  if (tooLong) throw new Error(tooLong);
  const existed = fs.existsSync(runtime);
  if (isDefaultRuntime(runtime, options)) {
    const uid = options.identity ? options.identity.uid : process.getuid();
    ensurePrivateDirectory(accountRoot(options), uid);
    ensurePrivateDirectory(path.resolve(runtime), uid);
  } else {
    fs.mkdirSync(runtime, {recursive: true});
  }
  fs.mkdirSync(path.join(runtime, 'sessions'), {recursive: true});
  fs.accessSync(runtime, fs.constants.W_OK);
  return {created: !existed, warning: storageWarning(runtime, options)};
}

// At the end of a server or a runner: removes the default directory of a port once nothing is left in it
// (a directory given with --runtime is never removed).
function removeEmptyDefaultRuntime(runtime, options = {}) {
  if (!isDefaultRuntime(runtime, options)) return;
  try { fs.rmdirSync(runtime); } catch (_) { /* Not empty (the other process still uses it), or gone. */ }
}

module.exports = {NODE_FILES, removeEmptyDefaultRuntime, SOCKET_LIMIT, MAX_LOGIN, accountLabel, accountRoot, defaultRuntime, isDefaultRuntime, ensurePrivateDirectory,
  socketPathsBelowRuntime, runtimeBudget, runtimeTooLong, storageWarning, prepareRuntime};

// The scripts ask for the default directory: `node common/runtime-dir.js path PORT|runner`; with `prepare`
// instead of `path` it is also created or refused.
if (require.main === module) {
  const [command, name = '3002'] = process.argv.slice(2);
  if (!['path', 'prepare'].includes(command) || !/^(\d{1,5}|runner)$/.test(name)) {
    console.error('Usage: node common/runtime-dir.js path|prepare PORT|runner');
    process.exit(2);
  }
  const runtime = defaultRuntime(name);
  try { if (command === 'prepare') prepareRuntime(runtime); }
  catch (error) { console.error(error.message); process.exit(1); }
  console.log(runtime);
}
