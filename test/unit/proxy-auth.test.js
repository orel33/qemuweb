// Identity given by the authenticating front end (--auth proxy), without a server: the shared keys, one or
// two (X-Proxy-Key), the headers trusted only with it, auto-provisioned students, accounts of users.json
// (admin role, disabled flag, no password), the Socket.IO handshake, the options and scripts/user.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {spawnSync} = require('node:child_process');
const {hashPassword} = require('../../server/auth/passwords');
const {writeUsers, readUsers, createAccount, setPassword, parseUsers} = require('../../server/auth/users-store');
const {COOKIE_NAME, newSecret, signSession} = require('../../server/auth/cookie');
const {readProxyKeys, matchesAnyKey} = require('../../server/auth/proxy');
const {createAuth} = require('../../server/auth');
const {defaultSettings, parseServerArguments} = require('../../server/options');
const cli = require('../../common/cli');

const root = path.join(__dirname, '..', '..');
const KEY = 'k'.repeat(64);
const FAST = {N: 1024};

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-proxy-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

const exchange = (headers = {}, extra = {}) => {
  const res = {statusCode: 200, headers: {}, body: null, redirected: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set() { return this; },
    append(name, value) { (this.headers[name] = this.headers[name] || []).push(value); },
    redirect(code, location) { this.statusCode = code; this.redirected = location; }};
  return {req: {method: 'GET', path: '/api/nodes', headers, secure: false, ...extra}, res};
};

// The result of identify: {req, res, next}.
function identify(auth, headers, extra) {
  const {req, res} = exchange(headers, extra);
  let next = false;
  auth.identify(req, res, () => { next = true; });
  return {req, res, next};
}

async function setup(t, {mode = 'proxy', users = [], logoutUrl = null, keys = [KEY]} = {}) {
  const dir = tempDir(t);
  const usersFile = path.join(dir, 'users.json');
  writeUsers(usersFile, users);
  const lines = [];
  let clock = 1000000;
  const secret = newSecret();
  const settings = {...defaultSettings(root), usersFile, authMode: mode, proxyKeyFile: path.join(dir, 'key'), logoutUrl};
  const auth = createAuth({settings, secret, proxyKeys: keys, now: () => clock, userLog: {record: (...args) => lines.push(args)}});
  return {auth, lines, usersFile, secret, tick: ms => { clock += ms; }, now: () => clock};
}

const front = (login, extra = {}) => ({'x-proxy-key': KEY, 'x-remote-user': login, ...extra});

test('with the key, X-Remote-User is the identity: an unknown login is a student', async t => {
  const {auth} = await setup(t);
  const {req, next} = identify(auth, front('alice.martin', {'x-user-displayname': 'Alice Martin', 'x-user-mail': 'alice@example.org', 'x-user-groups': 'admins'}));
  assert.equal(next, true);
  assert.deepEqual(req.user, {login: 'alice.martin', role: 'student', via: 'proxy', displayName: 'Alice Martin', mail: 'alice@example.org'});
  assert.equal(identify(auth, front('bob')).req.user.displayName, undefined, 'the display name is optional');
  assert.equal(identify(auth, front('bob', {'x-user-displayname': Buffer.from('Élodie\n', 'utf8').toString('latin1')})).req.user.displayName, 'Élodie', 'UTF-8 from Apache, no control character');
});

test('forged identity headers are never trusted without the right key', async t => {
  for (const mode of ['proxy']) {
    const {auth, lines} = await setup(t, {mode, users: [{login: 'boss', hash: await hashPassword('pw', FAST), role: 'admin'}]});
    for (const headers of [{'x-remote-user': 'boss'}, {'x-remote-user': 'boss', 'x-user-groups': 'admins'}]) {
      const {req, res, next} = identify(auth, headers);
      assert.equal(req.user, undefined, `${mode}: no key, no identity`);
      assert.equal(res.statusCode, 200);
      assert.equal(next, true);
    }
    const wrong = identify(auth, {'x-proxy-key': `${KEY}x`, 'x-remote-user': 'boss'});
    assert.equal(wrong.next, false, `${mode}: a wrong key is refused`);
    assert.equal(wrong.res.statusCode, 403);
    assert.equal(wrong.req.user, undefined);
    assert.equal(identify(auth, {'x-proxy-key': '', 'x-remote-user': 'boss'}).res.statusCode, 403, 'an empty key is wrong');
    assert.equal(identify(auth, {'x-proxy-key': KEY.slice(1), 'x-remote-user': 'boss'}).res.statusCode, 403, 'a shorter key is wrong');
    assert.equal(lines.filter(([, event]) => event === 'proxy-refused').length, 1, 'the refusal is audited (not at every request)');
    assert.doesNotMatch(JSON.stringify(lines), new RegExp(KEY.slice(0, 8)), 'the key is never logged');
  }
});

