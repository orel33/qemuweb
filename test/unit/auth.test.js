// Authentication unit tests: password hashes, users file, signed cookie,
// the auth middleware and the user administration script. No server is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {spawnSync} = require('node:child_process');
const {hashPassword, verifyPassword, isPasswordHash} = require('../../lib/auth/passwords');
const {validateLogin, readUsers, writeUsers, parseUsers, usersFilePath, createUsersStore} = require('../../lib/auth/users-store');
const {COOKIE_NAME, newSecret, signSession, verifySession, parseCookies, sessionCookie} = require('../../lib/auth/cookie');
const {createAuth} = require('../../lib/auth');

const root = path.join(__dirname, '..', '..');
const FAST = {N: 1024};

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-auth-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

test('scrypt hashes round-trip, are salted and reject a wrong password', async () => {
  const hash = await hashPassword('s3cret', FAST);
  assert.ok(isPasswordHash(hash));
  assert.match(hash, /^scrypt\$1024\$8\$1\$/);
  assert.equal(await verifyPassword('s3cret', hash), true);
  assert.equal(await verifyPassword('s3cret ', hash), false);
  assert.equal(await verifyPassword('', hash), false);
  assert.notEqual(await hashPassword('s3cret', FAST), hash, 'two hashes of one password share a salt');
  assert.equal(await verifyPassword('s3cret', 'scrypt$1000$8$1$AAAA$AAAA'), false, 'N must be a power of two');
  assert.equal(await verifyPassword('s3cret', 'plain'), false);
  await assert.rejects(hashPassword(''), /must not be empty/);
});

test('logins use a short safe character set', () => {
  for (const login of ['toto', 'alice.martin', 'a_b-c', 'jean@example.org', 'A1', 'x'.repeat(64)]) assert.equal(validateLogin(login), login);
  for (const login of ['', '.', '..', '.hidden', '-dash', 'a/b', 'a b', 'é', 'x'.repeat(65), 'a%2F', null, 42]) {
    assert.throws(() => validateLogin(login), /Invalid login/, String(login));
  }
});

test('the users file is validated, written with mode 0600 and sorted', async t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'users.json');
  assert.deepEqual(readUsers(file), [], 'a missing file means no user');
  const hash = await hashPassword('pw', FAST);
  writeUsers(file, [{login: 'zoe', hash, role: 'student'}, {login: 'adam', hash, role: 'admin'}]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readUsers(file).map(user => user.login), ['adam', 'zoe']);
  const bad = users => JSON.stringify({schemaVersion: 1, users});
  assert.throws(() => parseUsers(bad([{login: 'a', hash, role: 'teacher'}])), /Invalid role/);
  assert.throws(() => parseUsers(bad([{login: 'a', hash: 'x', role: 'student'}])), /invalid password hash/);
  assert.throws(() => parseUsers(bad([{login: 'a', hash, role: 'student'}, {login: 'a', hash, role: 'admin'}])), /duplicate login/);
  assert.throws(() => parseUsers(bad([{login: 'a', hash, role: 'student', extra: 1}])), /invalid user entry/);
  assert.throws(() => parseUsers('{"users": []}'), /schemaVersion 1/);
  assert.equal(usersFilePath('/srv/qemuweb', {}), '/srv/qemuweb/users.json');
  assert.equal(usersFilePath('/srv/qemuweb', {QEMUWEB_USERS_FILE: '/etc/qemuweb/users.json'}), '/etc/qemuweb/users.json');
});

test('the users store sees changes to the file without a restart', async t => {
  const file = path.join(tempDir(t), 'users.json');
  const store = createUsersStore(file);
  assert.equal(store.get('toto'), null);
  writeUsers(file, [{login: 'toto', hash: await hashPassword('toto', FAST), role: 'student'}]);
  assert.equal(store.get('toto').role, 'student');
  writeUsers(file, []);
  assert.equal(store.get('toto'), null);
});

