// Admin role unit tests: disabled accounts, shared account operations, admin.log and users.log, session
// activity, requireAdmin, the observation gate, the session summary, console control and the
// observer input rules. No server is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {spawnSync} = require('node:child_process');
const {hashPassword, verifyPassword} = require('../../server/auth/passwords');
const {readUsers, writeUsers, parseUsers, createAccount, setPassword, setRole, setDisabled} = require('../../server/auth/users-store');
const {COOKIE_NAME, newSecret, signSession} = require('../../server/auth/cookie');
const {createAuth} = require('../../server/auth');
const {defaultSettings, parseServerArguments} = require('../../server/options');
const {ADMIN_LOG, USERS_LOG, createLogDir, createAudit, createUserLog, readLogTail} = require('../../server/audit');
const {userEvent} = require('../../server/routes');
const {Session} = require('../../server/session');
const {ConsoleControl, CONTROL_IDLE_MS} = require('../../server/console-control');
const {observationGate, observationRule, sessionSummary} = require('../../server/routes/admin');
const {consoleRefusal, createObservationTracker} = require('../../server/sockets');
const {paneCount, normalizeView, normalizeGeometry, normalizeViewport, normalizeLinkStyle, linkStyleChange, geometryPixels, geometryFraction, sameView, followsView, normalizeObservers} = require('../../public/view-state');

const root = path.join(__dirname, '..', '..');
const settingsFor = (usersFile, extra = {}) => ({...defaultSettings(root), usersFile, ...extra});
const FAST = {N: 1024};

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-admin-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function response() {
  return {statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    append(name, value) { (this.headers[name] = this.headers[name] || []).push(value); }};
}

function request({method = 'GET', path: url = '/api/nodes', headers = {}, user} = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {method, path: url, headers: lower, user, secure: false, get: name => lower[name.toLowerCase()]};
}

function run(middleware, req, res) {
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return nextCalled;
}

test('users.json accepts an optional boolean "disabled", written only when true', async () => {
  const hash = await hashPassword('pw', FAST);
  const text = users => JSON.stringify({schemaVersion: 1, users});
  assert.equal(parseUsers(text([{login: 'a', hash, role: 'student', disabled: true}]))[0].disabled, true);
  assert.throws(() => parseUsers(text([{login: 'a', hash, role: 'student', disabled: 'yes'}])), /"disabled" must be true or false/);
});

test('the shared account operations create, reset, change role and disable accounts', async t => {
  const file = path.join(tempDir(t), 'users.json');
  assert.deepEqual(await createAccount(file, {login: 'toto', password: 'pw', role: 'student'}, FAST), {login: 'toto', role: 'student', disabled: false});
  await assert.rejects(createAccount(file, {login: 'toto', password: 'x'}, FAST), /already exists/);
  await assert.rejects(createAccount(file, {login: 'bad/login', password: 'x'}, FAST), /Invalid login/);
  await assert.rejects(createAccount(file, {login: 'empty', password: ''}, FAST), /must not be empty/);
  await assert.rejects(createAccount(file, {login: 'x', password: 'x', role: 'teacher'}, FAST), /Invalid role/);
  await setPassword(file, 'toto', 'new', FAST);
  assert.equal(await verifyPassword('new', readUsers(file)[0].hash), true);
  await assert.rejects(setPassword(file, 'nobody', 'x', FAST), /Unknown user/);
  assert.equal(setRole(file, 'toto', 'admin').role, 'admin');
  assert.equal(setDisabled(file, 'toto', true).disabled, true);
  assert.match(fs.readFileSync(file, 'utf8'), /"disabled": true/);
  assert.equal(setDisabled(file, 'toto', false).disabled, false);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /disabled/, 'false is not written');
  assert.throws(() => setDisabled(file, 'toto', 'no'), /must be true or false/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a disabled account cannot log in, and its cookie and sockets are refused at once', async t => {
  const usersFile = path.join(tempDir(t), 'users.json');
  writeUsers(usersFile, [{login: 'toto', hash: await hashPassword('toto', FAST), role: 'student'}]);
  const clock = 1000000;
  const secret = newSecret();
  const auth = createAuth({settings: settingsFor(usersFile), now: () => clock, secret});
  const cookie = `${COOKIE_NAME}=${signSession(secret, {login: 'toto', issued: clock, expires: clock + 3600e3})}`;
  const identify = () => { const req = request({headers: {cookie}}); run(auth.identify, req, response()); return req.user; };
  const socket = () => ({request: {headers: {cookie}}, data: {}});
  const accept = s => new Promise(resolve => auth.socketMiddleware(s, error => resolve(error || null)));
  assert.deepEqual(identify(), {login: 'toto', role: 'student'});
  assert.equal(await accept(socket()), null);
  assert.deepEqual(auth.currentUser('toto'), {login: 'toto', role: 'student'});

  setDisabled(usersFile, 'toto', true);
  assert.equal(await auth.authenticate('toto', 'toto'), null);
  assert.equal(identify(), undefined);
  assert.match((await accept(socket())).message, /Authentication required/);
  assert.equal(auth.currentUser('toto'), null, 'open sockets re-check the account with currentUser');

  setDisabled(usersFile, 'toto', false);
  assert.deepEqual(await auth.authenticate('toto', 'toto'), {login: 'toto', role: 'student'});
  assert.deepEqual(identify(), {login: 'toto', role: 'student'});
  setRole(usersFile, 'toto', 'admin');
  assert.deepEqual(identify(), {login: 'toto', role: 'admin'}, 'a role change applies at the next request');
  assert.equal(auth.currentUser('nobody'), null);
});

test('requireAdmin answers 403 to anyone but an admin; --no-auth is admin', t => {
  const auth = createAuth({settings: settingsFor(path.join(tempDir(t), 'users.json'))});
  for (const user of [undefined, {login: 'toto', role: 'student'}]) {
    const res = response();
    assert.equal(run(auth.requireAdmin, request({user}), res), false);
    assert.equal(res.statusCode, 403);
  }
  assert.equal(run(auth.requireAdmin, request({user: {login: 'boss', role: 'admin'}}), response()), true);
  const off = createAuth({settings: settingsFor(path.join(tempDir(t), 'users.json'), {authMode: 'off'})});
  const req = request();
  run(off.identify, req, response());
  assert.equal(run(off.requireAdmin, req, response()), true);
  assert.deepEqual(off.currentUser('local'), {login: 'local', role: 'admin'});
});