test('a refused key is audited again after the throttling interval', async t => {
  const {auth, lines, tick} = await setup(t);
  identify(auth, {'x-proxy-key': 'wrong'});
  identify(auth, {'x-proxy-key': 'wrong'});
  tick(11000);
  identify(auth, {'x-proxy-key': 'wrong'});
  assert.deepEqual(lines.map(([user, event, target]) => [user, event, target.reason]), [['', 'proxy-refused', 'wrong proxy key'], ['', 'proxy-refused', 'wrong proxy key']]);
});

test('in proxy mode a request without the key is 401, whatever it carries', async t => {
  const {auth} = await setup(t, {mode: 'proxy'});
  for (const url of ['/api/nodes', '/', '/auth/login']) {
    const {req, res, next} = identify(auth, {'x-remote-user': 'alice'}, {path: url});
    assert.equal(next, true);
    auth.requireUser(req, res, () => { throw new Error('must not pass'); });
    assert.equal(res.statusCode, 401, url);
  }
  // There is no login page: not even for a request that has an identity.
  for (const url of ['/login.html', '/login.js']) {
    const {req, res} = identify(auth, front('alice'), {path: url});
    auth.requireUser(req, res, () => { throw new Error('must not pass'); });
    assert.equal(res.statusCode, 404, url);
  }
  const {req, res} = identify(auth, {}, {path: '/auth/me'});
  let passed = false;
  auth.requireUser(req, res, () => { passed = true; });
  assert.equal(passed, true, '/auth/me tells the page which mode it is in');
  // The key without a login is no identity either.
  assert.equal(identify(auth, {'x-proxy-key': KEY}).req.user, undefined);
});

test('invalid logins and disabled accounts are refused through the proxy', async t => {
  const hash = await hashPassword('pw', FAST);
  const {auth} = await setup(t, {users: [{login: 'gone', hash, role: 'student', disabled: true}, {login: 'nopw', role: 'student', disabled: true}]});
  for (const login of ['../x', 'a b', '.hidden', 'x'.repeat(65), 'é']) assert.equal(identify(auth, front(login)).res.statusCode, 403, login);
  assert.equal(identify(auth, front('gone')).res.statusCode, 403, 'a disabled password account');
  assert.equal(identify(auth, front('nopw')).res.statusCode, 403, 'a disabled account without password');
  // Even a valid session cookie does not rescue a disabled account when the proxy names it.
  assert.equal(identify(auth, front('gone', {cookie: 'a=b'})).next, false);
});

test('an account of users.json keeps its role through the proxy; an account without password is recognised', async t => {
  const hash = await hashPassword('pw', FAST);
  const {auth, usersFile} = await setup(t, {users: [{login: 'boss', role: 'admin'}, {login: 'tutor', hash, role: 'admin'}, {login: 'kim', role: 'student'}]});
  assert.equal(identify(auth, front('boss')).req.user.role, 'admin');
  assert.equal(identify(auth, front('tutor')).req.user.role, 'admin');
  assert.equal(identify(auth, front('kim')).req.user.role, 'student');
  writeUsers(usersFile, [{login: 'boss', role: 'student'}]);
  assert.equal(identify(auth, front('boss')).req.user.role, 'student', 'a role change applies at once');
  // The same login is the same session whatever the way in: req.user.login is the session key.
  assert.equal(identify(auth, front('boss')).req.user.login, 'boss');
});

test('an account without password cannot log in with a password; the password flow is unchanged for the others', async t => {
  const hash = await hashPassword('pw', FAST);
  const {auth} = await setup(t, {mode: 'password', users: [{login: 'boss', role: 'admin'}, {login: 'toto', hash, role: 'student'}]});
  assert.equal(await auth.authenticate('boss', ''), null);
  assert.equal(await auth.authenticate('boss', 'pw'), null);
  assert.deepEqual(await auth.authenticate('toto', 'pw'), {login: 'toto', role: 'student'});
});