test('session cookies are signed, expire and reject tampering', t => {
  const secret = newSecret();
  assert.equal(secret.length, 32);
  assert.notDeepEqual(newSecret(), secret, 'every call (every server start) gives a new secret');
  const value = signSession(secret, {login: 'toto', issued: 1000, expires: 5000});
  assert.deepEqual(verifySession(secret, value, 2000), {login: 'toto', issued: 1000, expires: 5000});
  assert.equal(verifySession(secret, value, 5000), null, 'expired');
  assert.equal(verifySession(Buffer.alloc(32, 1), value, 2000), null, 'other secret');
  const [data, signature] = value.split('.');
  const forged = Buffer.from(JSON.stringify({login: 'titi', issued: 1000, expires: 5000})).toString('base64url');
  assert.equal(verifySession(secret, `${forged}.${signature}`, 2000), null, 'forged payload');
  assert.equal(verifySession(secret, `${data}.${signature}x`, 2000), null);
  assert.equal(verifySession(secret, `${data}.${signature}.x`, 2000), null);
  assert.equal(verifySession(secret, undefined, 2000), null);
  assert.deepEqual(parseCookies(`a=1; ${COOKIE_NAME}=${value}; b=%41`), {a: '1', [COOKIE_NAME]: value, b: 'A'});
  const header = sessionCookie(value, {maxAgeMs: 12 * 3600 * 1000, secure: false});
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Max-Age=43200/);
  assert.doesNotMatch(header, /Secure/);
  assert.match(sessionCookie(value, {maxAgeMs: 1000, secure: true}), /; Secure$/);
});

// Minimal Express-like request and response doubles.
function exchange({method = 'GET', path: url = '/', headers = {}} = {}) {
  const res = {statusCode: 200, headers: {}, body: null, redirected: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    append(name, value) { (this.headers[name] = this.headers[name] || []).push(value); },
    redirect(code, location) { this.statusCode = code; this.redirected = location; }};
  return {req: {method, path: url, headers, secure: false}, res};
}

function run(middleware, req, res) {
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return nextCalled;
}

test('the auth facade authenticates, identifies the cookie and guards pages and API', async t => {
  const dir = tempDir(t);
  const usersFile = path.join(dir, 'users.json');
  writeUsers(usersFile, [{login: 'toto', hash: await hashPassword('toto', FAST), role: 'student'}]);
  let clock = 1000000;
  const secret = newSecret();
  const auth = createAuth({root, env: {QEMUWEB_USERS_FILE: usersFile}, now: () => clock, secret});
  assert.equal(auth.mode, 'password');
  assert.deepEqual(await auth.authenticate('toto', 'toto'), {login: 'toto', role: 'student'});
  assert.equal(await auth.authenticate('toto', 'titi'), null);
  assert.equal(await auth.authenticate('nobody', 'toto'), null);
  assert.equal(await auth.authenticate('../x', 'toto'), null);

  const cookie = `${COOKIE_NAME}=${signSession(secret, {login: 'toto', issued: clock, expires: clock + 3600e3})}`;
  let {req, res} = exchange({headers: {cookie}});
  assert.equal(run(auth.identify, req, res), true);
  assert.deepEqual(req.user, {login: 'toto', role: 'student'});
  assert.equal(res.headers['Set-Cookie'], undefined, 'no renewal within a minute');
  clock += 120e3;
  ({req, res} = exchange({headers: {cookie}}));
  run(auth.identify, req, res);
  assert.match(res.headers['Set-Cookie'][0], /Max-Age=43200/, 'sliding renewal on activity');

  ({req, res} = exchange({path: '/api/nodes'}));
  run(auth.identify, req, res);
  assert.equal(run(auth.requireUser, req, res), false);
  assert.equal(res.statusCode, 401);
  ({req, res} = exchange({path: '/'}));
  assert.equal(run(auth.requireUser, req, res), false);
  assert.equal(res.redirected, '/login.html');
  for (const url of ['/login.html', '/login.js', '/css/app.css', '/auth/login']) {
    ({req, res} = exchange({path: url}));
    assert.equal(run(auth.requireUser, req, res), true, url);
  }

  ({req, res} = exchange({method: 'POST', path: '/api/hosts'}));
  run(auth.identify, req, res);
  assert.equal(run(auth.requireUser, req, res), false, 'an anonymous POST is refused');
  assert.equal(res.statusCode, 401);

  const socket = (headers) => ({request: {headers}, data: {}});
  const accept = s => new Promise(resolve => auth.socketMiddleware(s, error => resolve(error || null)));
  const ok = socket({host: '127.0.0.1:3002', cookie});
  assert.equal(await accept(ok), null);
  assert.equal(ok.data.user.login, 'toto');
  assert.match((await accept(socket({host: '127.0.0.1:3002'}))).message, /Authentication required/);
  assert.match((await accept(socket({host: '127.0.0.1:3002', cookie: `${COOKIE_NAME}=forged.value`}))).message, /Authentication required/);

  writeUsers(usersFile, []);
  ({req, res} = exchange({headers: {cookie}}));
  run(auth.identify, req, res);
  assert.equal(req.user, undefined, 'a removed account loses access');
});

