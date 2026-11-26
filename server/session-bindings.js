'use strict';

// bindings.json: the server's own record of which session belongs to which user and runs on which
// runner (<server runtime>/bindings.json, mode 0600, schema 1). It is the only source of the owner
// of a session the server takes over after a restart (SessionManager.restore turns each binding into an offline workspace at start): the owner a runner announces in its hello is
// never used (a hello is untrusted input). Layout:
//   {"schemaVersion": 1, "sessions": [{"id": "<8 hex>", "owner": "<login>", "runnerId": "local", "createdAt": "<ISO>"}]}
// The manager writes a binding BEFORE it sends session.create (a crash in between leaves a binding
// without a session, dropped at the runner's next hello, never a session without a binding) and
// removes it when the session is deleted or dropped. The file is untrusted input at load time: a
// bad entry is skipped with a log line, a corrupt file means no bindings (said loudly), never a
// crash. The file is removed when no session is bound. Written atomically (temporary file, mode 0600, rename); the server is the only writer.
// `file` null keeps the bindings in memory only (tests).
const fs = require('fs');
const path = require('path');
const {BINDINGS_SCHEMA_VERSION} = require('../common/schema-versions');
const {SESSION_ID} = require('./session');
const {LOGIN_PATTERN} = require('./auth/users-store');
const {RUNNER_ID} = require('./runner-store');

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BINDINGS = 10000;
const FIELDS = ['id', 'owner', 'runnerId', 'createdAt'];

const validDate = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

// The valid bindings of a file's text, as a Map of session ID -> binding. Entries that are invalid,
// that repeat an ID or an owner (one session per user) are skipped and reported through `warn`.
function parseBindings(text, warn = () => {}) {
  let data;
  try { data = JSON.parse(text); }
  catch (error) { warn(`not valid JSON (${error.message})`); return new Map(); }
  if (!data || data.schemaVersion !== BINDINGS_SCHEMA_VERSION || !Array.isArray(data.sessions) || data.sessions.length > MAX_BINDINGS) {
    warn(`it must contain schemaVersion ${BINDINGS_SCHEMA_VERSION} and a sessions array of at most ${MAX_BINDINGS} entries`);
    return new Map();
  }
  const bindings = new Map();
  const owners = new Set();
  for (const item of data.sessions) {
    const valid = item && typeof item === 'object' && !Object.keys(item).some(key => !FIELDS.includes(key))
      && typeof item.id === 'string' && SESSION_ID.test(item.id) && typeof item.owner === 'string' && LOGIN_PATTERN.test(item.owner)
      && typeof item.runnerId === 'string' && RUNNER_ID.test(item.runnerId) && validDate(item.createdAt);
    if (!valid) warn('an invalid entry was skipped');
    else if (bindings.has(item.id) || owners.has(item.owner)) warn(`a duplicate entry (session ${item.id}, owner ${item.owner}) was skipped`);
    else {
      bindings.set(item.id, {id: item.id, owner: item.owner, runnerId: item.runnerId, createdAt: item.createdAt});
      owners.add(item.owner);
    }
  }
  return bindings;
}

function createSessionBindings(file = null, {log = message => console.warn(message)} = {}) {
  let bindings = new Map();
  if (file) {
    const name = path.basename(file);
    const warn = reason => log(`${name}: ${reason}. The sessions of the runners that are not bound here will be deleted when the runners connect.`);
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) warn(`the file is larger than ${MAX_FILE_BYTES} bytes, ignored`);
      else bindings = parseBindings(fs.readFileSync(file, 'utf8'), warn);
    } catch (error) {
      if (error.code !== 'ENOENT') warn(`cannot be read (${error.message}), ignored`);
    }
  }

  function save() {
    if (!file) return;
    if (!bindings.size) { // No session: no file (an idle default runtime directory stays removable).
      fs.rmSync(file, {force: true});
      return;
    }
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    const sessions = [...bindings.values()].map(binding => ({id: binding.id, owner: binding.owner, runnerId: binding.runnerId, createdAt: binding.createdAt}));
    fs.writeFileSync(temporary, `${JSON.stringify({schemaVersion: BINDINGS_SCHEMA_VERSION, sessions}, null, 2)}\n`, {mode: 0o600});
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  }

  return {
    file,
    get: id => bindings.get(id) || null,
    list: () => [...bindings.values()],
    // Binds a session to its owner and runner; written before the runner is asked to create it.
    set(binding) {
      const previous = bindings.get(binding.id);
      bindings.set(binding.id, {id: binding.id, owner: binding.owner, runnerId: binding.runnerId, createdAt: binding.createdAt});
      try { save(); }
      catch (error) {
        if (previous) bindings.set(binding.id, previous); else bindings.delete(binding.id);
        throw error;
      }
    },
    // Forgets a binding; a failed write is logged, the binding is gone from memory anyway.
    remove(id) {
      if (!bindings.delete(id)) return;
      try { save(); } catch (error) { log(`Cannot write ${file}: ${error.message}`); }
    }
  };
}

module.exports = {createSessionBindings, parseBindings};