test('proxy mode ignores a session cookie; password mode serves the cookie and the login page', async t => {
  const hash = await hashPassword('pw', FAST);
  const users = [{login: 'toto', hash, role: 'student'}];
  const proxy = await setup(t, {users});
  const cookie = `${COOKIE_NAME}=${signSession(proxy.secret, {login: 'toto', issued: proxy.now(), expires: proxy.now() + 3600e3})}`;
  assert.equal(identify(proxy.auth, {cookie}).req.user, undefined, 'a cookie is no identity with --auth proxy');
  const password = await setup(t, {mode: 'password', users});
  const withCookie = `${COOKIE_NAME}=${signSession(password.secret, {login: 'toto', issued: password.now(), expires: password.now() + 3600e3})}`;
  assert.deepEqual(identify(password.auth, {cookie: withCookie}).req.user, {login: 'toto', role: 'student'});
  const none = identify(password.auth, {}, {path: '/'});
  auth_requireUser(password.auth, none);
  assert.equal(none.res.redirected, '/login.html', 'a visit without a session gets the login page');
  const forged = identify(password.auth, front('toto', {cookie: withCookie}));
  assert.equal(forged.req.user.via, undefined, 'the proxy headers do not count in password mode');
  assert.equal(forged.res.headers['Set-Cookie'], undefined);
});

function auth_requireUser(auth, {req, res}) {
  auth.requireUser(req, res, () => {});
}

test('proxy mode: a proxy identity gets no cookie', async t => {
  const {auth} = await setup(t);
  assert.equal(identify(auth, front('boss')).res.headers['Set-Cookie'], undefined, 'no cookie for a proxy identity');
});

test('password mode ignores the proxy headers and the key completely', async t => {
  const {auth} = await setup(t, {mode: 'password'});
  const {req, res, next} = identify(auth, front('boss'));
  assert.equal(next, true);
  assert.equal(req.user, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(identify(auth, {'x-proxy-key': 'wrong', 'x-remote-user': 'boss'}).res.statusCode, 200, 'no key check in password mode');
});

test('Socket.IO handshakes use the same identity; open sockets are re-checked with their way in', async t => {
  const hash = await hashPassword('pw', FAST);
  const {auth, usersFile} = await setup(t, {users: [{login: 'toto', hash, role: 'student'}]});
  const handshake = headers => new Promise(resolve => { const socket = {request: {headers}, data: {}}; auth.socketMiddleware(socket, error => resolve({error, socket})); });
  let result = await handshake(front('alice'));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.socket.data.user, {login: 'alice', role: 'student', via: 'proxy'});
  assert.match((await handshake({'x-proxy-key': 'wrong', 'x-remote-user': 'alice'})).error.message, /Forbidden/);
  assert.match((await handshake({'x-remote-user': 'alice'})).error.message, /Authentication required/, 'forged header, no key');
  assert.deepEqual(auth.currentUser('alice', 'proxy'), {login: 'alice', role: 'student', via: 'proxy'});
  assert.equal(auth.currentUser('alice'), null, 'no cookie login with --auth proxy');
  assert.equal(auth.currentUser('toto'), null, 'no cookie login with --auth proxy');
  writeUsers(usersFile, [{login: 'alice', role: 'student', disabled: true}]);
  assert.equal(auth.currentUser('alice', 'proxy'), null, 'disabled in users.json: the open socket is closed');
});

