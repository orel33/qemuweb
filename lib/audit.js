'use strict';

// Audit log of administrator actions: one JSON object per line, appended to audit.log at the
// repository root (QEMUWEB_AUDIT_FILE overrides it), created with mode 0600. A line holds
//   {"time": ISO date, "admin": login, "action": name, "target": {...}, "result": "ok" | message}
// Callers never pass a password or typed console text. Read-only supervision traffic (the
// session list) is not logged.
const fs = require('fs');
const path = require('path');

function auditFilePath(root, env = process.env) {
  return env.QEMUWEB_AUDIT_FILE ? path.resolve(env.QEMUWEB_AUDIT_FILE) : path.join(root, 'audit.log');
}

// record(admin, action, target, result): result is 'ok' or an Error (its message is kept).
// A write failure is reported on the server log and never interrupts the action.
function createAudit({file, now = () => new Date()}) {
  function record(admin, action, target = {}, result = 'ok') {
    const entry = {time: now().toISOString(), admin, action, target,
      result: result instanceof Error ? `error: ${result.message}` : result};
    try { fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, {mode: 0o600}); }
    catch (error) { console.error(`Cannot write the audit log ${file}: ${error.message}`); }
    return entry;
  }
  return {file, record};
}

module.exports = {auditFilePath, createAudit};