test('scripts/user.js disables and enables accounts and lists their state', async t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'users.json');
  writeUsers(file, [{login: 'toto', hash: await hashPassword('toto', FAST), role: 'student'}]);
  const script = args => spawnSync(process.execPath, [path.join(root, 'scripts', 'user.js'), '--users', file, ...args],
    {input: '', encoding: 'utf8'});
  assert.equal(script(['disable', 'toto']).status, 0);
  assert.equal(readUsers(file)[0].disabled, true);
  assert.equal(script(['list']).stdout, 'toto\tstudent\tdisabled\n');
  assert.equal(script(['enable', 'toto']).status, 0);
  assert.equal(script(['list']).stdout, 'toto\tstudent\n');
  assert.equal(script(['disable', 'nobody']).status, 1);
  assert.equal(script(['disable']).status, 2);
});

test('admin.log appends one JSON line per action, mode 0600, in the logs directory', t => {
  assert.equal(defaultSettings('/srv/qemuweb').logDir, '/srv/qemuweb/logs');
  assert.equal(parseServerArguments(['--logs', '/var/log/qemuweb'], {root: '/srv/qemuweb'}).logDir, '/var/log/qemuweb');
  assert.equal(ADMIN_LOG, 'admin.log');
  const dir = path.join(tempDir(t), 'nested', 'logs');
  assert.equal(createLogDir(dir), dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(createLogDir(dir), dir, 'an existing directory is kept');
  const file = path.join(dir, ADMIN_LOG);
  const audit = createAudit({file, now: () => new Date('2026-01-02T03:04:05Z')});
  audit.record('boss', 'delete-session', {login: 'toto'});
  audit.record('boss', 'stop-all', {login: 'titi'}, new Error('Some nodes could not be stopped'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines, [
    {time: '2026-01-02T03:04:05.000Z', admin: 'boss', action: 'delete-session', target: {login: 'toto'}, result: 'ok'},
    {time: '2026-01-02T03:04:05.000Z', admin: 'boss', action: 'stop-all', target: {login: 'titi'}, result: 'error: Some nodes could not be stopped'}
  ]);
  const broken = createAudit({file: path.join(dir, 'missing', ADMIN_LOG)});
  const errors = [];
  t.mock.method(console, 'error', message => errors.push(message));
  assert.doesNotThrow(() => broken.record('boss', 'observe', {login: 'toto'}), 'a write failure never interrupts the action');
  assert.equal(errors.length, 1);
});

test('session activity is in memory and falls back to the creation date', () => {
  const session = new Session({runtimeRoot: '/nonexistent', owner: 'toto', createdAt: '2026-01-01T00:00:00.000Z'});
  assert.equal(session.lastActivity, null);
  assert.equal(session.lastActivityAt, '2026-01-01T00:00:00.000Z');
  session.touch(Date.parse('2026-01-01T02:00:00Z'));
  assert.equal(session.lastActivityAt, '2026-01-01T02:00:00.000Z');
});

test('the observation gate admits admins reading another session only', () => {
  const workspace = {owner: 'toto', session: {id: 'sess'}};
  const manager = {get: login => (login === 'toto' ? workspace : null), open() { throw new Error('observation must never open a session'); }};
  const gate = observationGate(manager);
  const admin = {login: 'boss', role: 'admin'};
  const check = (options, status) => {
    const req = request(options);
    const res = response();
    const passed = run(gate, req, res);
    assert.equal(passed, status === null, JSON.stringify(options));
    if (status !== null) assert.equal(res.statusCode, status, JSON.stringify(options));
    return req;
  };
  assert.equal(check({user: admin}, null).observed, undefined, 'no header: own session');
  assert.equal(check({user: admin, headers: {'X-Observe': 'toto'}}, null).observed, workspace);
  assert.equal(check({user: admin, method: 'HEAD', headers: {'X-Observe': 'toto'}}, null).observed, workspace);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) check({user: admin, method, headers: {'X-Observe': 'toto'}}, 403);
  check({user: {login: 'titi', role: 'student'}, headers: {'X-Observe': 'toto'}}, 403);
  check({user: admin, headers: {'X-Observe': 'nobody'}}, 404);
  check({user: admin, headers: {'X-Observe': '../x'}}, 404);
  assert.equal(check({user: admin, method: 'DELETE', headers: {'X-Observe': 'boss'}}, null).observed, undefined, 'observing yourself is your own session');
});

test('the session summary counts nodes, running VMs, reserved RAM and CPU', async () => {
  // The runner counts its nodes (session.summary)...
  const {commands} = require('../../runner/commands/consoles');
  const nodes = new Map([
    {id: 'h-1', kind: 'host', machine: {}, launchSettings: {memory: 1024}},
    {id: 'h-2', kind: 'host', machine: {}, launchSettings: {memory: 512}},
    {id: 'h-3', kind: 'host', machine: null, launchSettings: {memory: 4096}},
    {id: 's-1', kind: 'switch', machine: {}}
  ].map(node => [node.id, node]));
  const counts = commands['session.summary']({session: {nodes},
    runner: {metricsSnapshot: () => ({'h-1': {cpuPercent: 12.5}, 'h-2': {cpuPercent: null}, 'h-3': {cpuPercent: null}})}});
  // ...and the control plane adds what it owns.
  const session = new Session({runtimeRoot: '/nonexistent', runnerId: 'local', owner: 'toto', createdAt: '2026-01-01T00:00:00.000Z'});
  const runner = {request: async command => { assert.equal(command, 'session.summary'); return counts; }};
  const summary = await sessionSummary({owner: 'toto', session, runner}, 'boss', 2, 'local');
  assert.match(summary.sessionId, /^[0-9a-f]{8}$/);
  assert.deepEqual(summary, {login: 'toto', own: false, browsers: 2, runnerOffline: false, sessionId: session.id, runnerId: 'local', runnerName: 'local', placed: true, createdAt: '2026-01-01T00:00:00.000Z',
    lastActivity: '2026-01-01T00:00:00.000Z', nodes: 4, hosts: 3, switches: 1, runningHosts: 2, runningSwitches: 1,
    reservedRamMb: 1536, cpuPercent: 12.5, active: true});
  assert.equal((await sessionSummary({owner: 'boss', session, runner}, 'boss')).own, true);
  assert.equal((await sessionSummary({owner: 'boss', session, runner}, 'boss')).browsers, 0);
  // A session whose runner is offline is listed, with no counts, instead of failing the whole list.
  const offline = {request: async () => { throw Object.assign(new Error('The runner is offline; reconnecting…'), {status: 503}); }};
  const lost = await sessionSummary({owner: 'toto', session, runner: offline}, 'boss');
  assert.deepEqual([lost.runnerOffline, lost.nodes, lost.runningHosts, lost.active, lost.login], [true, 0, 0, false, 'toto']);
  // UXS02: a session not placed on any runner (no node) is listed with zero counts, placed: false.
  const {UnboundClient} = require('../../server/unbound-runner');
  const unplacedSession = new Session({owner: 'titi'});
  const unbound = new UnboundClient({settings: () => ({}), setEngine: () => ({}), forward: async () => []});
  const empty = await sessionSummary({owner: 'titi', session: unplacedSession, runner: unbound.session(unplacedSession.id)}, 'boss');
  assert.deepEqual([empty.placed, empty.runnerId, empty.runnerName, empty.runnerOffline, empty.nodes, empty.active], [false, null, null, false, 0, false]);
  // ADM03: the runner's name comes from the router (runners.json); without one the ID stands for it.
  const remote = new Session({runnerId: 'r-1a2b3c4d', owner: 'tata'});
  assert.equal((await sessionSummary({owner: 'tata', session: remote, runner}, 'boss', 0, 'salle-12')).runnerName, 'salle-12');
  assert.equal((await sessionSummary({owner: 'tata', session: remote, runner}, 'boss')).runnerName, 'r-1a2b3c4d');
  await assert.rejects(sessionSummary({owner: 'toto', session, runner: {request: async () => { throw new Error('boom'); }}}, 'boss'), /boom/);
});

test('session control is exclusive per session, renewed by input and released once', t => {
  assert.equal(CONTROL_IDLE_MS, 10 * 60 * 1000);
  // Mocked setTimeout/clearTimeout: the idle timer is driven by tick(), not by the machine load.
  t.mock.timers.enable({apis: ['setTimeout']});
  const released = [];
  const control = new ConsoleControl({onRelease: (lock, reason) => released.push([lock.sessionId, lock.admin, lock.login, reason])});
  assert.equal(control.take('s1', {admin: 'boss', login: 'toto'}), true);
  assert.equal(control.take('s1', {admin: 'boss', login: 'toto'}), false, 'renewal by the same admin');
  assert.throws(() => control.take('s1', {admin: 'chef', login: 'toto'}), /boss already controls this session/);
  assert.equal(control.get('s2'), null, 'locks are per session');
  assert.equal(control.release('s1', 'chef', 'released'), false, 'only the controlling admin releases');
  assert.equal(control.touch('s1', 'chef'), false);
  // Input renews the 10-minute idle timer.
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(CONTROL_IDLE_MS - 1000); assert.equal(control.touch('s1', 'boss'), true); }
  assert.deepEqual(released, []);
  t.mock.timers.tick(CONTROL_IDLE_MS - 1);
  assert.deepEqual(released, []);
  t.mock.timers.tick(1);
  assert.deepEqual(released, [['s1', 'boss', 'toto', 'idle']]);
  assert.equal(control.get('s1'), null);

  control.take('s1', {admin: 'boss', login: 'toto'});
  control.take('s2', {admin: 'chef', login: 'titi'});
  assert.equal(control.heldBy('s1', 'boss'), true);
  assert.equal(control.heldBy('s1', 'chef'), false);
  assert.equal(control.hasLock('s2'), true);
  assert.equal(control.release('s1', 'boss', 'released'), true);
  assert.equal(control.hasLock('s1'), false);
  assert.equal(control.release('s2', null, 'session deleted'), true, 'anyone\'s lock, for a session deletion');
  assert.deepEqual(released.slice(1), [['s1', 'boss', 'toto', 'released'], ['s2', 'chef', 'titi', 'session deleted']]);
  assert.equal(control.locks.size, 0);
  assert.equal(control.release('s2', null, 'session deleted'), false, 'released once');
});