test('/auth/me, login and logout through the routes: via, display name, logout URL, no key or password logged', async t => {
  const {auth, lines} = await setup(t, {logoutUrl: 'https://qw.example/.openid?logout=https://qw.example/bye'});
  const routes = {};
  auth.register({post: (route, ...handlers) => { routes[`POST ${route}`] = handlers.at(-1); }, get: (route, ...handlers) => { routes[`GET ${route}`] = handlers.at(-1); }});
  const call = async (route, req) => { const res = exchange().res; await routes[route]({secure: false, headers: {}, ...req}, res); return res; };
  const me = identify(auth, front('alice', {'x-user-displayname': 'Alice'}));
  assert.deepEqual((await call('GET /auth/me', {user: me.req.user})).body,
    {login: 'alice', role: 'student', authMode: 'proxy', via: 'proxy', displayName: 'Alice', logoutUrl: 'https://qw.example/.openid?logout=https://qw.example/bye'});
  const direct = (await call('GET /auth/me', {user: {login: 'toto', role: 'student'}})).body;
  assert.equal(direct.via, 'password');
  assert.equal(direct.logoutUrl, undefined, 'the logout URL is for the front end identity only');
  await call('POST /auth/logout', {user: me.req.user});
  assert.deepEqual(lines.map(([user, event, target]) => [user, event, target]), [['alice', 'login', {via: 'proxy'}], ['alice', 'logout', {via: 'proxy'}]]);
  assert.doesNotMatch(JSON.stringify(lines), new RegExp(KEY));
});

test('proxy mode refuses /auth/login with 404 and says why, for anybody', async t => {
  const {auth} = await setup(t, {mode: 'proxy'});
  const routes = {};
  auth.register({post: (route, ...handlers) => { routes[`POST ${route}`] = handlers.at(-1); }, get: () => {}});
  const res = exchange().res;
  await routes['POST /auth/login']({body: {login: 'toto', password: 'pw'}, headers: {}}, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /no password login with --auth proxy/);
});

test('the proxy key file must be private and hold one or two usable keys', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'proxy-key');
  const KEY2 = 'j'.repeat(64);
  fs.writeFileSync(file, `${KEY}\n`, {mode: 0o600});
  assert.deepEqual(readProxyKeys(file), [KEY]);
  fs.writeFileSync(file, KEY);
  assert.deepEqual(readProxyKeys(file), [KEY], 'no final newline');
  fs.writeFileSync(file, `${KEY}\r\n${KEY2}\r\n\n`);
  assert.deepEqual(readProxyKeys(file), [KEY, KEY2], 'two keys, final empty lines ignored');
  fs.chmodSync(file, 0o640);
  assert.throws(() => readProxyKeys(file), /owner only/);
  fs.chmodSync(file, 0o400);
  assert.deepEqual(readProxyKeys(file), [KEY, KEY2], 'stricter than 0600 is accepted');
  fs.chmodSync(file, 0o600);
  for (const bad of ['', '\n', 'short\n', 'has space in the middle of the key line\n', `${KEY}\nshort\n`, `${KEY}\n\n${KEY2}\n`,
    `${KEY}\n${KEY2}\n${'i'.repeat(64)}\n`, `${KEY}\nignored text\n`, `${KEY}\n${'x'.repeat(513)}\n`]) {
    fs.writeFileSync(file, bad);
    assert.throws(() => readProxyKeys(file), /one key, or two during a rotation/, JSON.stringify(bad));
  }
  assert.throws(() => readProxyKeys(path.join(dir, 'missing')), /ENOENT/);
  // The server itself refuses to start the web stack without a readable key.
  assert.throws(() => createAuth({settings: {...defaultSettings(root), authMode: 'proxy', usersFile: path.join(dir, 'users.json'), proxyKeyFile: path.join(dir, 'missing')}}), /ENOENT/);
});

test('during a rotation either of the two keys is accepted, any other is still 403', async t => {
  const KEY2 = 'j'.repeat(64);
  const {auth} = await setup(t, {keys: [KEY, KEY2]});
  assert.equal(identify(auth, {'x-proxy-key': KEY, 'x-remote-user': 'alice'}).req.user.login, 'alice', 'the first key');
  assert.equal(identify(auth, {'x-proxy-key': KEY2, 'x-remote-user': 'alice'}).req.user.login, 'alice', 'the second key');
  for (const wrong of [`${KEY}x`, KEY2.slice(1), 'z'.repeat(64), '']) {
    const refused = identify(auth, {'x-proxy-key': wrong, 'x-remote-user': 'alice'});
    assert.equal(refused.res.statusCode, 403, JSON.stringify(wrong));
    assert.equal(refused.req.user, undefined);
  }
  assert.equal(matchesAnyKey(KEY2, [KEY, KEY2]), true);
  assert.equal(matchesAnyKey('nope', [KEY, KEY2]), false);
});

