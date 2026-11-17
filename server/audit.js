'use strict';

// Server logs live in one directory: the --logs directory (default logs/ at the repository root). Each is
// JSON lines, created with mode 0600:
//   admin.log  the audit log of administrator actions:
//              {"time", "admin": login, "action": name, "target": {...}, "result": "ok" | "error: ..."}
//   users.log  user events (login, sessions, nodes, archives):
//              {"time", "user": login, "event": name, "target"?: {...}, "result"?: ...}
// Callers never pass a password, typed console text, file contents or an IP address.
// Read-only traffic (session lists, polling, console output) is not logged.
const fs = require('fs');
const path = require('path');

const ADMIN_LOG = 'admin.log';
const USERS_LOG = 'users.log';
const LOG_NAMES = {admin: ADMIN_LOG, users: USERS_LOG};

// Creates the log directory (mode 0700) if missing; returns it.
function createLogDir(dir) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  return dir;
}

const resultText = result => (result instanceof Error ? `error: ${result.message}` : result);

// Appends one entry; a write failure is reported on the server log and never interrupts the
// action that is being logged.
function appendEntry(file, entry) {
  try { fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, {mode: 0o600}); }
  catch (error) { console.error(`Cannot write ${file}: ${error.message}`); }
  return entry;
}

// admin.log. record(admin, action, target, result): result is 'ok' or an Error (its message is kept).
function createAudit({file, now = () => new Date()}) {
  return {file, record: (admin, action, target = {}, result = 'ok') =>
    appendEntry(file, {time: now().toISOString(), admin, action, target, result: resultText(result)})};
}

// users.log. record(user, event, target?, result?).
function createUserLog({file, now = () => new Date()}) {
  return {file, record: (user, event, target, result) => appendEntry(file, {time: now().toISOString(), user, event,
    ...(target ? {target} : {}), ...(result !== undefined ? {result: resultText(result)} : {})})};
}

// The last `lines` entries of a JSON lines log, oldest first, reading at most maxBytes from
// the end of the file. A line cut by that limit, or one that is not JSON, is skipped.
// A missing file has no entry.
function readLogTail(file, lines = 200, maxBytes = 256 * 1024) {
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, read).toString('utf8').split('\n');
    if (start > 0) text.shift();
    const entries = [];
    for (const line of text) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch (_) { /* Not a complete JSON line. */ }
    }
    return entries.slice(-lines);
  } finally { fs.closeSync(fd); }
}

module.exports = {ADMIN_LOG, USERS_LOG, LOG_NAMES, createLogDir, createAudit, createUserLog, readLogTail};