test('the controlling admin types into, resizes and clears any console of the session; the owner none', () => {
  const lock = {admin: 'boss'};
  for (const action of ['input', 'resize', 'clear']) {
    assert.equal(consoleRefusal({observer: false, lock: null, admin: 'toto', action}), null, action);
    assert.match(consoleRefusal({observer: false, lock, admin: 'toto', action}), /boss controls this session/, action);
    assert.match(consoleRefusal({observer: true, lock: null, admin: 'boss', action}), /Read-only observation/, action);
    assert.match(consoleRefusal({observer: true, lock, admin: 'chef', action}), /Read-only observation/, action);
    assert.equal(consoleRefusal({observer: true, lock, admin: 'boss', action}), null, action);
  }
  assert.match(consoleRefusal({observer: true, lock: null, admin: 'boss', action: 'resize'}), /cannot be resized/);
  assert.match(consoleRefusal({observer: true, lock: null, admin: 'boss', action: 'clear'}), /cannot be cleared/);
  assert.match(consoleRefusal({observer: true, lock: null, admin: 'boss'}), /take control to type/, 'input by default');
});

test('the observation rule (CTL01): one driver at a time for the HTTP writes', () => {
  const base = {method: 'GET', url: '/api/nodes', login: 'boss', role: 'admin', observe: 'toto', found: true, lockAdmin: null, ownLockAdmin: null};
  const rule = change => observationRule({...base, ...change});
  const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'];
  // An observer without the lock reads only.
  assert.deepEqual(rule({}), {observed: true, control: false});
  assert.deepEqual(rule({method: 'HEAD'}), {observed: true, control: false});
  for (const method of WRITES) assert.deepEqual(rule({method}), {status: 403, error: 'Read-only observation: this action is not allowed.'}, method);
  for (const method of WRITES) assert.equal(rule({method, lockAdmin: 'chef'}).status, 403, `${method}: another admin holds the lock`);
  // The admin holding the lock does what the owner can, reads too (marked control).
  assert.deepEqual(rule({lockAdmin: 'boss'}), {observed: true, control: true});
  for (const [method, url] of [['POST', '/api/nodes/h-00000001/start'], ['DELETE', '/api/nodes/h-00000001'], ['PUT', '/api/nodes/h-00000001/config'],
    ['PATCH', '/api/nodes/h-00000001'], ['POST', '/api/session-archive/import'], ['POST', '/api/session-archive/export'],
    ['POST', '/api/examples/load'], ['PUT', '/api/general-settings'], ['POST', '/api/nodes/h-00000001/captures']]) {
    assert.deepEqual(rule({method, url, lockAdmin: 'boss'}), {observed: true, control: true}, `${method} ${url}`);
  }
  // UXS02: with the lock, Reset session too (the confirmation names the owner); never the admin API through an observation.
  assert.deepEqual(rule({method: 'POST', url: '/api/session/reset', lockAdmin: 'boss'}), {observed: true, control: true});
  assert.equal(rule({method: 'POST', url: '/api/session/reset'}).status, 403, 'not without the lock');
  for (const url of ['/api/admin', '/api/admin/sessions/toto/stop']) assert.equal(rule({method: 'POST', url, lockAdmin: 'boss'}).status, 403, url);
  // A student never observes; an unknown login is 404 for a read, 403 for a write.
  assert.equal(rule({role: 'student'}).status, 403);
  assert.equal(rule({role: 'student', lockAdmin: 'boss'}).status, 403);
  assert.deepEqual(rule({found: false}), {status: 404, error: 'toto has no session: they have not used QemuWeb since the server started, or their session was deleted.'});
  assert.equal(rule({found: false, method: 'POST'}).status, 403);
  // The owner (no header, or their own login): free, except every write while an admin controls their session.
  const owner = {login: 'toto', role: 'student', observe: null, found: false};
  assert.deepEqual(rule(owner), {observed: false, control: false});
  for (const method of WRITES) assert.deepEqual(rule({...owner, method}), {observed: false, control: false}, method);
  assert.deepEqual(rule({...owner, ownLockAdmin: 'boss'}), {observed: false, control: false}, 'reads stay allowed');
  for (const method of WRITES) assert.deepEqual(rule({...owner, method, ownLockAdmin: 'boss'}), {status: 403, error: 'boss controls your session.'}, method);
  assert.equal(rule({...owner, method: 'POST', url: '/api/session/reset', ownLockAdmin: 'boss'}).status, 403, 'Reset session too');
  assert.deepEqual(rule({...owner, observe: 'toto', method: 'POST'}), {observed: false, control: false}, 'observing yourself is your own session');
  // An admin's own admin API is not a session write.
  assert.deepEqual(rule({login: 'chef', observe: null, method: 'POST', url: '/api/admin/users', ownLockAdmin: 'boss'}), {observed: false, control: false});
});

