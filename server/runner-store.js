'use strict';

// runners.json: the runners registered with this server (repository root by default, or the
// --runners option), next to users.json. Mode 0600, never committed. Layout:
//   {"schemaVersion": 2, "runners": [{"id": "r-1a2b3c4d", "name": "salle-12", "tokenHash": "<sha256 hex>",
//     "createdAt": "<ISO>", "lastSeenAt": "<ISO>", "paused": true, "revoked": true}]}
// One record per runner, the same for all: the id is "r-xxxxxxxx" (registered with a token) or "local"
// (the runner of the server's machine, created at start by ensureLocal() when the server runs with --local-runner; its
// record has no tokenHash: its secret is the token file of server/local-runner-token.js, and verify() never accepts it). Nobody is trusted by
// transport: what a runner may do is decided by its record. Only the hash of a runner's
// authentication token is stored (32 random bytes, so a plain sha256 is enough); it is compared in
// constant time. "paused" and "revoked" are written only when set. A revoked runner keeps its record
// (so that the administrator sees it) until it is removed.
// The store is read once, kept in memory and written through (atomically) at every change: the
// server is the only writer.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {RUNNERS_SCHEMA_VERSION} = require('../common/schema-versions');

const LOCAL_ID = 'local';
const RUNNER_ID = /^(?:local|r-[0-9a-f]{8})$/;
const MAX_NAME = 64;
const FIELDS = ['id', 'name', 'tokenHash', 'createdAt', 'lastSeenAt', 'paused', 'revoked'];

const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');

// A runner name comes from a user: printable characters only, bounded.
function cleanName(name, fallback) {
  const text = typeof name === 'string' ? name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_NAME) : '';
  return text || fallback;
}

function parseRunners(text, file = 'runners.json') {
  let data;
  try { data = JSON.parse(text); }
  catch (error) { throw new Error(`Cannot parse ${file}: ${error.message}`); }
  if (!data || data.schemaVersion !== RUNNERS_SCHEMA_VERSION || !Array.isArray(data.runners) || Object.keys(data).some(key => !['schemaVersion', 'runners'].includes(key))) {
    throw new Error(`${file} must contain schemaVersion ${RUNNERS_SCHEMA_VERSION} and a runners array (an older file is not read: delete it by hand and register the runners again).`);
  }
  const ids = new Set();
  for (const runner of data.runners) {
    if (!runner || typeof runner !== 'object' || Object.keys(runner).some(key => !FIELDS.includes(key))) throw new Error(`${file}: invalid runner entry.`);
    if (typeof runner.id !== 'string' || !RUNNER_ID.test(runner.id)) throw new Error(`${file}: invalid runner ID.`);
    if (ids.has(runner.id)) throw new Error(`${file}: duplicate runner ${runner.id}.`);
    ids.add(runner.id);
    if (typeof runner.name !== 'string') throw new Error(`${file}: invalid runner ${runner.id}.`);
    // The token hash is required, except for the local runner, which has none.
    if (runner.tokenHash === undefined ? runner.id !== LOCAL_ID : typeof runner.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(runner.tokenHash)) throw new Error(`${file}: invalid runner ${runner.id}.`);
    for (const key of ['createdAt', 'lastSeenAt']) if (runner[key] !== undefined && !Number.isFinite(Date.parse(runner[key]))) throw new Error(`${file}: invalid ${key} for ${runner.id}.`);
    for (const key of ['paused', 'revoked']) if (runner[key] !== undefined && typeof runner[key] !== 'boolean') throw new Error(`${file}: "${key}" must be true or false for ${runner.id}.`);
  }
  return data.runners;
}

// The records, or [] when the file does not exist.
function readRunners(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return parseRunners(text, path.basename(file));
}

// Atomic write with mode 0600.
function writeRunners(file, runners) {
  const clean = runners.map(runner => Object.fromEntries(FIELDS.filter(key => runner[key] !== undefined && runner[key] !== false).map(key => [key, runner[key]])));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify({schemaVersion: RUNNERS_SCHEMA_VERSION, runners: clean}, null, 2)}\n`, {mode: 0o600});
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

function createRunnerStore(file, {now = () => new Date()} = {}) {
  const records = readRunners(file);
  const save = () => writeRunners(file, records);
  const find = id => records.find(record => record.id === id) || null;
  // The same constant-time comparison for an unknown ID as for a known one.
  const dummy = hashToken('qemuweb-unknown-runner');

  return {
    file,
    count: () => records.length,
    list: () => records.map(record => ({...record})),
    get: id => { const record = find(id); return record ? {...record} : null; },
    // Registers a runner; returns {record, authToken}: the token is shown once, never stored.
    add({name}) {
      let id;
      do id = `r-${crypto.randomBytes(4).toString('hex')}`; while (find(id));
      const authToken = crypto.randomBytes(32).toString('base64url');
      const record = {id, name: cleanName(name, id), tokenHash: hashToken(authToken), createdAt: now().toISOString()};
      records.push(record);
      save();
      return {record: {...record}, authToken};
    },
    // The record of the local runner, created once when the server starts with --local-runner (name "local"); an
    // existing record, revoked or not, is returned as it is (a start never un-revokes it).
    ensureLocal() {
      let record = find(LOCAL_ID);
      if (!record) {
        record = {id: LOCAL_ID, name: LOCAL_ID, createdAt: now().toISOString()};
        records.push(record);
        save();
      }
      return {...record};
    },
    // The record of a runner presenting this ID and token, else null (unknown, wrong token, revoked,
    // or a record without a token hash: the local runner is checked by server/remote-gateway.js against its token file).
    verify(id, token) {
      const record = typeof id === 'string' && typeof token === 'string' && token.length <= 256 ? find(id) : null;
      const expected = Buffer.from(record?.tokenHash || dummy, 'hex');
      const valid = crypto.timingSafeEqual(expected, Buffer.from(hashToken(token ?? ''), 'hex'));
      return record && record.tokenHash && valid && !record.revoked ? {...record} : null;
    },
    change(id, fields) {
      const record = find(id);
      if (!record) throw Object.assign(new Error(`Unknown runner ${id}.`), {status: 404});
      Object.assign(record, fields);
      save();
      return {...record};
    },
    remove(id) {
      const index = records.findIndex(record => record.id === id);
      if (index < 0) throw Object.assign(new Error(`Unknown runner ${id}.`), {status: 404});
      records.splice(index, 1);
      save();
    }
  };
}

module.exports = {createRunnerStore, parseRunners, readRunners, writeRunners, hashToken, cleanName, RUNNER_ID, LOCAL_ID, MAX_NAME};
