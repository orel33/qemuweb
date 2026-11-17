// Admin role unit tests: disabled accounts, shared account operations, admin.log and users.log, session
// activity, requireAdmin, the observation gate, the session summary, console control and the
// observer input rules. No server is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {spawnSync} = require('node:child_process');
const {hashPassword, verifyPassword} = require('../../lib/auth/passwords');
const {readUsers, writeUsers, parseUsers, createAccount, setPassword, setRole, setDisabled} = require('../../lib/auth/users-store');
const {COOKIE_NAME, newSecret, signSession} = require('../../lib/auth/cookie');
const {createAuth} = require('../../lib/auth');
const {ADMIN_LOG, USERS_LOG, logDirPath, createLogDir, createAudit, createUserLog, readLogTail} = require('../../lib/audit');
const {userEvent} = require('../../routes');
const {Session} = require('../../lib/session');
const {ConsoleControl, CONTROL_IDLE_MS} = require('../../lib/console-control');
const {observationGate, sessionSummary} = require('../../routes/admin');
const {inputRefusal, createObservationTracker} = require('../../sockets');
const {paneCount, normalizeView, sameView} = require('../../public/view-state');

const root = path.join(__dirname, '..', '..');
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
  const auth = createAuth({root, env: {QEMUWEB_USERS_FILE: usersFile}, now: () => clock, secret});
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

test('requireAdmin answers 403 to anyone but an admin; QEMUWEB_AUTH=off is admin', t => {
  const auth = createAuth({root, env: {QEMUWEB_USERS_FILE: path.join(tempDir(t), 'users.json')}});
  for (const user of [undefined, {login: 'toto', role: 'student'}]) {
    const res = response();
    assert.equal(run(auth.requireAdmin, request({user}), res), false);
    assert.equal(res.statusCode, 403);
  }
  assert.equal(run(auth.requireAdmin, request({user: {login: 'boss', role: 'admin'}}), response()), true);
  const off = createAuth({root, env: {QEMUWEB_AUTH: 'off', QEMUWEB_USERS_FILE: path.join(tempDir(t), 'users.json')}});
  const req = request();
  run(off.identify, req, response());
  assert.equal(run(off.requireAdmin, req, response()), true);
  assert.deepEqual(off.currentUser('local'), {login: 'local', role: 'admin'});
});

test('scripts/user.js disables and enables accounts and lists their state', async t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'users.json');
  writeUsers(file, [{login: 'toto', hash: await hashPassword('toto', FAST), role: 'student'}]);
  const script = args => spawnSync(process.execPath, [path.join(root, 'scripts', 'user.js'), ...args],
    {env: {...process.env, QEMUWEB_USERS_FILE: file}, input: '', encoding: 'utf8'});
  assert.equal(script(['disable', 'toto']).status, 0);
  assert.equal(readUsers(file)[0].disabled, true);
  assert.equal(script(['list']).stdout, 'toto\tstudent\tdisabled\n');
  assert.equal(script(['enable', 'toto']).status, 0);
  assert.equal(script(['list']).stdout, 'toto\tstudent\n');
  assert.equal(script(['disable', 'nobody']).status, 1);
  assert.equal(script(['disable']).status, 2);
});