test('the observation gate restarts the idle timer of the lock at each request of the controlling admin, and refuses the owner\'s writes', () => {
  const toto = {owner: 'toto', session: {id: 'sess-toto'}};
  const manager = {get: login => (login === 'toto' ? toto : null)};
  const touched = [];
  let holder = 'boss';
  const gate = observationGate(manager, {control: {admin: id => (id === 'sess-toto' ? holder : null), touch: (...args) => touched.push(args)}});
  const pass = (options, status = null) => {
    const req = request(options);
    const res = response();
    assert.equal(run(gate, req, res), status === null, JSON.stringify(options));
    if (status !== null) assert.equal(res.statusCode, status);
    return {req, res};
  };
  const boss = {login: 'boss', role: 'admin'};
  const {req} = pass({user: boss, method: 'POST', path: '/api/nodes/stop-all', headers: {'X-Observe': 'toto'}});
  assert.equal(req.observed, toto);
  assert.equal(req.observedControl, true);
  assert.deepEqual(touched, [['sess-toto', 'boss']]);
  assert.match(pass({user: {login: 'toto', role: 'student'}, method: 'POST', path: '/api/nodes/stop-all'}, 403).res.body.error, /boss controls your session/);
  assert.equal(pass({user: {login: 'toto', role: 'student'}}).req.observed, undefined, 'the owner still reads');
  holder = null;
  pass({user: boss, method: 'POST', path: '/api/nodes/stop-all', headers: {'X-Observe': 'toto'}}, 403);
  assert.equal(touched.length, 1, 'checked at each request: no lock, no write');
  pass({user: {login: 'toto', role: 'student'}, method: 'POST', path: '/api/nodes/stop-all'});
});

test('an observation is audited once per admin and observed login while sockets stay open', () => {
  const lines = [];
  const tracker = createObservationTracker({record: (admin, action, target) => lines.push([admin, action, target.login])});
  for (let i = 0; i < 5; i++) tracker.opened('boss', 'toto');
  assert.deepEqual(lines, [['boss', 'observe', 'toto']], 'one page load opens five sockets');
  tracker.opened('boss', 'titi');
  tracker.opened('chef', 'toto');
  assert.equal(lines.length, 3);
  for (let i = 0; i < 4; i++) assert.equal(tracker.closed('boss', 'toto'), 4 - i, 'remaining sockets');
  tracker.opened('boss', 'toto');
  assert.equal(lines.length, 3, 'still one socket open');
  assert.equal(tracker.closed('boss', 'toto'), 1);
  assert.equal(tracker.closed('boss', 'toto'), 0, 'the last socket closed: control ends here');
  tracker.opened('boss', 'toto');
  assert.deepEqual(lines.at(-1), ['boss', 'observe', 'toto'], 'a new observation after closing every socket');
  assert.equal(lines.length, 4);
});

