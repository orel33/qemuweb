'use strict';

// Admin role: the /api/admin gate, the session list, read-only observation of a student's
// switch console, exclusive console control, stop-all, bulk deletion (processes and runtime
// directories freed), account management with disabled accounts, and the admin log (logs/admin.log).
// Uses VDE switches only: no system image or KVM is needed. Everything goes through real
// logins (test/integration/qemuweb-client.js); the server has no test backdoor.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {createTestUsers, spawnServer, QemuWebClient} = require('./qemuweb-client');
const {setDisabled} = require('../../lib/auth/users-store');

const root = path.join(__dirname, '..', '..');
const newId = kind => `${kind === 'switch' ? 's' : 'h'}-${crypto.randomBytes(8).toString('hex')}`;
let child;
let testUsers;
let serverOutput = '';
const sockets = [];
process.on('exit', () => testUsers?.cleanup());

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const {port} = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(label, condition, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    if (child?.exitCode !== null) throw new Error(`QemuWeb exited while waiting for ${label}.`);
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

// A Socket.IO client that records every event it receives.
function recorder(client, label, options = {}) {
  const socket = client.socket(options);
  const events = [];
  socket.onAny((event, ...args) => events.push({event, payload: args[0]}));
  socket.on('disconnect', reason => events.push({event: 'disconnect', payload: reason}));
  sockets.push(socket);
  const connected = new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', error => reject(new Error(`${label}: ${error.message}`)));
  });
  return {socket, events, connected, label,
    output: () => events.filter(item => item.event === 'serial').map(item => item.payload.data).join(''),
    count: name => events.filter(item => item.event === name).length};
}

function emitAck(socket, event, ...args) {
  return new Promise(resolve => socket.emit(event, ...args, resolve));
}

function select(socket, nodeId) { return emitAck(socket, 'select-node', nodeId, `t-${nodeId}`); }

async function expectStatus(client, route, method, status, {body, headers} = {}) {
  const response = await client.fetch(route, {method, body, headers});
  assert.equal(response.status, status, `${client.login} ${method} ${route} returned ${response.status}, expected ${status}`);
  return response;
}

// PIDs whose command line mentions the session's runtime directory (vde_switch, vdeterm).
function sessionProcesses(sessionId) {
  const dir = path.join(root, 'runtime', 'sessions', sessionId);
  const pids = [];
  for (const name of fs.readdirSync('/proc').filter(entry => /^\d+$/.test(entry))) {
    try {
      const commandLine = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').replaceAll('\0', ' ');
      if (commandLine.includes(dir)) pids.push(Number(name));
    } catch (_) { /* The process exited. */ }
  }
  return pids;
}

