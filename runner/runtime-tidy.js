'use strict';

// What a runner keeps in its own runtime directory besides the sessions themselves (rules R1, R8 and R9 of
// docs/runner-model.md). Nothing else writes there: the server never opens a path under a runner's directory.
//   <runtime>/users/<login>  a relative symbolic link ../sessions/<id>, so that an administrator finds the session of a
//                            user; created at session.create, removed with the session, dangling ones pruned at start
//   <runtime>/runner.pid     the lock: a live runner on the directory makes a second one refuse to start
//   <runtime>/sessions/<id>  at start, a directory that holds no node is removed; a non-empty one is kept (and
//                            reported), a restore or discard policy is a later decision
const fs = require('fs');
const path = require('path');
const {removeEmptySessionDirectory, SESSION_ID} = require('./session');

const PID_FILE = 'runner.pid';

// Same encoding as the hostname aliases of runner/session-runtime.js.
function userAliasName(login) {
  const encoded = encodeURIComponent(login);
  return encoded === '.' || encoded === '..' ? encoded.replaceAll('.', '%2E') : encoded;
}

const usersDirectory = runtimeRoot => path.join(runtimeRoot, 'users');
const aliasTarget = sessionId => path.join('..', 'sessions', sessionId);

// Creates (or replaces) the alias of the owner. A failure is only a warning: the alias is a convenience.
function linkUserAlias(runtimeRoot, owner, sessionId) {
  const usersDir = usersDirectory(runtimeRoot);
  const alias = path.join(usersDir, userAliasName(owner));
  try {
    fs.mkdirSync(usersDir, {recursive: true});
    const temporary = `${alias}.${process.pid}.tmp`;
    fs.rmSync(temporary, {force: true});
    fs.symlinkSync(aliasTarget(sessionId), temporary, 'dir');
    fs.renameSync(temporary, alias);
    return true;
  } catch (error) {
    console.warn(`Cannot create ${path.relative(runtimeRoot, alias)}: ${error.message}`);
    return false;
  }
}

// Removes the alias of the owner when it still points to this session, then the users/ directory when empty.
function unlinkUserAlias(runtimeRoot, owner, sessionId) {
  const usersDir = usersDirectory(runtimeRoot);
  const alias = path.join(usersDir, userAliasName(owner));
  try { if (fs.readlinkSync(alias) === aliasTarget(sessionId)) fs.unlinkSync(alias); } catch (_) { /* Absent or not ours. */ }
  try { fs.rmdirSync(usersDir); } catch (_) { /* Not empty, or absent. */ }
}

// Removes the aliases whose session directory no longer exists. Returns how many.
function pruneUserAliases(runtimeRoot) {
  const usersDir = usersDirectory(runtimeRoot);
  let names;
  try { names = fs.readdirSync(usersDir); } catch (_) { return 0; }
  let removed = 0;
  for (const name of names) {
    const alias = path.join(usersDir, name);
    try {
      if (fs.lstatSync(alias).isSymbolicLink() && !fs.existsSync(alias)) { fs.unlinkSync(alias); removed++; }
    } catch (_) { /* Preserve what we cannot read. */ }
  }
  try { fs.rmdirSync(usersDir); } catch (_) { /* Not empty, or absent. */ }
  return removed;
}

// At start, before any session exists: removes the session directories that hold no node, then the dangling aliases.
// Returns {removed: n, kept: [ids], aliases: n}; the log lines are printed here.
function pruneRuntime(runtimeRoot, {log = console.log} = {}) {
  const sessionsDir = path.join(runtimeRoot, 'sessions');
  let names = [];
  try { names = fs.readdirSync(sessionsDir); } catch (_) { /* No sessions directory yet. */ }
  let removed = 0;
  const kept = [];
  for (const name of names) {
    if (!SESSION_ID.test(name)) continue;
    const directory = path.join(sessionsDir, name);
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory()) continue;
      if (removeEmptySessionDirectory(directory)) removed++; else kept.push(name);
    } catch (_) { kept.push(name); }
  }
  try { fs.rmdirSync(sessionsDir); } catch (_) { /* Not empty, or absent. */ }
  const aliases = pruneUserAliases(runtimeRoot);
  if (removed) log(`Removed ${removed} empty runtime session${removed === 1 ? '' : 's'}.`);
  if (kept.length) log(`Kept ${kept.length} non-empty session director${kept.length === 1 ? 'y' : 'ies'} left by an earlier runner: ${kept.join(', ')}.`);
  return {removed, kept, aliases};
}

// Whether `pid` is a live process, and (where /proc exists) a runner. `alive` and `isRunner` can be replaced in tests.
function defaultAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function defaultIsRunner(pid) {
  let cmdline;
  try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch (_) { return true; }
  return cmdline.split('\0').some(arg => /(^|[\\/])runner[\\/]main\.js$/.test(arg));
}

// Takes <runtime>/runner.pid. Throws when a live runner holds it; a stale file (dead process, or a pid reused by
// another program) is ignored and replaced. Returns {release()}, which removes the file only if it is still ours.
function takeRunnerLock(runtimeRoot, {pid = process.pid, alive = defaultAlive, isRunner = defaultIsRunner} = {}) {
  const file = path.join(runtimeRoot, PID_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, `${pid}\n`, {flag: 'wx', mode: 0o600});
      return {file, release() {
        try { if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.rmSync(file, {force: true}); } catch (_) { /* Gone. */ }
      }};
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let holder = 0;
    try { holder = Number(fs.readFileSync(file, 'utf8').trim()); } catch (_) { /* Removed meanwhile: try again. */ }
    if (Number.isSafeInteger(holder) && holder > 0 && holder !== pid && alive(holder) && isRunner(holder)) {
      throw new Error(`Another runner (PID ${holder}) already uses the runtime directory ${runtimeRoot}. Stop it or choose another --runtime.`);
    }
    try { fs.rmSync(file, {force: true}); } catch (_) { /* Retried by the next attempt. */ }
  }
  throw new Error(`Cannot take ${file}.`);
}

module.exports = {PID_FILE, userAliasName, linkUserAlias, unlinkUserAlias, pruneUserAliases, pruneRuntime, takeRunnerLock};