test('QEMUWEB_AUTH=off gives one implicit user and only accepts explicit values', t => {
  const dir = tempDir(t);
  const auth = createAuth({root, env: {QEMUWEB_AUTH: 'off', QEMUWEB_USERS_FILE: path.join(dir, 'users.json')}});
  assert.equal(auth.mode, 'off');
  const {req, res} = exchange({path: '/api/nodes'});
  run(auth.identify, req, res);
  assert.equal(req.user.login, 'local');
  assert.throws(() => createAuth({root, env: {QEMUWEB_AUTH: 'no'}}), /Invalid QEMUWEB_AUTH/);
  assert.throws(() => createAuth({root, env: {QEMUWEB_SESSION_HOURS: '-1'}}), /QEMUWEB_SESSION_HOURS/);
});

function userScript(dir, args, {input, password} = {}) {
  const env = {...process.env, QEMUWEB_USERS_FILE: path.join(dir, 'users.json')};
  delete env.QEMUWEB_PASSWORD;
  if (password !== undefined) env.QEMUWEB_PASSWORD = password;
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'user.js'), ...args], {env, input: input ?? '', encoding: 'utf8'});
}

test('scripts/user.js adds, lists, changes, imports and removes accounts', async t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'users.json');
  let result = userScript(dir, ['add', 'toto'], {input: 'toto\n'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(await verifyPassword('toto', readUsers(file)[0].hash), true);
  assert.equal(userScript(dir, ['add', 'toto'], {password: 'x'}).status, 1, 'duplicate login');
  assert.equal(userScript(dir, ['add', 'bad/login'], {password: 'x'}).status, 1);
  assert.equal(userScript(dir, ['add', 'empty'], {password: ''}).status, 1, 'empty password');
  result = userScript(dir, ['add', 'boss', '--role', 'admin'], {password: 'boss'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(userScript(dir, ['passwd', 'toto'], {password: 'new'}).status, 0);
  assert.equal(await verifyPassword('new', readUsers(file).find(user => user.login === 'toto').hash), true);
  assert.equal(userScript(dir, ['role', 'toto', 'admin']).status, 0);
  const csv = path.join(dir, 'class.csv');
  fs.writeFileSync(csv, 'login,password,role\ntiti,titi\ntoto,toto2,student\n# comment\n');
  result = userScript(dir, ['import-csv', csv]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 added, 1 updated/);
  assert.equal(userScript(dir, ['list']).stdout, 'boss\tadmin\ntiti\tstudent\ntoto\tstudent\n');
  fs.writeFileSync(csv, 'titi\n');
  assert.equal(userScript(dir, ['import-csv', csv]).status, 1, 'malformed CSV line');
  assert.equal(userScript(dir, ['remove', 'titi']).status, 0);
  assert.equal(userScript(dir, ['remove', 'titi']).status, 1);
  assert.equal(userScript(dir, ['frobnicate']).status, 2);
  assert.deepEqual(readUsers(file).map(user => user.login), ['boss', 'toto']);
});

test('a server restart logs everybody out: cookies of the previous run are refused', async t => {
  const dir = tempDir(t);
  const usersFile = path.join(dir, 'users.json');
  writeUsers(usersFile, [{login: 'toto', hash: await hashPassword('toto', FAST), role: 'student'}]);
  const env = {QEMUWEB_USERS_FILE: usersFile};
  const clock = 1000000;
  const firstRun = newSecret();
  const cookie = `${COOKIE_NAME}=${signSession(firstRun, {login: 'toto', issued: clock, expires: clock + 3600e3})}`;
  const same = createAuth({root, env, now: () => clock, secret: firstRun});
  let {req, res} = exchange({headers: {cookie}});
  run(same.identify, req, res);
  assert.deepEqual(req.user, {login: 'toto', role: 'student'});
  // Without an injected secret, every createAuth (every server start) draws a new one.
  const restarted = createAuth({root, env, now: () => clock});
  ({req, res} = exchange({headers: {cookie}}));
  run(restarted.identify, req, res);
  assert.equal(req.user, undefined);
});