test('users.log entries carry the user and the event, never anything else', t => {
  const file = path.join(tempDir(t), USERS_LOG);
  const log = createUserLog({file, now: () => new Date('2026-01-02T03:04:05Z')});
  log.record('toto', 'login');
  log.record('toto', 'node-started', {nodeId: 's-89abcdef'}, 'ok');
  log.record('toto', 'node-stopped', {nodeId: 's-89abcdef'}, new Error('busy'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readLogTail(file), [
    {time: '2026-01-02T03:04:05.000Z', user: 'toto', event: 'login'},
    {time: '2026-01-02T03:04:05.000Z', user: 'toto', event: 'node-started', target: {nodeId: 's-89abcdef'}, result: 'ok'},
    {time: '2026-01-02T03:04:05.000Z', user: 'toto', event: 'node-stopped', target: {nodeId: 's-89abcdef'}, result: 'error: busy'}
  ]);
});

test('readLogTail returns the last entries from the end of the file only', t => {
  const dir = tempDir(t);
  assert.deepEqual(readLogTail(path.join(dir, 'missing.log')), []);
  const file = path.join(dir, 'admin.log');
  const lines = Array.from({length: 50}, (_, index) => JSON.stringify({index, padding: 'x'.repeat(40)}));
  fs.writeFileSync(file, `${lines.join('\n')}\nnot json\n\n`);
  assert.deepEqual(readLogTail(file, 3).map(entry => entry.index), [47, 48, 49], 'broken and empty lines are skipped');
  // With a byte limit, the first (cut) line is dropped and only whole lines are returned.
  const tail = readLogTail(file, 200, 500);
  assert.ok(tail.length > 0 && tail.length < 10, String(tail.length));
  assert.equal(tail.at(-1).index, 49);
  assert.deepEqual(tail.map(entry => entry.index), Array.from({length: tail.length}, (_, index) => 50 - tail.length + index));
});

test('only explicit node and archive actions of the owner become users.log events', () => {
  const id = 's-89abcdef';
  const event = (method, url, body) => userEvent({method, path: url, body});
  assert.deepEqual(event('POST', '/api/switches', {id, name: 'sw'}), {event: 'node-created', target: {nodeId: id, kind: 'switch'}});
  assert.deepEqual(event('POST', '/api/hosts', {id: 'not an id; rm -rf /'}), {event: 'node-created', target: {nodeId: null, kind: 'host'}});
  assert.deepEqual(event('POST', `/api/nodes/${id}/start`), {event: 'node-started', target: {nodeId: id}});
  assert.deepEqual(event('POST', `/api/nodes/${id}/stop`), {event: 'node-stopped', target: {nodeId: id}});
  assert.deepEqual(event('DELETE', `/api/nodes/${id}`), {event: 'node-deleted', target: {nodeId: id}});
  assert.deepEqual(event('POST', '/api/session/reset'), {event: 'session-reset', target: {}});
  assert.equal(event('DELETE', '/api/nodes'), null, 'no route removes every node any more: Reset session does');
  assert.deepEqual(event('POST', '/api/nodes/stop-all'), {event: 'node-stopped', target: {all: true}});
  assert.deepEqual(event('POST', '/api/nodes/resume-all'), {event: 'node-started', target: {all: true}});
  assert.deepEqual(event('POST', '/api/topology'), {event: 'archive-loaded', target: {kind: 'topology'}});
  assert.deepEqual(event('GET', '/api/topology'), {event: 'archive-saved', target: {kind: 'topology'}});
  assert.deepEqual(event('POST', '/api/session-archive/import'), {event: 'archive-loaded', target: {kind: 'session'}});
  assert.deepEqual(event('POST', '/api/session-archive/export'), {event: 'archive-saved', target: {kind: 'session'}});
  for (const [method, url] of [['GET', '/api/nodes'], ['GET', '/api/metrics'], ['POST', `/api/nodes/${id}/monitor`], ['PUT', `/api/nodes/${id}/config`],
    ['POST', `/api/nodes/${id}/reboot`], ['GET', '/api/session-archive/estimate'], ['PATCH', `/api/nodes/${id}`]]) {
    assert.equal(event(method, url), null, `${method} ${url}`);
  }
});

test('the login routes write login, login-failed and logout to users.log, never a password', async t => {
  const usersFile = path.join(tempDir(t), 'users.json');
  writeUsers(usersFile, [{login: 'toto', hash: await hashPassword('secret-pw', FAST), role: 'student'}]);
  const lines = [];
  const auth = createAuth({settings: settingsFor(usersFile), userLog: {record: (...args) => lines.push(args)}});
  const routes = {};
  auth.register({post: (route, ...handlers) => { routes[`POST ${route}`] = handlers.at(-1); }, get: (route, ...handlers) => { routes[`GET ${route}`] = handlers.at(-1); }});
  const call = async (route, req) => { const res = response(); res.set = () => res; await routes[route]({secure: false, ...req}, res); return res; };
  assert.equal((await call('POST /auth/login', {body: {login: 'toto', password: 'secret-pw'}})).statusCode, 200);
  assert.equal((await call('POST /auth/login', {body: {login: 'toto', password: 'wrong-pw'}})).statusCode, 401);
  await call('POST /auth/login', {body: {login: `x\n${'y'.repeat(100)}`, password: 'other-pw'}});
  await call('POST /auth/login', {body: {login: 42, password: 'pw'}});
  await call('POST /auth/logout', {user: {login: 'toto', role: 'student'}});
  await call('POST /auth/logout', {});
  assert.deepEqual(lines, [['toto', 'login', {via: 'password'}], ['toto', 'login-failed'], [`x${'y'.repeat(63)}`, 'login-failed'], ['', 'login-failed'], ['toto', 'logout', {via: 'password'}]]);
  assert.doesNotMatch(JSON.stringify(lines), /pw/);
});

test('a view state is normalized: known keys, layouts, lengths and ranges; unknown nodes become null', () => {
  const sw = 's-89abcdef', host = 'h-89abcdef';
  const nodes = new Map([[sw, {}], [host, {}]]);
  assert.deepEqual([paneCount('single'), paneCount('columns-2'), paneCount('rows-2'), paneCount('grid-4'), paneCount('grid-9'), paneCount('toString')],
    [1, 2, 2, 4, 0, 0]);
  const view = {mode: 'graphic', layout: 'grid-4', panes: [host, null, sw, null], views: ['monitor', 'console', 'console2', 'console'], switches: false, active: sw, floating: true, geometry: {left: 0.5, top: 0.25, width: 0.4, height: 0.5},
    viewport: {cx: 120.5, cy: -40, k: 1.25}, linkStyle: 'rectilinear'};
  assert.deepEqual(normalizeView({...view, page: 2, expanded: 1, extra: 1}, nodes), view, 'extra keys (page, a former expanded) are dropped');
  assert.deepEqual(normalizeView(view, [sw, host]), view, 'node IDs as an array');
  assert.deepEqual(normalizeView({...view, panes: ['h-00000000', sw, sw, host], active: 'h-00000000'}, nodes),
    {...view, panes: [null, sw, null, host], views: ['console', 'console', 'console', 'console'], active: null, floating: false},
    'unknown nodes become null (their pane shows the console), a node is kept in its first pane');
  assert.deepEqual(normalizeView({...view, panes: ['x', null, null, null]}, null).panes, ['x', null, null, null], 'shape check only');
  for (const [layout, panes] of [['single', [sw]], ['columns-2', [sw, host]], ['rows-2', [null, null]]]) {
    assert.deepEqual(normalizeView({...view, layout, panes, views: panes.map(() => 'console')}, nodes).panes, panes);
  }
  const invalid = [null, undefined, 'x', 42, [], [view], {...view, mode: 'list'}, {...view, mode: undefined},
    {...view, layout: 4}, {...view, layout: 'grid-9'}, {...view, layout: 'toString'}, {...view, layout: '__proto__'},
    {...view, panes: undefined}, {...view, panes: 'sw'}, {...view, panes: [sw]}, {...view, panes: [sw, null, null, 7]},
    {...view, views: undefined}, {...view, views: ['console']}, {...view, views: ['console', 'console', 'console', 'console', 'console']},
    {...view, views: ['console', 'console', 'console', 'tty']}, {...view, views: ['console', 'console', 'console', null]}, {...view, views: 'console'},
    {...view, layout: 'columns-2'}, {...view, layout: 'single'}, {...view, layout: 'rows-2', panes: [null]},
    {...view, switches: 1}, {...view, switches: undefined}, {...view, active: 7}, {...view, active: undefined},
    {...view, floating: 1}, {...view, floating: 'true'}, {...view, floating: undefined},
    {...view, geometry: undefined}, {...view, geometry: 'x'}, {...view, geometry: []}, {...view, geometry: {left: 0, top: 0, width: 1}},
    {...view, geometry: {left: 0, top: 0, width: 1, height: 1, extra: 1}}, {...view, geometry: {left: '0', top: 0, width: 1, height: 1}},
    {...view, geometry: {left: NaN, top: 0, width: 1, height: 1}}, {...view, geometry: {left: 0, top: Infinity, width: 1, height: 1}},
    {...view, viewport: undefined}, {...view, viewport: 'x'}, {...view, viewport: {cx: 0, cy: 0}}, {...view, viewport: {cx: 0, cy: 0, k: 1, x: 0}},
    {...view, viewport: {cx: NaN, cy: 0, k: 1}}, {...view, viewport: {cx: 0, cy: 100001, k: 1}}, {...view, viewport: {cx: 0, cy: 0, k: 0}},
    {...view, linkStyle: undefined}, {...view, linkStyle: 'straight'}, {...view, linkStyle: 1}, {...view, linkStyle: null}];
  for (const raw of invalid) assert.equal(normalizeView(raw, nodes), null, JSON.stringify(raw));
});

test('the view of an empty pane or of a node dropped by normalisation is console', () => {
  const host = 'h-89abcdef';
  const view = {mode: 'terminals', layout: 'columns-2', panes: [host, null], views: ['log', 'monitor'], switches: true, active: host, floating: false, geometry: null, viewport: null, linkStyle: 'curved'};
  assert.deepEqual(normalizeView(view, [host]).views, ['log', 'console'], 'null pane');
  assert.deepEqual(normalizeView({...view, panes: ['h-00000000', null]}, [host]).views, ['console', 'console'], 'unknown node');
  assert.deepEqual(normalizeView({...view, panes: [host, host]}, [host]).views, ['log', 'console'], 'node shown twice');
});

test('the floating console is part of the view in both modes (open when the Graphic view shows), on an active node shown in a pane', () => {
  const sw = 's-89abcdef', host = 'h-89abcdef';
  const view = {mode: 'graphic', layout: 'columns-2', panes: [host, sw], views: ['console', 'console'], switches: true, active: sw, floating: true, geometry: null, viewport: null, linkStyle: 'curved'};
  assert.equal(normalizeView(view, [sw, host]).floating, true, 'open on the active node');
  assert.equal(normalizeView({...view, floating: false}, [sw, host]).floating, false, 'closed');
  assert.equal(normalizeView({...view, mode: 'terminals'}, [sw, host]).floating, true, 'kept in the Terminals view: shown again with the Graphic view');
  assert.equal(normalizeView({...view, active: null}, [sw, host]).floating, false, 'no active node');
  assert.equal(normalizeView(view, [host]).floating, false, 'the active node is unknown here');
  assert.equal(normalizeView({...view, panes: [host, null]}, [sw, host]).floating, false, 'the active node is in no pane');
  assert.equal(normalizeView(view, null).floating, true, 'shape check only');
  assert.equal(sameView(normalizeView(view, null), normalizeView({...view, floating: false}, null)), false, 'a change of the floating console is a change of the view');
});

test('the floating console geometry: fractions of the Graphic view, clamped and rounded, no other field', () => {
  assert.equal(normalizeGeometry(null), null, 'not placed yet: the default geometry');
  assert.deepEqual(normalizeGeometry({left: 0.123456, top: 0.5, width: 0.3, height: 0.25}), {left: 0.1235, top: 0.5, width: 0.3, height: 0.25});
  assert.deepEqual(normalizeGeometry({height: 7, width: -1, top: -3, left: 2}), {left: 1, top: 0, width: 0.05, height: 1}, 'clamped to the ranges');
  for (const raw of [undefined, 0, 'x', [], {}, {left: 0, top: 0, width: 1}, {left: 0, top: 0, width: 1, height: 1, z: 0},
    {left: null, top: 0, width: 1, height: 1}, {left: 0, top: 0, width: 1, height: NaN}, {left: 0, top: 0, width: -Infinity, height: 1}]) {
    assert.equal(normalizeGeometry(raw), undefined, JSON.stringify(raw));
  }
  const view = {mode: 'graphic', layout: 'single', panes: ['a'], views: ['console'], switches: true, active: 'a', floating: true, geometry: {left: 0.1, top: 0.2, width: 0.5, height: 0.5}, viewport: null, linkStyle: 'curved'};
  assert.equal(sameView(view, {...view, geometry: {...view.geometry}}), true);
  assert.equal(sameView(view, {...view, geometry: {...view.geometry, left: 0.2}}), false, 'a move is a change of the view');
  assert.equal(sameView(view, {...view, geometry: null}), false);
  assert.equal(sameView({...view, geometry: null}, {...view, geometry: null}), true);
});

test('CTL03: the Graphic view\'s viewport: the world point at the canvas center and the zoom, bounded and rounded', () => {
  assert.equal(normalizeViewport(null), null, 'not shown yet: each page fits the drawing');
  assert.deepEqual(normalizeViewport({cx: 12.345, cy: -0.04, k: 1.234567}), {cx: 12.3, cy: 0, k: 1.2346});
  assert.deepEqual(normalizeViewport({k: 9, cy: 100000, cx: -100000}), {cx: -100000, cy: 100000, k: 3}, 'the zoom clamped to [0.2, 3]');
  assert.equal(normalizeViewport({cx: 0, cy: 0, k: 0.01}).k, 0.2);
  for (const raw of [undefined, 0, 'x', [], {}, {cx: 0, cy: 0}, {cx: 0, cy: 0, k: 1, z: 0}, {cx: '0', cy: 0, k: 1}, {cx: 0, cy: Infinity, k: 1},
    {cx: 100000.5, cy: 0, k: 1}, {cx: 0, cy: 0, k: 0}, {cx: 0, cy: 0, k: -1}, {cx: 0, cy: 0, k: NaN}]) {
    assert.equal(normalizeViewport(raw), undefined, JSON.stringify(raw));
  }
  const view = {mode: 'graphic', layout: 'single', panes: ['a'], views: ['console'], switches: true, active: 'a', floating: false, geometry: null, viewport: {cx: 1, cy: 2, k: 1}, linkStyle: 'curved'};
  assert.equal(sameView(view, {...view, viewport: {cx: 1, cy: 2, k: 1}}), true);
  assert.equal(sameView(view, {...view, viewport: {cx: 1, cy: 2, k: 1.5}}), false, 'a zoom is a change of the view');
  assert.equal(sameView(view, {...view, viewport: null}), false);
});

test('the geometry in pixels follows the Graphic view of each browser and stays inside its viewport', () => {
  const geometry = {left: 0.5, top: 0.25, width: 0.4, height: 0.5};
  const big = {left: 0, top: 100, width: 2000, height: 1000};
  assert.deepEqual(geometryPixels(geometry, big, {width: 2000, height: 1100}), {left: 1000, top: 350, width: 800, height: 500});
  const small = {left: 0, top: 140, width: 1000, height: 600};
  assert.deepEqual(geometryPixels(geometry, small, {width: 1000, height: 740}), {left: 500, top: 290, width: 400, height: 300}, 'the same place, relatively');
  assert.deepEqual(geometryPixels({left: 1, top: 1, width: 0.05, height: 0.05}, small, {width: 1000, height: 740}), {left: 700, top: 540, width: 300, height: 200},
    'at least the minimum size, and pushed back inside the viewport');
  assert.deepEqual(geometryPixels({left: 0, top: 0, width: 1, height: 1}, {left: 0, top: 0, width: 500, height: 400}, {width: 320, height: 240}),
    {left: 0, top: 0, width: 312, height: 232}, 'never larger than the viewport (a phone)');
  assert.deepEqual(geometryFraction({left: 1000, top: 350, width: 800, height: 500}, big), geometry, 'back to fractions');
  assert.deepEqual(geometryFraction({left: -50, top: 0, width: 4000, height: 500}, big), {left: 0, top: 0, width: 1, height: 0.5}, 'clamped');
  assert.equal(geometryFraction({left: 0, top: 0, width: 10, height: 10}, {left: 0, top: 0, width: 0, height: 0}), null, 'a hidden Graphic view has no size');
});

test('session-observers: the observing administrators\' logins, sorted, once each; anything else is invalid', () => {
  assert.deepEqual(normalizeObservers({admins: []}), []);
  assert.deepEqual(normalizeObservers({admins: ['root', 'boss', 'root']}), ['boss', 'root']);
  for (const raw of [null, undefined, 'boss', [], {}, {admins: 'boss'}, {admins: [1]}, {admins: ['']}, {admins: ['x'.repeat(65)]},
    {admins: Array.from({length: 33}, (_, index) => `a${index}`)}, {admins: ['boss'], extra: 1}]) {
    assert.equal(normalizeObservers(raw), null, JSON.stringify(raw));
  }
});

test('the observation tracker lists who observes a login, and says when an observation starts', () => {
  const tracker = createObservationTracker({record: () => {}});
  assert.equal(tracker.opened('root', 'toto'), true, 'first socket: the observation starts');
  assert.equal(tracker.opened('root', 'toto'), false);
  assert.equal(tracker.opened('boss', 'toto'), true);
  tracker.opened('boss', 'titi');
  assert.deepEqual(tracker.admins('toto'), ['boss', 'root']);
  assert.deepEqual(tracker.admins('titi'), ['boss']);
  assert.deepEqual(tracker.admins('nobody'), []);
  tracker.closed('root', 'toto');
  assert.deepEqual(tracker.admins('toto'), ['boss', 'root'], 'one socket of root left');
  tracker.closed('root', 'toto');
  assert.deepEqual(tracker.admins('toto'), ['boss']);
});

test('one driver at a time: which received view a page follows', () => {
  const observer = {observing: true, holding: false, taking: false, followChecked: true, controlled: false};
  assert.equal(followsView('owner', observer), true, 'an observer with Follow follows the owner');
  assert.equal(followsView('owner', {...observer, followChecked: false}), false, 'Follow unchecked');
  assert.equal(followsView('owner', {...observer, holding: true, controlled: true}), false, 'holding control: the admin drives');
  assert.equal(followsView('owner', {...observer, taking: true}), false, 'a take-control request is pending');
  assert.equal(followsView('owner', {...observer, controlled: true}), true, 'another admin controls: still follows the owner\'s published view');
  assert.equal(followsView('controller', {...observer, holding: true, controlled: true}), false, 'an observer never follows a controller view');
  const owner = {observing: false, holding: false, taking: false, followChecked: false, controlled: true};
  assert.equal(followsView('controller', owner), true, 'the owner\'s page under control follows the admin');
  assert.equal(followsView('controller', {...owner, controlled: false}), false, 'no control: the owner drives');
  assert.equal(followsView('owner', owner), false, 'the owner never follows itself');
  assert.equal(followsView('other', owner), false);
});

test('CTL04: the link style is part of the view state; a followed style is shown, never saved as the preference', () => {
  const {LINK_STYLES} = require('../../public/view-state');
  assert.deepEqual(LINK_STYLES, ['curved', 'rectilinear']);
  const view = {mode: 'graphic', layout: 'single', panes: ['a'], views: ['console'], switches: true, active: 'a', floating: false, geometry: null, viewport: null, linkStyle: 'rectilinear'};
  assert.equal(normalizeView(view, null).linkStyle, 'rectilinear');
  const {linkStyle, ...withoutStyle} = view;
  assert.equal(linkStyle, 'rectilinear');
  assert.equal(normalizeView(withoutStyle, null), null, 'required: a view saved without it is dropped');
  assert.equal(sameView(normalizeView(view, null), normalizeView({...view, linkStyle: 'curved'}, null)), false, 'a change of the link style is a change of the view');
  assert.deepEqual([normalizeLinkStyle('rectilinear'), normalizeLinkStyle('curved'), normalizeLinkStyle(null), normalizeLinkStyle('x')],
    ['rectilinear', 'curved', 'curved', 'curved'], 'the browser preference, curved by default');
  assert.deepEqual(linkStyleChange({shown: 'curved', saved: 'curved'}, 'rectilinear', {own: true}), {shown: 'rectilinear', saved: 'rectilinear'},
    'a choice made on the page is saved');
  assert.deepEqual(linkStyleChange({shown: 'curved', saved: 'curved'}, 'rectilinear', {own: false}), {shown: 'rectilinear', saved: 'curved'},
    'a followed style is shown, the preference stays');
  assert.deepEqual(linkStyleChange({shown: 'rectilinear', saved: 'curved'}, 'curved', {own: false}), {shown: 'curved', saved: 'curved'});
});

test('two view states are compared field by field', () => {
  const view = {mode: 'terminals', layout: 'columns-2', panes: ['a', null], views: ['console', 'console'], switches: true, active: 'a', floating: false, geometry: null, viewport: null, linkStyle: 'curved'};
  assert.equal(sameView(view, {...view, panes: ['a', null], views: ['console', 'console']}), true);
  assert.equal(sameView(view, {...view, views: ['console2', 'console']}), false);
  for (const change of [{mode: 'graphic'}, {layout: 'rows-2'}, {panes: [null, 'a']}, {switches: false}, {active: null}, {floating: true}, {geometry: {left: 0, top: 0, width: 1, height: 1}},
    {viewport: {cx: 0, cy: 0, k: 1}}, {linkStyle: 'rectilinear'}]) {
    assert.equal(sameView(view, {...view, ...change}), false, JSON.stringify(change));
  }
  assert.equal(sameView(view, null), false);
});

test('ADM03: the Runner column of the Sessions tab: name and ID, "local", "not placed"', async () => {
  const {sessionRunnerLabel} = await import('../../public/admin-sessions.js');
  assert.equal(sessionRunnerLabel({placed: true, runnerId: 'r-1a2b3c4d', runnerName: 'salle-12'}).text, 'salle-12 (r-1a2b3c4d)');
  assert.equal(sessionRunnerLabel({placed: true, runnerId: 'r-1a2b3c4d', runnerName: 'r-1a2b3c4d'}).text, 'r-1a2b3c4d', 'a runner named after its ID');
  assert.equal(sessionRunnerLabel({placed: true, runnerId: 'local', runnerName: 'local'}).text, 'local');
  const unplaced = sessionRunnerLabel({placed: false, runnerId: null, runnerName: null});
  assert.equal(unplaced.text, 'not placed');
  assert.match(unplaced.title, /no runner/);
  // The page shows the session ID and the Runner column in each row of the Sessions table.
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'admin.html'), 'utf8');
  assert.match(html, /<th>User<\/th><th[^>]*>Session<\/th><th[^>]*>State<\/th><th[^>]*>Runner<\/th><th>Created<\/th>/);
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'admin.js'), 'utf8');
  assert.match(page, /textContent: session\.sessionId/);
  assert.match(page, /sessionRunnerLabel\(session\)/);
});