async function run() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  testUsers = await createTestUsers([{login: 'boss', role: 'admin'}, {login: 'alice'}, {login: 'bob'}, {login: 'carol'}, {login: 'dave'}]);
  // A log directory the server must create itself, inside the temporary users directory.
  const logDir = path.join(path.dirname(testUsers.file), 'logs');
  const auditFile = path.join(logDir, 'admin.log');
  child = spawnServer({port, usersFile: testUsers.file, env: {QEMUWEB_LOG_DIR: logDir}});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { serverOutput = (serverOutput + data).slice(-12000); });
  const account = Object.fromEntries(testUsers.users.map(user => [user.login, user]));
  const signIn = login => new QemuWebClient(baseUrl).signIn(login, account[login].password);

  await new QemuWebClient(baseUrl).waitForServer(30000, () => child.exitCode === null);
  const boss = await signIn('boss');
  const alice = await signIn('alice');
  const bob = await signIn('bob');

  // (1) Every route under /api/admin answers 403 to a student, even an invented one.
  const adminRoutes = [['GET', '/sessions'], ['GET', '/sessions/inactive?hours=1'], ['POST', '/sessions/delete', {logins: ['bob']}],
    ['POST', '/sessions/bob/stop'], ['DELETE', '/sessions/bob'], ['GET', '/users'], ['POST', '/users', {login: 'x', password: 'x'}],
    ['POST', '/users/bob/password', {password: 'x'}], ['PATCH', '/users/bob', {disabled: true}], ['GET', '/invented/path'], ['GET', '/logs/admin'], ['GET', '/logs/users/download'], ['DELETE', '/users/bob'],
    ['DELETE', '/invented']];
  for (const [method, route, body] of adminRoutes) await expectStatus(alice, `/api/admin${route}`, method, 403, {body});
  await expectStatus(alice, '/admin', 'GET', 403);
  await expectStatus(boss, '/admin', 'GET', 200);
  await expectStatus(boss, '/api/admin/invented/path', 'GET', 404);
  await expectStatus(alice, '/api/nodes', 'GET', 403, {headers: {'x-observe': 'bob'}});
  console.log('Admin: every /api/admin route and /admin answer 403 to a student');

  // (2) The admin lists the sessions; admin calls never open a session for the admin.
  const aliceSwitch = newId('switch'), bobSwitch = newId('switch');
  await alice.request('/api/switches', {method: 'POST', body: {id: aliceSwitch, name: 'alicesw', autostart: true}});
  await bob.request('/api/switches', {method: 'POST', body: {id: bobSwitch, name: 'bobsw', autostart: true}});
  let sessions = await boss.request('/api/admin/sessions');
  assert.deepEqual(sessions.map(session => session.login), ['alice', 'bob'], 'an admin call opened a session for the admin');
  const aliceRow = sessions.find(session => session.login === 'alice');
  assert.equal(aliceRow.switches, 1);
  assert.equal(aliceRow.runningSwitches, 1);
  assert.equal(aliceRow.active, true);
  assert.equal(aliceRow.browsers, 0, 'a session is not a connection');
  assert.ok(Date.parse(aliceRow.lastActivity) >= Date.parse(aliceRow.createdAt));
  const bossSettings = await boss.request('/api/general-settings');
  sessions = await boss.request('/api/admin/sessions');
  assert.deepEqual(sessions.map(session => [session.login, session.own]), [['alice', false], ['bob', false], ['boss', true]]);
  console.log('Admin: the session list shows every session, the admin\'s own marked');

  // (3) Observation: read-only HTTP, then a live, read-only switch console.
  const aliceSettings = await alice.request('/api/general-settings');
  const bobSettings = await bob.request('/api/general-settings');
  const observeAlice = {headers: {'x-observe': 'alice'}};
  assert.deepEqual((await boss.request('/api/nodes', observeAlice)).map(node => node.id), [aliceSwitch]);
  assert.equal((await boss.request('/api/general-settings', observeAlice)).sessionId, aliceSettings.sessionId);
  await expectStatus(boss, '/api/nodes', 'GET', 404, {headers: {'x-observe': 'nobody'}});
  await expectStatus(boss, `/api/nodes/${aliceSwitch}/stop`, 'POST', 403, observeAlice);
  await expectStatus(boss, `/api/nodes/${aliceSwitch}`, 'DELETE', 403, observeAlice);
  await expectStatus(boss, '/api/session', 'DELETE', 403, observeAlice);
  await expectStatus(boss, '/api/switches', 'POST', 403, {...observeAlice, body: {id: newId('switch'), name: 'intruder'}});
  assert.equal((await alice.request('/api/nodes'))[0].running, true, 'a refused request changed alice\'s switch');
  assert.equal((await boss.request('/api/general-settings')).sessionId, bossSettings.sessionId, 'the admin\'s own session changed');
  const lastActivity = (await boss.request('/api/admin/sessions')).find(session => session.login === 'alice').lastActivity;
  await boss.request('/api/nodes', observeAlice);
  assert.equal((await boss.request('/api/admin/sessions')).find(session => session.login === 'alice').lastActivity, lastActivity,
    'observation counted as activity');

  const studentProbe = recorder(bob, 'bob observing', {auth: {observe: 'alice'}});
  await studentProbe.connected;
  await waitFor('refusal of a student observer', () => studentProbe.events.some(item => item.event === 'disconnect'));
  assert.ok(studentProbe.events.some(item => item.event === 'node-error' && /Administrator role required/.test(item.payload)));

  // Like a browser tab: one main session socket and console sockets.
  const aliceSession = recorder(alice, 'alice session', {auth: {main: true}});
  const aliceConsole = recorder(alice, 'alice console');
  const observer = recorder(boss, 'boss observer', {auth: {main: true, observe: 'alice'}});
  await Promise.all([aliceSession.connected, aliceConsole.connected, observer.connected]);
  // Connected browser tabs: alice's main socket only (console sockets and observers do not count).
  assert.equal((await boss.request('/api/admin/sessions')).find(session => session.login === 'alice').browsers, 1);
  assert.deepEqual(Object.keys((await boss.request('/api/admin/users'))[0]).sort(), ['disabled', 'login', 'role']);
  assert.deepEqual(await select(observer.socket, aliceSwitch), {ok: true});
  const snapshot = observer.events.find(item => item.event === 'node-snapshot');
  assert.equal(snapshot.payload.nodeId, aliceSwitch);
  assert.equal(snapshot.payload.control, null);
  // Follow: only what the owner's page publishes (owner-view) is relayed; a console socket
  // attaching in the background (select-node) moves nobody.
  assert.deepEqual(await select(aliceConsole.socket, aliceSwitch), {ok: true});
  const ownerView = view => ({nodeId: aliceSwitch, mode: 'terminals', layout: 2, switches: true, page: 0, expanded: null, ...view});
  aliceSession.socket.emit('owner-view', {...ownerView({mode: 'graphic', layout: 4}), extra: 'dropped'});
  await waitFor('owner-view event', () => observer.events.some(item => item.event === 'owner-view' && item.payload.nodeId === aliceSwitch && item.payload.mode === 'graphic'));
  assert.deepEqual(observer.events.find(item => item.event === 'owner-view').payload, ownerView({mode: 'graphic', layout: 4}), 'unknown fields are dropped');
  observer.socket.emit('owner-view', ownerView({nodeId: null})); // An observer's view is never relayed.
  for (const invalid of [{mode: 'invalid'}, {layout: 3}, {switches: 'yes'}, {page: -1}, {expanded: 2, layout: 2}]) aliceSession.socket.emit('owner-view', ownerView(invalid));
  aliceSession.socket.emit('owner-view', ownerView({nodeId: 'h-0000000000000000', page: 1})); // Unknown node: null.
  await waitFor('unknown node relayed as null', () => observer.events.some(item => item.event === 'owner-view' && item.payload.nodeId === null));
  aliceSession.socket.emit('owner-view', ownerView({mode: 'graphic', expanded: 1}));
  // A new observer starts from the owner's last view.
  const lateObserver = recorder(boss, 'boss late observer', {auth: {observe: 'alice'}});
  await lateObserver.connected;
  await waitFor('initial owner view', () => lateObserver.events.some(item => item.event === 'owner-view' && item.payload.expanded === 1 && item.payload.mode === 'graphic'));
  lateObserver.socket.close();
  await waitFor('three owner views', () => observer.events.filter(item => item.event === 'owner-view').length >= 3);
  assert.deepEqual(observer.events.filter(item => item.event === 'owner-view').map(item => item.payload),
    [ownerView({mode: 'graphic', layout: 4}), ownerView({nodeId: null, page: 1}), ownerView({mode: 'graphic', expanded: 1})]);
  assert.ok(!observer.events.some(item => ['owner-selected-node', 'owner-view-mode'].includes(item.event)));
  aliceConsole.socket.emit('input', 'showinfo\r');
  await waitFor('alice\'s output at the observer', () => /showinfo/.test(observer.output()));
  const resetsBefore = aliceConsole.count('serial-reset');
  observer.socket.emit('input', 'observermarker\r');
  observer.socket.emit('clear-console', {id: aliceSwitch, line: ''});
  observer.socket.emit('terminal-resize', {id: aliceSwitch, cols: 100, rows: 30});
  await waitFor('three refusals', () => observer.events.filter(item => item.event === 'node-error' && /Read-only observation/.test(item.payload)).length >= 3);
  await delay(500);
  assert.doesNotMatch(aliceConsole.output(), /observermarker/, 'the observer typed into alice\'s console');
  assert.equal(aliceConsole.count('serial-reset'), resetsBefore, 'the observer cleared alice\'s console');
  assert.equal((await alice.request('/api/nodes'))[0].running, true);
  // Observing an offline user works: bob has a session but no connected browser.
  assert.equal((await boss.request('/api/admin/sessions')).find(session => session.login === 'bob').browsers, 0);
  const offlineObserver = recorder(boss, 'boss observing bob', {auth: {observe: 'bob'}});
  await offlineObserver.connected;
  assert.deepEqual(await select(offlineObserver.socket, bobSwitch), {ok: true});
  assert.ok(offlineObserver.events.some(item => item.event === 'node-snapshot' && item.payload.nodeId === bobSwitch));
  offlineObserver.socket.close();
  console.log('Admin: observation is live and read-only (input, clear, resize and writes refused), also for an offline user');

  // (4) Take control: alice's keyboard is blocked, she sees the admin's commands, and
  // the control ends when the admin's socket disconnects.
  assert.deepEqual(await emitAck(aliceSession.socket, 'take-control', aliceSwitch), {error: 'Only an administrator observing this session can take control.'});
  assert.deepEqual(await emitAck(observer.socket, 'take-control', aliceSwitch), {ok: true});
  await waitFor('control event at alice', () => aliceSession.events.some(item => item.event === 'console-control' && item.payload.active && item.payload.admin === 'boss'));
  aliceConsole.socket.emit('input', 'alicemarker\r');
  await delay(500);
  assert.doesNotMatch(observer.output(), /alicemarker/, 'alice typed while the admin had control');
  observer.socket.emit('input', 'adminmarker\r');
  await waitFor('the admin\'s command at alice', () => /adminmarker/.test(aliceConsole.output()));
  observer.socket.close();
  await waitFor('control released at alice', () => aliceSession.events.some(item => item.event === 'console-control' && !item.payload.active));
  aliceConsole.socket.emit('input', 'alicefree\r');
  await waitFor('alice types again', () => /alicefree/.test(aliceConsole.output()));
  console.log('Admin: take control blocks the student, shows the commands and ends with the admin\'s socket');

  // (5) Stop-all keeps the nodes; bulk deletion frees processes and runtime directories.
  const stopped = await boss.request('/api/admin/sessions/alice/stop', {method: 'POST'});
  assert.deepEqual(stopped.stopped, [aliceSwitch]);
  const aliceNodes = await alice.request('/api/nodes');
  assert.equal(aliceNodes.length, 1);
  assert.equal(aliceNodes[0].running, false);
  const preview = await boss.request('/api/admin/sessions/inactive?hours=0');
  assert.deepEqual(preview.logins, ['alice', 'bob'], 'the admin\'s own session must be excluded');
  assert.ok(sessionProcesses(bobSettings.sessionId).length > 0, 'bob\'s vde_switch is not running');
  const bobSession = recorder(bob, 'bob session');
  await bobSession.connected;
  const deleted = await boss.request('/api/admin/sessions/delete', {method: 'POST', body: {logins: preview.logins}});
  assert.deepEqual(deleted, {deleted: ['alice', 'bob'], failed: []});
  for (const {sessionId} of [aliceSettings, bobSettings]) {
    assert.equal(fs.existsSync(path.join(root, 'runtime', 'sessions', sessionId)), false, `runtime/sessions/${sessionId} remains`);
    await waitFor(`processes of ${sessionId} to exit`, () => sessionProcesses(sessionId).length === 0, 5000);
  }
  await waitFor('session-deleted at bob', () => bobSession.events.some(item => item.event === 'session-deleted'));
  assert.deepEqual((await boss.request('/api/admin/sessions')).map(session => session.login), ['boss']);
  await expectStatus(boss, '/api/admin/sessions/delete', 'POST', 409, {body: {logins: ['boss']}});
  // Observing a login without a session: a distinct event for the page, then the socket closes.
  const goneObserver = recorder(boss, 'boss observing a deleted session', {auth: {observe: 'alice'}});
  await goneObserver.connected;
  await waitFor('observe-unavailable', () => goneObserver.events.some(item => item.event === 'observe-unavailable' && item.payload.login === 'alice'));
  await waitFor('socket closed', () => goneObserver.events.some(item => item.event === 'disconnect'));
  await expectStatus(boss, '/api/nodes', 'GET', 404, {headers: {'x-observe': 'alice'}});
  console.log('Admin: stop-all keeps the nodes; bulk deletion frees vde_switch processes and runtime directories');

  // (6) Accounts: create, reset, disable (own account protected); a disabled account loses
  // its cookie and its sockets at once, also when disabled in users.json directly.
  await boss.request('/api/admin/users', {method: 'POST', body: {login: 'erin', password: 'first-password', role: 'student'}});
  await expectStatus(boss, '/api/admin/users', 'POST', 409, {body: {login: 'erin', password: 'x'}});
  await new QemuWebClient(baseUrl).signIn('erin', 'first-password');
  await boss.request('/api/admin/users/erin/password', {method: 'POST', body: {password: 'second-password'}});
  await expectStatus(new QemuWebClient(baseUrl), '/auth/login', 'POST', 401, {body: {login: 'erin', password: 'first-password'}});
  const erin = await new QemuWebClient(baseUrl).signIn('erin', 'second-password');
  const erinSettings = await erin.request('/api/general-settings');
  const erinSwitch = newId('switch');
  await erin.request('/api/switches', {method: 'POST', body: {id: erinSwitch, name: 'erinsw', autostart: true}});
  const erinSocket = recorder(erin, 'erin', {auth: {main: true}});
  await erinSocket.connected;
  // Removing an account: gone from users.json, cookie and sockets refused at once, session deleted.
  await expectStatus(boss, '/api/admin/users/boss', 'DELETE', 403);
  await expectStatus(boss, '/api/admin/users/nobody', 'DELETE', 404);
  assert.deepEqual(await boss.request('/api/admin/users/erin', {method: 'DELETE'}), {login: 'erin', removed: true, sessionDeleted: true});
  await waitFor('erin\'s socket closed', () => erinSocket.events.some(item => item.event === 'disconnect'));
  await expectStatus(erin, '/api/nodes', 'GET', 401);
  await expectStatus(new QemuWebClient(baseUrl), '/auth/login', 'POST', 401, {body: {login: 'erin', password: 'second-password'}});
  assert.ok(!(await boss.request('/api/admin/users')).some(user => user.login === 'erin'));
  assert.ok(!(await boss.request('/api/admin/sessions')).some(session => session.login === 'erin'));
  assert.equal(fs.existsSync(path.join(root, 'runtime', 'sessions', erinSettings.sessionId)), false);
  await waitFor('erin\'s processes to exit', () => sessionProcesses(erinSettings.sessionId).length === 0, 5000);
  await expectStatus(boss, '/api/admin/users/boss', 'PATCH', 403, {body: {disabled: true}});
  await expectStatus(boss, '/api/admin/users/boss', 'PATCH', 403, {body: {role: 'student'}});

  const carol = await signIn('carol');
  await carol.request('/api/nodes');
  const carolSocket = recorder(carol, 'carol');
  await carolSocket.connected;
  await boss.request('/api/admin/users/carol', {method: 'PATCH', body: {disabled: true}});
  await waitFor('carol\'s socket closed', () => carolSocket.events.some(item => item.event === 'disconnect'));
  await expectStatus(carol, '/api/nodes', 'GET', 401);
  await expectStatus(new QemuWebClient(baseUrl), '/auth/login', 'POST', 401, {body: {login: 'carol', password: account.carol.password}});
  assert.equal((await boss.request('/api/admin/users')).find(user => user.login === 'carol').disabled, true);
  await boss.request('/api/admin/users/carol', {method: 'PATCH', body: {disabled: false}});
  await signIn('carol');

  const dave = await signIn('dave');
  const daveSwitch = newId('switch');
  await dave.request('/api/switches', {method: 'POST', body: {id: daveSwitch, name: 'davesw', autostart: true}});
  const daveSocket = recorder(dave, 'dave');
  await daveSocket.connected;
  setDisabled(testUsers.file, 'dave', true); // What scripts/user.sh disable does.
  daveSocket.socket.emit('select-node', daveSwitch, 't-dave', () => {});
  await waitFor('dave\'s socket closed', () => daveSocket.events.some(item => item.event === 'disconnect'));
  assert.ok(daveSocket.events.some(item => item.event === 'node-error' && /no longer allowed/.test(item.payload)));
  assert.ok(!daveSocket.events.some(item => item.event === 'node-snapshot'), 'a disabled account read a console');
  await expectStatus(dave, '/api/nodes', 'GET', 401);
  console.log('Admin: accounts created, reset, disabled and removed; such an account loses cookie and sockets');

  // The log panel API: tail of admin.log and users.log, raw download; reading is not audited.
  const adminTail = await boss.request('/api/admin/logs/admin?lines=3');
  assert.equal(adminTail.entries.length, 3);
  assert.ok(adminTail.entries.every(entry => entry.admin === 'boss' && entry.action));
  assert.ok((await boss.request('/api/admin/logs/users')).entries.some(entry => entry.event === 'login'));
  await expectStatus(boss, '/api/admin/logs/other', 'GET', 404);
  await expectStatus(boss, '/api/admin/logs/admin?lines=0', 'GET', 400);
  const download = await expectStatus(boss, '/api/admin/logs/admin/download', 'GET', 200);
  assert.match(download.headers.get('content-disposition') || '', /attachment; filename="admin\.log"/);
  assert.ok((await download.text()).includes('"action":"remove-account"'));

  // (7) The admin log: one line per action, never a password or typed text.
  const text = fs.readFileSync(auditFile, 'utf8');
  assert.equal(fs.statSync(logDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(auditFile).mode & 0o777, 0o600);
  const lines = text.trimEnd().split('\n').map(line => JSON.parse(line));
  const actions = lines.map(line => line.action);
  const count = (action, target = () => true) => lines.filter(line => line.action === action && target(line.target)).length;
  assert.equal(count('observe', target => target.login === 'alice'), 1, 'one observe line for one observer socket, without any POST');
  assert.equal(count('control-start', target => target.nodeId === aliceSwitch), 1);
  assert.equal(count('control-end', target => target.nodeId === aliceSwitch && target.reason === 'disconnected'), 1);
  assert.equal(count('stop-all', target => target.login === 'alice'), 1);
  assert.equal(count('bulk-delete'), 2, 'the successful bulk delete and the refused one');
  assert.equal(count('create-account'), 2, 'erin, then the refused duplicate');
  assert.equal(count('reset-password'), 1);
  assert.equal(count('disable-account'), 1);
  assert.equal(count('enable-account'), 1);
  assert.equal(count('remove-account', target => target.login === 'erin' && target.session === true), 1);
  assert.equal(count('remove-account'), 2, 'erin, then the unknown login');
  assert.ok(lines.every(line => line.admin === 'boss' && Date.parse(line.time) && line.result), JSON.stringify(lines));
  assert.ok(!actions.includes('list'), 'the session list is not audited');
  assert.ok(!actions.some(action => /log/.test(action)), 'reading the logs is not audited');
  for (const secret of [...testUsers.users.map(user => user.password), 'first-password', 'second-password', 'adminmarker', 'observermarker', 'password":']) {
    assert.ok(!text.includes(secret), `admin.log contains ${secret}`);
  }
  console.log(`Admin: admin.log has ${lines.length} lines, one per action, without passwords or typed text`);

  // (8) users.log: user events only, never a password or typed text, nothing from observation.
  const usersFile = path.join(logDir, 'users.log');
  assert.equal(fs.statSync(usersFile).mode & 0o777, 0o600);
  const usersText = fs.readFileSync(usersFile, 'utf8');
  const events = usersText.trimEnd().split('\n').map(line => JSON.parse(line));
  const has = (user, event, target = () => true) => events.some(line => line.user === user && line.event === event && target(line.target || {}));
  for (const login of ['boss', 'alice', 'bob', 'carol', 'dave', 'erin']) assert.ok(has(login, 'login'), `no login line for ${login}`);
  assert.ok(has('erin', 'login-failed') && has('carol', 'login-failed'));
  assert.ok(has('alice', 'session-created') && has('alice', 'node-created', target => target.nodeId === aliceSwitch && target.kind === 'switch'));
  assert.ok(has('alice', 'session-deleted', target => target.sessionId === aliceSettings.sessionId && target.by === 'boss'));
  assert.ok(has('erin', 'session-deleted', target => target.sessionId === erinSettings.sessionId && target.by === 'boss'));
  assert.ok(!events.some(line => line.user === 'boss' && /^(node|archive)-/.test(line.event)), 'observation or admin actions reached users.log');
  assert.ok(events.every(line => Object.keys(line).every(key => ['time', 'user', 'event', 'target', 'result'].includes(key))));
  for (const secret of [...testUsers.users.map(user => user.password), 'first-password', 'second-password', 'adminmarker', 'alicemarker', 'showinfo']) {
    assert.ok(!usersText.includes(secret), `users.log contains ${secret}`);
  }
  console.log(`Admin: users.log has ${events.length} events, without passwords or typed text`);
}

async function cleanup() {
  for (const socket of sockets) socket.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)),
      delay(12000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })]);
  }
}

run().then(() => console.log('Admin test passed.')).catch(error => {
  console.error(`\nAdmin test FAILED: ${error.stack || error.message}`);
  if (serverOutput) console.error(`\n--- QemuWeb output ---\n${serverOutput}`);
  process.exitCode = 1;
}).finally(cleanup);