test('admin.log appends one JSON line per action, mode 0600, in logs/ or QEMUWEB_LOG_DIR', t => {
  assert.equal(logDirPath('/srv/qemuweb', {}), '/srv/qemuweb/logs');
  assert.equal(logDirPath('/srv/qemuweb', {QEMUWEB_LOG_DIR: '/var/log/qemuweb'}), '/var/log/qemuweb');
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
  const workspace = {owner: 'toto'};
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
  const summary = await sessionSummary({owner: 'toto', session, runner}, 'boss', 2);
  assert.deepEqual(summary, {login: 'toto', own: false, browsers: 2, sessionId: session.id, createdAt: '2026-01-01T00:00:00.000Z',
    lastActivity: '2026-01-01T00:00:00.000Z', nodes: 4, hosts: 3, switches: 1, runningHosts: 2, runningSwitches: 1,
    reservedRamMb: 1536, cpuPercent: 12.5, active: true});
  assert.equal((await sessionSummary({owner: 'boss', session, runner}, 'boss')).own, true);
  assert.equal((await sessionSummary({owner: 'boss', session, runner}, 'boss')).browsers, 0);
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

test('the controlling admin types into any console of the session; the owner into none', () => {
  const lock = {admin: 'boss'};
  assert.equal(inputRefusal({observer: false, lock: null, admin: 'toto'}), null);
  assert.match(inputRefusal({observer: false, lock, admin: 'toto'}), /boss controls this session/);
  assert.match(inputRefusal({observer: true, lock: null, admin: 'boss'}), /Read-only observation/);
  assert.match(inputRefusal({observer: true, lock, admin: 'chef'}), /Read-only observation/);
  assert.equal(inputRefusal({observer: true, lock, admin: 'boss'}), null);
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
  log.record('toto', 'node-started', {nodeId: 's-0123456789abcdef'}, 'ok');
  log.record('toto', 'node-stopped', {nodeId: 's-0123456789abcdef'}, new Error('busy'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readLogTail(file), [
    {time: '2026-01-02T03:04:05.000Z', user: 'toto', event: 'login'},
    {time: '2026-01-02T03:04:05.000Z', user: 'toto', event: 'node-started', target: {nodeId: 's-0123456789abcdef'}, result: 'ok'},
    {time: '2026-01-02T03:04:05.000Z', user: 'toto', event: 'node-stopped', target: {nodeId: 's-0123456789abcdef'}, result: 'error: busy'}
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
  const id = 's-0123456789abcdef';
  const event = (method, url, body) => userEvent({method, path: url, body});
  assert.deepEqual(event('POST', '/api/switches', {id, name: 'sw'}), {event: 'node-created', target: {nodeId: id, kind: 'switch'}});
  assert.deepEqual(event('POST', '/api/hosts', {id: 'not an id; rm -rf /'}), {event: 'node-created', target: {nodeId: null, kind: 'host'}});
  assert.deepEqual(event('POST', `/api/nodes/${id}/start`), {event: 'node-started', target: {nodeId: id}});
  assert.deepEqual(event('POST', `/api/nodes/${id}/stop`), {event: 'node-stopped', target: {nodeId: id}});
  assert.deepEqual(event('DELETE', `/api/nodes/${id}`), {event: 'node-deleted', target: {nodeId: id}});
  assert.deepEqual(event('DELETE', '/api/nodes'), {event: 'node-deleted', target: {all: true}});
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
  const auth = createAuth({root, env: {QEMUWEB_USERS_FILE: usersFile}, userLog: {record: (...args) => lines.push(args)}});
  const routes = {};
  auth.register({post: (route, ...handlers) => { routes[`POST ${route}`] = handlers.at(-1); }, get: (route, ...handlers) => { routes[`GET ${route}`] = handlers.at(-1); }});
  const call = async (route, req) => { const res = response(); res.set = () => res; await routes[route]({secure: false, ...req}, res); return res; };
  assert.equal((await call('POST /auth/login', {body: {login: 'toto', password: 'secret-pw'}})).statusCode, 200);
  assert.equal((await call('POST /auth/login', {body: {login: 'toto', password: 'wrong-pw'}})).statusCode, 401);
  await call('POST /auth/login', {body: {login: `x\n${'y'.repeat(100)}`, password: 'other-pw'}});
  await call('POST /auth/login', {body: {login: 42, password: 'pw'}});
  await call('POST /auth/logout', {user: {login: 'toto', role: 'student'}});
  await call('POST /auth/logout', {});
  assert.deepEqual(lines, [['toto', 'login'], ['toto', 'login-failed'], [`x${'y'.repeat(63)}`, 'login-failed'], ['', 'login-failed'], ['toto', 'logout']]);
  assert.doesNotMatch(JSON.stringify(lines), /pw/);
});

test('a view state is normalized: known keys, layouts, lengths and ranges; unknown nodes become null', () => {
  const sw = 's-0123456789abcdef', host = 'h-0123456789abcdef';
  const nodes = new Map([[sw, {}], [host, {}]]);
  assert.deepEqual([paneCount('single'), paneCount('columns-2'), paneCount('rows-2'), paneCount('grid-4'), paneCount('grid-9'), paneCount('toString')],
    [1, 2, 2, 4, 0, 0]);
  const view = {mode: 'graphic', layout: 'grid-4', panes: [host, null, sw, null], switches: false, active: sw};
  assert.deepEqual(normalizeView({...view, page: 2, expanded: 1, extra: 1}, nodes), view, 'extra keys (page, a former expanded) are dropped');
  assert.deepEqual(normalizeView(view, [sw, host]), view, 'node IDs as an array');
  assert.deepEqual(normalizeView({...view, panes: ['h-0000000000000000', sw, sw, host], active: 'h-0000000000000000'}, nodes),
    {...view, panes: [null, sw, null, host], active: null}, 'unknown nodes become null, a node is kept in its first pane');
  assert.deepEqual(normalizeView({...view, panes: ['x', null, null, null]}, null).panes, ['x', null, null, null], 'shape check only');
  for (const [layout, panes] of [['single', [sw]], ['columns-2', [sw, host]], ['rows-2', [null, null]]]) {
    assert.deepEqual(normalizeView({...view, layout, panes}, nodes).panes, panes);
  }
  const invalid = [null, undefined, 'x', 42, [], [view], {...view, mode: 'list'}, {...view, mode: undefined},
    {...view, layout: 4}, {...view, layout: 'grid-9'}, {...view, layout: 'toString'}, {...view, layout: '__proto__'},
    {...view, panes: undefined}, {...view, panes: 'sw'}, {...view, panes: [sw]}, {...view, panes: [sw, null, null, 7]},
    {...view, layout: 'columns-2'}, {...view, layout: 'single'}, {...view, layout: 'rows-2', panes: [null]},
    {...view, switches: 1}, {...view, switches: undefined}, {...view, active: 7}, {...view, active: undefined}];
  for (const raw of invalid) assert.equal(normalizeView(raw, nodes), null, JSON.stringify(raw));
});

test('two view states are compared field by field', () => {
  const view = {mode: 'terminals', layout: 'columns-2', panes: ['a', null], switches: true, active: 'a'};
  assert.equal(sameView(view, {...view, panes: ['a', null]}), true);
  for (const change of [{mode: 'graphic'}, {layout: 'rows-2'}, {panes: [null, 'a']}, {switches: false}, {active: null}]) {
    assert.equal(sameView(view, {...view, ...change}), false, JSON.stringify(change));
  }
  assert.equal(sameView(view, null), false);
});
