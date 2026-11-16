'use strict';

// Server logs live in one directory: logs/ at the repository root, or QEMUWEB_LOG_DIR.
// admin.log is the audit log of administrator actions: one JSON object per line, created with
// mode 0600. A line holds
//   {"time": ISO date, "admin": login, "action": name, "target": {...}, "result": "ok" | message}
// Callers never pass a password or typed console text. Read-only supervision traffic (the
// session list) is not logged.
const fs = require('fs');
const path = require('path');

const ADMIN_LOG = 'admin.log';

function logDirPath(root, env = process.env) {
  return env.QEMUWEB_LOG_DIR ? path.resolve(env.QEMUWEB_LOG_DIR) : path.join(root, 'logs');
}

// Creates the log directory (mode 0700) if missing; returns it.
function createLogDir(dir) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  return dir;
}

// record(admin, action, target, result): result is 'ok' or an Error (its message is kept).
// A write failure is reported on the server log and never interrupts the action.
function createAudit({file, now = () => new Date()}) {
  function record(admin, action, target = {}, result = 'ok') {
    const entry = {time: now().toISOString(), admin, action, target,
      result: result instanceof Error ? `error: ${result.message}` : result};
    try { fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, {mode: 0o600}); }
    catch (error) { console.error(`Cannot write ${file}: ${error.message}`); }
    return entry;
  }
  return {file, record};
}

module.exports = {ADMIN_LOG, logDirPath, createLogDir, createAudit};
