'use strict';

// users.json: the accounts allowed to log in (repository root by default, or
// QEMUWEB_USERS_FILE). Mode 0600, never committed. Layout:
//   {"schemaVersion": 1, "users": [{"login": "alice", "hash": "scrypt$...", "role": "student"}]}
// The role ('student' or 'admin') is only stored for now.
const fs = require('fs');
const path = require('path');
const {isPasswordHash} = require('./passwords');

const ROLES = ['student', 'admin'];
// The login names runtime/users/<login>: a short, safe character set.
const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

function validateLogin(login) {
  if (typeof login !== 'string' || !LOGIN_PATTERN.test(login)) {
    throw new Error('Invalid login: use 1 to 64 letters, digits, ".", "_", "-" or "@", starting with a letter or digit.');
  }
  return login;
}

function validateRole(role) {
  if (!ROLES.includes(role)) throw new Error(`Invalid role: expected ${ROLES.join(' or ')}.`);
  return role;
}

function usersFilePath(root, env = process.env) {
  return env.QEMUWEB_USERS_FILE ? path.resolve(env.QEMUWEB_USERS_FILE) : path.join(root, 'users.json');
}

function parseUsers(text, file = 'users.json') {
  let data;
  try { data = JSON.parse(text); }
  catch (error) { throw new Error(`Cannot parse ${file}: ${error.message}`); }
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.users) ||
      Object.keys(data).some(key => !['schemaVersion', 'users'].includes(key))) {
    throw new Error(`${file} must contain schemaVersion 1 and a users array.`);
  }
  const logins = new Set();
  for (const user of data.users) {
    if (!user || typeof user !== 'object' || Object.keys(user).some(key => !['login', 'hash', 'role'].includes(key))) {
      throw new Error(`${file}: invalid user entry.`);
    }
    validateLogin(user.login);
    validateRole(user.role);
    if (!isPasswordHash(user.hash)) throw new Error(`${file}: invalid password hash for ${user.login}.`);
    if (logins.has(user.login)) throw new Error(`${file}: duplicate login ${user.login}.`);
    logins.add(user.login);
  }
  return data.users;
}

// Returns the users, or [] when the file does not exist.
function readUsers(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return parseUsers(text, path.basename(file));
}

// Atomic write with mode 0600.
function writeUsers(file, users) {
  const sorted = [...users].sort((a, b) => a.login.localeCompare(b.login));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify({schemaVersion: 1, users: sorted}, null, 2)}\n`, {mode: 0o600});
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

// Cached reader for the server: re-reads the file when it changes, so that accounts added,
// removed or given a new password with scripts/user.sh apply without a restart.
function createUsersStore(file) {
  let cache = {key: null, users: new Map()};
  function load() {
    let stat;
    try { stat = fs.statSync(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      cache = {key: null, users: new Map()};
      return cache.users;
    }
    const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (key !== cache.key) cache = {key, users: new Map(readUsers(file).map(user => [user.login, user]))};
    return cache.users;
  }
  return {
    file,
    get(login) { return load().get(login) || null; },
    count() { return load().size; }
  };
}

module.exports = {ROLES, LOGIN_PATTERN, validateLogin, validateRole, usersFilePath, parseUsers, readUsers, writeUsers, createUsersStore};
