'use strict';

// users.json: the accounts allowed to log in (repository root by default, or
// QEMUWEB_USERS_FILE). Mode 0600, never committed. Layout:
//   {"schemaVersion": 1, "users": [{"login": "alice", "hash": "scrypt$...", "role": "student"}]}
// The role is 'student' or 'admin' (the /admin page and API). "disabled": true, written only
// when set, refuses the account's logins and cookies.
// The account operations at the end are shared by scripts/user.js and the admin API.
const fs = require('fs');
const path = require('path');
const {hashPassword, isPasswordHash} = require('./passwords');

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

function validatePassword(password) {
  if (typeof password !== 'string' || !password) throw new Error('The password must not be empty.');
  if (password.length > 1024) throw new Error('The password is too long (maximum 1024 characters).');
  return password;
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
    if (!user || typeof user !== 'object' || Object.keys(user).some(key => !['login', 'hash', 'role', 'disabled'].includes(key))) {
      throw new Error(`${file}: invalid user entry.`);
    }
    validateLogin(user.login);
    validateRole(user.role);
    if (!isPasswordHash(user.hash)) throw new Error(`${file}: invalid password hash for ${user.login}.`);
    if (user.disabled !== undefined && typeof user.disabled !== 'boolean') throw new Error(`${file}: "disabled" must be true or false for ${user.login}.`);
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
  const sorted = [...users].sort((a, b) => a.login.localeCompare(b.login))
    .map(({login, hash, role, disabled}) => ({login, hash, role, ...(disabled ? {disabled: true} : {})}));
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
    list() { return [...load().values()]; },
    count() { return load().size; }
  };
}

// Account operations. Each reads the file, changes one account and writes it back; they
// throw an Error with a message meant for the user. hashOptions only speeds up tests.
function changeUser(file, login, change) {
  validateLogin(login);
  const users = readUsers(file);
  const user = users.find(item => item.login === login);
  if (!user) throw new Error(`Unknown user ${login}.`);
  change(user);
  writeUsers(file, users);
  return {login: user.login, role: user.role, disabled: !!user.disabled};
}

async function createAccount(file, {login, password, role = 'student'}, hashOptions) {
  validateLogin(login);
  validateRole(role);
  validatePassword(password);
  if (readUsers(file).some(user => user.login === login)) throw new Error(`User ${login} already exists.`);
  const hash = await hashPassword(password, hashOptions);
  const users = readUsers(file);
  if (users.some(user => user.login === login)) throw new Error(`User ${login} already exists.`);
  writeUsers(file, [...users, {login, hash, role}]);
  return {login, role, disabled: false};
}

async function setPassword(file, login, password, hashOptions) {
  validateLogin(login);
  const hash = await hashPassword(validatePassword(password), hashOptions);
  return changeUser(file, login, user => { user.hash = hash; });
}

function setRole(file, login, role) {
  validateRole(role);
  return changeUser(file, login, user => { user.role = role; });
}

function setDisabled(file, login, disabled) {
  if (typeof disabled !== 'boolean') throw new Error('"disabled" must be true or false.');
  return changeUser(file, login, user => { user.disabled = disabled; });
}

function removeAccount(file, login) {
  validateLogin(login);
  const users = readUsers(file);
  if (!users.some(user => user.login === login)) throw new Error(`Unknown user ${login}.`);
  writeUsers(file, users.filter(user => user.login !== login));
}

module.exports = {ROLES, LOGIN_PATTERN, validateLogin, validateRole, validatePassword, usersFilePath, parseUsers, readUsers,
  writeUsers, createUsersStore, createAccount, setPassword, setRole, setDisabled, removeAccount};