test('the key file of two lines starts the server; a third line is refused at startup', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'proxy-key');
  const settings = {...defaultSettings(root), authMode: 'proxy', usersFile: path.join(dir, 'users.json'), proxyKeyFile: file};
  fs.writeFileSync(file, `${KEY}\n${'j'.repeat(64)}\n`, {mode: 0o600});
  assert.doesNotThrow(() => createAuth({settings}));
  fs.writeFileSync(file, `${KEY}\n${'j'.repeat(64)}\n${'i'.repeat(64)}\n`);
  assert.throws(() => createAuth({settings}), /one key, or two during a rotation/);
});

test('options: --auth takes password or proxy, the key file is required for proxy, both is refused', () => {
  assert.equal(parseServerArguments([], {root}).authMode, 'password');
  assert.equal(parseServerArguments(['--auth', 'password'], {root}).authMode, 'password');
  const settings = parseServerArguments(['--auth', 'proxy', '--proxy-key-file', '/etc/qemuweb/proxy-key', '--logout-url', 'https://qw.example/bye'], {root});
  assert.deepEqual([settings.authMode, settings.proxyKeyFile, settings.logoutUrl], ['proxy', '/etc/qemuweb/proxy-key', 'https://qw.example/bye']);
  assert.equal(parseServerArguments([], {root}).proxyKeyFile, null);
  for (const bad of [['--auth', 'proxy'], ['--auth', 'openid', '--proxy-key-file', 'k'], ['--auth', 'password', '--no-auth']]) {
    assert.throws(() => parseServerArguments(bad, {root}), cli.UsageError, bad.join(' '));
  }
  // The retired mode is an unknown value, with the usual message.
  for (const bad of [['--auth', 'both'], ['--auth', 'both', '--proxy-key-file', 'k']]) {
    assert.throws(() => parseServerArguments(bad, {root}), error => error instanceof cli.UsageError && /^Invalid value for --auth: both \(one of password, proxy\)$/.test(error.message), bad.join(' '));
  }
  assert.match(cli.formatHelp(require('../../server/options').serverSpec(root)), /--auth MODE +\[password\]/);
});

test('users.json: an account without hash is valid, written without hash; passwd refuses it', async t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'users.json');
  assert.deepEqual(await createAccount(file, {login: 'boss', role: 'admin', noPassword: true}), {login: 'boss', role: 'admin', disabled: false});
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).users, [{login: 'boss', role: 'admin'}]);
  assert.equal(readUsers(file)[0].hash, undefined);
  await assert.rejects(createAccount(file, {login: 'x', noPassword: true, password: 'pw'}), /takes no password/);
  await assert.rejects(createAccount(file, {login: 'y'}), /must not be empty/);
  await assert.rejects(setPassword(file, 'boss', 'new', FAST), /no password/);
  assert.throws(() => parseUsers(JSON.stringify({schemaVersion: 1, users: [{login: 'a', hash: 'bad', role: 'student'}]})), /invalid password hash/);
});

function userScript(dir, args, extra = {}) {
  const env = {...process.env};
  delete env.QEMUWEB_PASSWORD;
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'user.js'), '--users', path.join(dir, 'users.json'), ...args], {env, input: '', encoding: 'utf8', ...extra});
}

test('scripts/user.js add --no-password asks for no password, list shows it, passwd refuses it', t => {
  const dir = tempDir(t);
  let result = userScript(dir, ['add', 'boss', '--role', 'admin', '--no-password']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Added boss \(admin, no password\)/);
  assert.equal(userScript(dir, ['add', 'kim', '--no-password']).status, 0);
  assert.equal(userScript(dir, ['add', 'bad', '--no-password', '--no-password']).status, 2);
  assert.equal(userScript(dir, ['add', 'bad', '--frob']).status, 2);
  assert.equal(userScript(dir, ['list']).stdout, 'boss\tadmin\tno password\nkim\tstudent\tno password\n');
  result = userScript(dir, ['passwd', 'boss'], {env: {...process.env, QEMUWEB_PASSWORD: 'pw'}});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no password/);
  assert.equal(userScript(dir, ['disable', 'kim']).status, 0);
  assert.equal(readUsers(path.join(dir, 'users.json')).find(user => user.login === 'kim').disabled, true);
});
