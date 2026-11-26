'use strict';

// Admin role: the /api/admin gate, the session list, read-only observation of a student's
// switch console, exclusive console control (the admin in control does what the owner can, CTL01), stop-all, bulk deletion (processes and runtime
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
const {localRunnerRuntime} = require('../../common/runtime-dir');
const {setDisabled} = require('../../server/auth/users-store');

const root = path.join(__dirname, '..', '..');
const newId = kind => `${kind === 'switch' ? 's' : 'h'}-${crypto.randomBytes(4).toString('hex')}`;
let runtimeDir = null; // the default directory of the local runner of the server's port, l-<port> (common/runtime-dir.js)
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
  const dir = path.join(runtimeDir, 'sessions', sessionId);
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
  runtimeDir = localRunnerRuntime(port);
  const baseUrl = `http://127.0.0.1:${port}`;
  testUsers = await createTestUsers([{login: 'boss', role: 'admin'}, {login: 'alice'}, {login: 'bob'}, {login: 'carol'}, {login: 'dave'}]);
  // A log directory the server must create itself, inside the temporary users directory.
  const logDir = path.join(path.dirname(testUsers.file), 'logs');
  const auditFile = path.join(logDir, 'admin.log');
  child = spawnServer({port, usersFile: testUsers.file, logDir});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { serverOutput = (serverOutput + data).slice(-12000); });
  const account = Object.fromEntries(testUsers.users.map(user => [user.login, user]));
  const signIn = login => new QemuWebClient(baseUrl).signIn(login, account[login].password);

  await new QemuWebClient(baseUrl).waitForServer(30000, child);
  const boss = await signIn('boss');
  const alice = await signIn('alice');
  const bob = await signIn('bob');

  // (1) Every route under /api/admin answers 403 to a student, even an invented one.
  const adminRoutes = [['GET', '/sessions'], ['POST', '/sessions/delete', {logins: ['bob']}],
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
  // UXS02: alice's session is implicit, empty and placed on no runner until her first node.
  assert.deepEqual(await alice.request('/api/nodes'), [], 'an implicit, empty session');
  const unplaced = (await boss.request('/api/admin/sessions')).find(session => session.login === 'alice');
  assert.deepEqual([unplaced.placed, unplaced.runnerId, unplaced.nodes, unplaced.active], [false, null, 0, false]);
  const aliceSwitch = newId('switch'), bobSwitch = newId('switch');
  await alice.request('/api/switches', {method: 'POST', body: {id: aliceSwitch, name: 'alicesw', autostart: true}});
  await bob.request('/api/switches', {method: 'POST', body: {id: bobSwitch, name: 'bobsw', autostart: true}});
  let sessions = await boss.request('/api/admin/sessions');
  assert.deepEqual(sessions.map(session => session.login), ['alice', 'bob'], 'an admin call opened a session for the admin');
  const aliceRow = sessions.find(session => session.login === 'alice');
  assert.equal(aliceRow.switches, 1);
  assert.equal(aliceRow.placed, true, 'placed by its first node');
  assert.equal(aliceRow.sessionId, unplaced.sessionId, 'the same session');
  assert.ok(aliceRow.runnerId);
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
  await expectStatus(boss, '/api/session/reset', 'POST', 403, observeAlice);
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
  // CTL02: alice's main socket is told who observes her session (the admins' logins only), on
  // connection and when an observation starts; her console sockets and the observers are not.
  const observersAt = recorded => recorded.events.filter(item => item.event === 'session-observers').map(item => item.payload);
  await waitFor('session-observers at alice', () => observersAt(aliceSession).some(payload => payload.admins.join() === 'boss'));
  assert.deepEqual(observersAt(aliceSession).at(-1), {admins: ['boss']});
  assert.deepEqual(observersAt(aliceConsole), [], 'a console socket is not told');
  assert.deepEqual(observersAt(observer), [], 'an observer is not told');
  // Connected browser tabs: alice's main socket only (console sockets and observers do not count).
  assert.equal((await boss.request('/api/admin/sessions')).find(session => session.login === 'alice').browsers, 1);
  // The list carries a boolean "has a password" (an account created without one has none), never the hash.
  const accounts = await boss.request('/api/admin/users');
  assert.deepEqual(Object.keys(accounts[0]).sort(), ['disabled', 'login', 'password', 'role']);
  assert.ok(accounts.every(account => typeof account.password === 'boolean'), 'password is a boolean, not the hash');
  assert.deepEqual(await select(observer.socket, aliceSwitch), {ok: true});
  const snapshot = observer.events.find(item => item.event === 'node-snapshot');
  assert.equal(snapshot.payload.nodeId, aliceSwitch);
  assert.ok(!('control' in snapshot.payload), 'the control state is session-level (console-control), not in snapshots');
  // Follow: only what the owner's page publishes (owner-view) is relayed; a console socket
  // attaching in the background (select-node) moves nobody.
  assert.deepEqual(await select(aliceConsole.socket, aliceSwitch), {ok: true});
  // A full view state (public/view-state.js): panes is the node of each pane as assigned on the
  // owner's page (here alice's switch in the last pane, as the pane node menu can do).
  const paneCount = {single: 1, 'columns-2': 2, 'rows-2': 2, 'grid-4': 4};
  const ownerView = view => {
    const full = {mode: 'terminals', layout: 'columns-2', switches: true, active: aliceSwitch, floating: false, geometry: null, viewport: null, linkStyle: 'curved', ...view};
    const count = paneCount[full.layout] || 0;
    return {panes: Array.from({length: count}, (_, index) => (index === count - 1 ? aliceSwitch : null)), views: Array(count).fill('console'), ...full};
  };
  aliceSession.socket.emit('owner-view', {...ownerView({mode: 'graphic', layout: 'grid-4'}), page: 3, extra: 'dropped'});
  await waitFor('owner-view event', () => observer.events.some(item => item.event === 'owner-view' && item.payload.active === aliceSwitch && item.payload.mode === 'graphic'));
  assert.deepEqual(observer.events.find(item => item.event === 'owner-view').payload, ownerView({mode: 'graphic', layout: 'grid-4'}), 'unknown fields (page too) are dropped');
  observer.socket.emit('owner-view', ownerView({active: null})); // An observer's view is never relayed.
  for (const invalid of [{mode: 'invalid'}, {layout: 2}, {layout: 'columns-3'}, {switches: 'yes'}, {active: 3}, {layout: 'single', panes: [aliceSwitch, null]},
    {panes: [aliceSwitch]}, {panes: [aliceSwitch, null, null]}, {panes: [1, null]}, {panes: 'x'}, {views: ['console']}, {views: ['console', 'tty']}, {views: undefined},
    {floating: 'yes'}, {floating: undefined}, {geometry: undefined}, {geometry: {left: 0, top: 0, width: 1}},
    {geometry: {left: 0, top: 0, width: 1, height: 1, z: 1}}, {geometry: {left: '0', top: 0, width: 1, height: 1}},
    {viewport: undefined}, {viewport: {cx: 0, cy: 0}}, {viewport: {cx: 0, cy: 1e6, k: 1}}, {viewport: {cx: 0, cy: 0, k: 'x'}},
    {linkStyle: undefined}, {linkStyle: 'straight'}]) aliceSession.socket.emit('owner-view', ownerView(invalid));
  // Unknown nodes become null, in the active node and in the panes; a node shown twice is kept once.
  aliceSession.socket.emit('owner-view', ownerView({active: 'h-00000000', panes: ['h-00000000', aliceSwitch]}));
  await waitFor('unknown node relayed as null', () => observer.events.some(item => item.event === 'owner-view' && item.payload.active === null));
  aliceSession.socket.emit('owner-view', ownerView({mode: 'graphic', layout: 'single'}));
  // A new observer starts from the owner's last view.
  const lateObserver = recorder(boss, 'boss late observer', {auth: {observe: 'alice'}});
  await lateObserver.connected;
  await waitFor('initial owner view', () => lateObserver.events.some(item => item.event === 'owner-view' && item.payload.layout === 'single' && item.payload.mode === 'graphic'));
  assert.deepEqual(lateObserver.events.find(item => item.event === 'owner-view').payload.panes, [aliceSwitch], 'the late observer gets the layout and the panes');
  lateObserver.socket.close();
  await waitFor('three owner views', () => observer.events.filter(item => item.event === 'owner-view').length >= 3);
  assert.deepEqual(observer.events.filter(item => item.event === 'owner-view').map(item => item.payload),
    [ownerView({mode: 'graphic', layout: 'grid-4'}), ownerView({active: null, panes: [null, aliceSwitch]}),
      ownerView({mode: 'graphic', layout: 'single'})]);
  // A change of one pane's view alone (here the switch pane shows its log) is relayed.
  aliceSession.socket.emit('owner-view', ownerView({layout: 'columns-2', views: ['console', 'log']}));
  await waitFor('pane view relayed', () => observer.events.some(item => item.event === 'owner-view' && item.payload.views.join() === 'console,log'));
  assert.ok(!observer.events.some(item => ['owner-selected-node', 'owner-view-mode'].includes(item.event)));
  // The floating console of the Graphic view (CTL01): relayed open on the active node, and
  // (CTL02) kept open in the Terminals view, where it means "shown when the Graphic view comes back".
  aliceSession.socket.emit('owner-view', ownerView({mode: 'graphic', floating: true}));
  await waitFor('floating console relayed', () => observer.events.some(item => item.event === 'owner-view' && item.payload.floating === true));
  assert.deepEqual(observer.events.find(item => item.event === 'owner-view' && item.payload.floating).payload, ownerView({mode: 'graphic', floating: true}));
  aliceSession.socket.emit('owner-view', ownerView({floating: true, views: ['console', 'monitor']}));
  await waitFor('floating normalized', () => observer.events.some(item => item.event === 'owner-view' && item.payload.views.join() === 'console,monitor'));
  assert.equal(observer.events.find(item => item.event === 'owner-view' && item.payload.views.join() === 'console,monitor').payload.floating, true,
    'kept open in the Terminals view');
  // Its geometry (CTL02): fractions of the Graphic view, clamped and rounded by the server.
  aliceSession.socket.emit('owner-view', ownerView({mode: 'graphic', floating: true, geometry: {left: 0.123456, top: -1, width: 2, height: 0.5}}));
  await waitFor('geometry relayed', () => observer.events.some(item => item.event === 'owner-view' && item.payload.geometry));
  assert.deepEqual(observer.events.find(item => item.event === 'owner-view' && item.payload.geometry).payload.geometry, {left: 0.1235, top: 0, width: 1, height: 0.5});
  // The pan and zoom of the Graphic view (CTL03): the world point at the canvas center and the zoom, rounded and clamped.
  aliceSession.socket.emit('owner-view', ownerView({mode: 'graphic', viewport: {cx: 120.04, cy: -33.333, k: 7}}));
  await waitFor('viewport relayed', () => observer.events.some(item => item.event === 'owner-view' && item.payload.viewport));
  assert.deepEqual(observer.events.find(item => item.event === 'owner-view' && item.payload.viewport).payload.viewport, {cx: 120, cy: -33.3, k: 3});
  // The link style of the Graphic view (CTL04): relayed like the rest of the view.
  aliceSession.socket.emit('owner-view', ownerView({mode: 'graphic', linkStyle: 'rectilinear'}));
  await waitFor('link style relayed', () => observer.events.some(item => item.event === 'owner-view' && item.payload.linkStyle === 'rectilinear'));
  assert.deepEqual(observer.events.find(item => item.event === 'owner-view' && item.payload.linkStyle === 'rectilinear').payload, ownerView({mode: 'graphic', linkStyle: 'rectilinear'}));
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
  // CTL03: node positions of the Graphic view are session data. Alice (the driver: nobody
  // controls her session) moves her switch: the drag is relayed to the observers, the final
  // position is kept and read by everyone; an invalid event or an unknown node changes nothing,
  // and the observer without control is refused.
  const positionsAt = recorded => recorded.events.filter(item => item.event === 'node-position').map(item => item.payload);
  const layoutOf = async (client, options = {}) => (await client.request('/api/graphic-layout', options)).positions;
  assert.deepEqual(await layoutOf(alice), {}, 'no position yet: automatic layout');
  aliceSession.socket.emit('node-position', {nodeId: aliceSwitch, x: 12.34, y: -5, final: false});
  await waitFor('drag relayed to the observer', () => positionsAt(observer).length > 0);
  assert.deepEqual(positionsAt(observer), [{nodeId: aliceSwitch, x: 12.3, y: -5}]);
  assert.deepEqual(await layoutOf(alice), {}, 'a position during the drag is not kept');
  for (const invalid of [{nodeId: 'h-00000000', x: 0, y: 0, final: true}, {nodeId: aliceSwitch, x: 1e6, y: 0, final: true},
    {nodeId: aliceSwitch, x: 'a', y: 0, final: true}, {nodeId: aliceSwitch, x: 0, y: 0}, {nodeId: aliceSwitch, x: 0, y: 0, final: true, extra: 1}]) {
    aliceSession.socket.emit('node-position', invalid);
  }
  aliceSession.socket.emit('node-position', {nodeId: aliceSwitch, x: 40, y: 60.06, final: true});
  await waitFor('final position relayed', () => positionsAt(observer).length >= 2);
  await waitFor('final position kept', async () => (await layoutOf(alice))[aliceSwitch]?.x === 40);
  assert.deepEqual(positionsAt(observer), [{nodeId: aliceSwitch, x: 12.3, y: -5}, {nodeId: aliceSwitch, x: 40, y: 60.1}], 'invalid events are not relayed');
  assert.deepEqual(await layoutOf(alice), {[aliceSwitch]: {x: 40, y: 60.1}});
  assert.deepEqual(await layoutOf(boss, observeAlice), {[aliceSwitch]: {x: 40, y: 60.1}}, 'the observer reads the same layout');
  assert.ok(!positionsAt(aliceSession).length, 'not sent back to the page that moved the node');
  observer.socket.emit('node-position', {nodeId: aliceSwitch, x: 0, y: 0, final: true});
  await waitFor('observer refused', () => observer.events.some(item => item.event === 'node-error' && /take control to move nodes/.test(item.payload)));
  await delay(300);
  assert.deepEqual(await layoutOf(alice), {[aliceSwitch]: {x: 40, y: 60.1}}, 'the observer moved a node');
  assert.ok(!positionsAt(aliceSession).length, 'the observer\'s move was relayed');
  // At most 20 node-position events per second per socket: the excess of a burst is dropped,
  // and the final positions are coalesced (the last one kept).
  const beforeBurst = positionsAt(observer).length;
  await delay(1100);
  for (let index = 1; index <= 30; index++) aliceSession.socket.emit('node-position', {nodeId: aliceSwitch, x: index, y: 0, final: true});
  await waitFor('burst relayed', () => positionsAt(observer).length >= beforeBurst + 20);
  await delay(500);
  assert.equal(positionsAt(observer).length - beforeBurst, 20, 'the excess of the burst was relayed');
  await waitFor('last accepted position kept', async () => (await layoutOf(alice))[aliceSwitch]?.x === 20);
  await delay(1100);
  aliceSession.socket.emit('node-position', {nodeId: aliceSwitch, x: 40, y: 60.1, final: true});
  await waitFor('position back', async () => (await layoutOf(alice))[aliceSwitch]?.x === 40);
  // Observing an offline user works: bob has a session but no connected browser.
  assert.equal((await boss.request('/api/admin/sessions')).find(session => session.login === 'bob').browsers, 0);
  const offlineObserver = recorder(boss, 'boss observing bob', {auth: {observe: 'bob'}});
  await offlineObserver.connected;
  assert.deepEqual(await select(offlineObserver.socket, bobSwitch), {ok: true});
  assert.ok(offlineObserver.events.some(item => item.event === 'node-snapshot' && item.payload.nodeId === bobSwitch));
  offlineObserver.socket.close();
  console.log('Admin: observation is live and read-only (input, clear, resize and writes refused), also for an offline user');

  // (4) Take control of alice's session: alice's keyboard is blocked on EVERY node, the admin
  // types into whatever node his panes show, from any of his observer sockets on the session;
  // pane sockets closing and opening (layout changes) keep control; it ends with the admin's
  // last socket on the session, or when released.
  const controlStates = recorded => recorded.events.filter(item => item.event === 'console-control').map(item => item.payload);
  const released = recorded => controlStates(recorded).some(state => !state.active && state.admin);
  assert.deepEqual(controlStates(observer), [{admin: null, active: false}], 'the control state is sent at connection');
  assert.deepEqual(await emitAck(aliceSession.socket, 'take-control'), {error: 'Only an administrator observing this session can take control.'});
  const aliceOther = newId('switch');
  await alice.request('/api/switches', {method: 'POST', body: {id: aliceOther, name: 'aliceother', autostart: true}});
  const aliceOtherConsole = recorder(alice, 'alice other console');
  await aliceOtherConsole.connected;
  assert.deepEqual(await select(aliceOtherConsole.socket, aliceOther), {ok: true});
  // Taken from a second pane socket of the admin that shows no node.
  const bossPane = recorder(boss, 'boss second pane', {auth: {observe: 'alice'}});
  await bossPane.connected;
  assert.deepEqual(await emitAck(bossPane.socket, 'take-control'), {ok: true});
  await waitFor('control event at alice', () => controlStates(aliceSession).some(state => state.active && state.admin === 'boss'));
  await waitFor('control event at every admin socket', () => [observer, bossPane].every(recorded => controlStates(recorded).some(state => state.active)));
  aliceConsole.socket.emit('input', 'alicemarker\r');
  aliceOtherConsole.socket.emit('input', 'alicemarker\r');
  await delay(500);
  assert.doesNotMatch(aliceConsole.output() + aliceOtherConsole.output(), /alicemarker/, 'alice typed while the admin had control');
  observer.socket.emit('input', 'adminmarker\r');
  await waitFor('the admin\'s command at alice', () => /adminmarker/.test(aliceConsole.output()));
  // Layout change: one pane socket closes, another opens on the other node.
  bossPane.socket.close();
  const bossNewPane = recorder(boss, 'boss new pane', {auth: {observe: 'alice'}});
  await bossNewPane.connected;
  await waitFor('state at connection', () => controlStates(bossNewPane).length > 0);
  assert.deepEqual(controlStates(bossNewPane), [{admin: 'boss', active: true}]);
  assert.deepEqual(await select(bossNewPane.socket, aliceOther), {ok: true});
  bossNewPane.socket.emit('input', 'adminother\r');
  await waitFor('the admin types into the other node', () => /adminother/.test(aliceOtherConsole.output()));
  const aliceSecondTab = recorder(alice, 'alice second console');
  await aliceSecondTab.connected;
  assert.deepEqual(await select(aliceSecondTab.socket, aliceSwitch), {ok: true});
  aliceConsole.socket.emit('input', 'alicestill1\r');
  aliceOtherConsole.socket.emit('input', 'alicestill2\r');
  aliceSecondTab.socket.emit('input', 'alicestill3\r');
  await delay(500);
  assert.doesNotMatch(aliceConsole.output() + aliceOtherConsole.output(), /alicestill/, 'alice typed after a layout change of the admin');
  assert.ok(![aliceSession, observer, bossNewPane].some(released), 'control released by a layout change');
  // While the admin holds control, the view goes the other way: controller-view from the
  // admin's page reaches alice's pages; never from alice, nor once control has ended.
  // The admin's floating console of the Graphic view is open: alice's pages open it too (CTL01).
  const controllerView = {mode: 'graphic', layout: 'rows-2', panes: [null, aliceSwitch], views: ['console', 'log'], switches: true, active: aliceSwitch, floating: true,
    geometry: {left: 0.25, top: 0.1, width: 0.5, height: 0.6}, viewport: {cx: 10, cy: 20, k: 0.5}, linkStyle: 'rectilinear'};
  aliceSession.socket.emit('controller-view', controllerView);
  observer.socket.emit('controller-view', {...controllerView, layout: 'grid-3'}); // Invalid: dropped.
  observer.socket.emit('controller-view', controllerView);
  await waitFor('controller-view at alice', () => aliceSession.events.some(item => item.event === 'controller-view'));
  assert.deepEqual(aliceSession.events.filter(item => item.event === 'controller-view').map(item => item.payload), [controllerView]);
  const aliceLateTab = recorder(alice, 'alice late tab', {auth: {main: true}});
  await waitFor('controller-view for a page opened during control', () => aliceLateTab.events.some(item => item.event === 'controller-view'));
  aliceLateTab.socket.close();
  aliceSecondTab.socket.close();
  // CTL03: under control the admin moves the nodes and alice cannot (one driver at a time):
  // her node-position is dropped silently, the admin's reaches her pages and is kept.
  const observerPositions = positionsAt(observer).length;
  aliceSession.socket.emit('node-position', {nodeId: aliceSwitch, x: -1, y: -1, final: true});
  observer.socket.emit('node-position', {nodeId: aliceSwitch, x: 70, y: 80, final: true});
  await waitFor('the admin\'s move at alice', () => positionsAt(aliceSession).some(item => item.x === 70));
  await waitFor('the admin\'s move kept', async () => (await layoutOf(alice))[aliceSwitch]?.x === 70);
  await delay(300);
  assert.deepEqual(await layoutOf(alice), {[aliceSwitch]: {x: 70, y: 80}}, 'alice moved a node while controlled');
  assert.equal(positionsAt(observer).length, observerPositions, 'alice\'s move was relayed while controlled');
  // CTL01: the admin holding control does what alice can, audited; alice's writes are refused
  // meanwhile (one driver at a time); the former Delete session route is gone (Reset session, UXS02, below).
  const aliceCtl = newId('switch');
  await boss.request('/api/switches', {...observeAlice, method: 'POST', body: {id: aliceCtl, name: 'alicectl', autostart: true}});
  assert.ok((await alice.request('/api/nodes')).some(node => node.id === aliceCtl), 'the admin\'s switch is in alice\'s session');
  const bossOwnNodes = (await boss.request('/api/nodes')).map(node => node.id);
  assert.ok(!bossOwnNodes.includes(aliceCtl), 'not in the admin\'s own session');
  assert.equal((await boss.request('/api/general-settings')).sessionId, bossSettings.sessionId, 'the admin\'s own session was replaced');
  await boss.request(`/api/nodes/${aliceCtl}/stop`, {...observeAlice, method: 'POST'});
  observer.socket.emit('node-position', {nodeId: aliceCtl, x: 5, y: 5, final: true});
  await waitFor('position of the new node kept', async () => !!(await layoutOf(alice))[aliceCtl]);
  const saved = await expectStatus(boss, '/api/session-archive/export', 'POST', 200, {...observeAlice, body: {includeDisks: false}});
  assert.match(saved.headers.get('content-disposition') || '', /filename="qemuweb-session-alice\.zip"/);
  assert.ok(Buffer.from(await saved.arrayBuffer()).includes('layout.json'), 'the archive carries the layout');
  await expectStatus(boss, '/api/session', 'DELETE', 404, observeAlice);
  assert.equal((await alice.request('/api/general-settings')).sessionId, aliceSettings.sessionId, 'alice\'s session was deleted');
  assert.equal((await boss.request('/api/general-settings')).sessionId, bossSettings.sessionId, 'the admin\'s own session was deleted');
  assert.deepEqual((await boss.request('/api/nodes')).map(node => node.id), bossOwnNodes, 'the admin\'s own nodes changed');
  const refusedOwner = await expectStatus(alice, `/api/nodes/${aliceCtl}`, 'DELETE', 403);
  assert.equal((await refusedOwner.json()).error, 'boss controls your session.');
  assert.ok((await alice.request('/api/nodes')).some(node => node.id === aliceCtl), 'alice\'s refused deletion removed the node');
  await expectStatus(alice, '/api/switches', 'POST', 403, {body: {id: newId('switch'), name: 'alicewhile'}});
  const refusedReset = await expectStatus(alice, '/api/session/reset', 'POST', 403);
  assert.equal((await refusedReset.json()).error, 'boss controls your session.');
  assert.ok(Array.isArray(await alice.request('/api/nodes')), 'alice still reads');
  await boss.request(`/api/nodes/${aliceCtl}`, {...observeAlice, method: 'DELETE'});
  assert.deepEqual(Object.keys(await layoutOf(alice)), [aliceSwitch], 'a removed node loses its position');
  // Clear and resize: the admin's are applied, alice's dropped silently.
  const resetsUnderControl = aliceConsole.count('serial-reset');
  const observerEventsBefore = observer.events.length;
  observer.socket.emit('clear-console', {id: aliceSwitch, line: ''});
  await waitFor('the admin clears alice\'s console', () => aliceConsole.count('serial-reset') > resetsUnderControl);
  const resetsAfterAdmin = aliceConsole.count('serial-reset');
  aliceConsole.socket.emit('clear-console', {id: aliceSwitch, line: ''});
  await delay(500);
  assert.equal(aliceConsole.count('serial-reset'), resetsAfterAdmin, 'alice cleared her console while controlled');
  assert.ok(!observer.events.slice(observerEventsBefore).some(item => item.event === 'node-error' && /cannot be (cleared|resized)/.test(item.payload)),
    'the admin in control was refused a clear');
  // Closing a pane socket while another remains keeps control; the last one releases it.
  bossNewPane.socket.close();
  await delay(300);
  assert.ok(!released(aliceSession), 'control released while an admin socket remained');
  observer.socket.close();
  await waitFor('control released at alice', () => released(aliceSession));
  // boss's last socket on the session closed: alice is told nobody observes any more (CTL02).
  await waitFor('no observer at alice', () => observersAt(aliceSession).at(-1)?.admins.length === 0);
  aliceConsole.socket.emit('input', 'alicefree\r');
  aliceOtherConsole.socket.emit('input', 'alicefree2\r');
  await waitFor('alice types again', () => /alicefree/.test(aliceConsole.output()) && /alicefree2/.test(aliceOtherConsole.output()));
  // Explicit release; afterwards controller-view is no longer relayed.
  const formerController = recorder(boss, 'boss after control', {auth: {observe: 'alice'}});
  await formerController.connected;
  assert.deepEqual(await emitAck(formerController.socket, 'take-control'), {ok: true});
  assert.deepEqual(await emitAck(formerController.socket, 'release-control'), {ok: true});
  await waitFor('explicit release at the admin socket', () => released(formerController));
  const viewsBefore = aliceSession.events.filter(item => item.event === 'controller-view').length;
  formerController.socket.emit('controller-view', controllerView);
  await delay(300);
  assert.equal(aliceSession.events.filter(item => item.event === 'controller-view').length, viewsBefore, 'controller-view relayed without control');
  // Without control again: the same write of the admin is refused, alice writes (her deletion below).
  const afterRelease = newId('switch');
  await expectStatus(boss, '/api/switches', 'POST', 403, {...observeAlice, body: {id: afterRelease, name: 'afterrelease'}});
  assert.ok(!(await alice.request('/api/nodes')).some(node => node.id === afterRelease), 'a refused write created a node');
  await waitFor('a new observation is told again', () => observersAt(aliceSession).at(-1)?.admins.join() === 'boss');
  formerController.socket.close();
  await waitFor('observation closed at alice', () => observersAt(aliceSession).at(-1)?.admins.length === 0);
  aliceOtherConsole.socket.close();
  await alice.request(`/api/nodes/${aliceOther}`, {method: 'DELETE'});
  console.log('Admin: session control blocks the student on every node, survives layout changes and ends with the admin\'s last socket or a release');

  // (5) Stop-all keeps the nodes; bulk deletion frees processes and runtime directories.
  const stopped = await boss.request('/api/admin/sessions/alice/stop', {method: 'POST'});
  assert.deepEqual(stopped.stopped, [aliceSwitch]);
  const aliceNodes = await alice.request('/api/nodes');
  assert.equal(aliceNodes.length, 1);
  assert.equal(aliceNodes[0].running, false);
  assert.ok(sessionProcesses(bobSettings.sessionId).length > 0, 'bob\'s vde_switch is not running');
  const bobSession = recorder(bob, 'bob session');
  await bobSession.connected;
  const deleted = await boss.request('/api/admin/sessions/delete', {method: 'POST', body: {logins: ['alice', 'bob']}});
  assert.deepEqual(deleted, {deleted: ['alice', 'bob'], failed: []});
  for (const {sessionId} of [aliceSettings, bobSettings]) {
    assert.equal(fs.existsSync(path.join(runtimeDir, 'sessions', sessionId)), false, `${runtimeDir}/sessions/${sessionId} remains`);
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

  // UXS02: alice's next request opens a new, empty session; the admin holding control resets it: it stays, empty and unplaced.
  const aliceNew = (await alice.request('/api/general-settings')).sessionId;
  assert.notEqual(aliceNew, aliceSettings.sessionId, 'a new session after the deletion');
  const aliceAgain = newId('switch');
  await alice.request('/api/switches', {method: 'POST', body: {id: aliceAgain, name: 'aliceagain', autostart: true}});
  const resetter = recorder(boss, 'boss resetting alice', {auth: {observe: 'alice'}});
  await resetter.connected;
  assert.deepEqual(await emitAck(resetter.socket, 'take-control'), {ok: true});
  assert.deepEqual(await boss.request('/api/session/reset', {...observeAlice, method: 'POST'}), {reset: true});
  assert.deepEqual(await alice.request('/api/nodes'), [], 'every node removed');
  assert.equal((await alice.request('/api/general-settings')).sessionId, aliceNew, 'the session stays');
  const resetRow = (await boss.request('/api/admin/sessions')).find(session => session.login === 'alice');
  assert.deepEqual([resetRow.placed, resetRow.nodes], [false, 0], 'unplaced once empty');
  await waitFor(`processes of ${aliceNew} to exit`, () => sessionProcesses(aliceNew).length === 0, 5000);
  assert.equal(fs.existsSync(path.join(runtimeDir, 'sessions', aliceNew)), false, 'the runner removed the directory');
  resetter.socket.close();
  console.log('Admin: the admin holding control resets a session; it stays, empty and placed on no runner');

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
  assert.equal(fs.existsSync(path.join(runtimeDir, 'sessions', erinSettings.sessionId)), false);
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
  const allLines = text.trimEnd().split('\n').map(line => JSON.parse(line));
  // The server itself writes one line when it creates the record of its local runner (start.sh runs it with --local-runner): the first line, by "server",
  // with no token or hash. Every other line is an action of the administrator.
  const serverLines = allLines.filter(line => line.admin === 'server');
  assert.equal(serverLines.length, 1);
  assert.deepEqual([serverLines[0].action, serverLines[0].target, serverLines[0].result], ['register-local-runner', {runnerId: 'local'}, 'ok']);
  assert.equal(allLines[0], serverLines[0], 'written at start, before any administrator action');
  assert.deepEqual(Object.keys(serverLines[0]).sort(), ['action', 'admin', 'result', 'target', 'time'], 'no token, no hash');
  const lines = allLines.filter(line => line.admin !== 'server');
  const actions = lines.map(line => line.action);
  const count = (action, target = () => true) => lines.filter(line => line.action === action && target(line.target)).length;
  // 'observe' is written by the server when an observation period starts (the first open observer
  // socket of an admin on a login), never by a request. Alice was observed twice: by the first
  // observer sockets (the late observer joined while they were open), then, after they had all
  // closed, by the socket that checked controller-view after control. Bob once, while offline.
  assert.equal(count('observe', target => target.login === 'alice'), 3, 'one observe line per observation period of alice');
  assert.equal(count('observe', target => target.login === 'bob'), 1, 'one observe line for bob');
  assert.equal(count('control-start', target => target.login === 'alice' && !('nodeId' in target)), 3);
  assert.equal(count('control-end', target => target.login === 'alice' && target.reason === 'disconnected'), 2);
  assert.equal(count('session-reset', target => target.login === 'alice'), 1, 'the reset under control (UXS02)');
  assert.equal(count('control-end', target => target.login === 'alice' && target.reason === 'released'), 1);
  assert.equal(count('stop-all', target => target.login === 'alice'), 1);
  // CTL01: the actions of the admin in control on alice's session.
  assert.equal(count('node-created', target => target.login === 'alice' && target.nodeId === aliceCtl), 1);
  assert.equal(count('node-stopped', target => target.login === 'alice' && target.nodeId === aliceCtl), 1);
  assert.equal(count('node-deleted', target => target.login === 'alice' && target.nodeId === aliceCtl), 1);
  assert.equal(count('archive-saved', target => target.login === 'alice' && target.kind === 'session'), 1);
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
  for (const secret of [...testUsers.users.map(user => user.password), 'first-password', 'second-password', 'adminmarker', 'adminother', 'observermarker', 'password":']) {
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
  assert.ok(has('alice', 'session-placed', target => target.sessionId === aliceSettings.sessionId && typeof target.runnerId === 'string') && has('alice', 'node-created', target => target.nodeId === aliceSwitch && target.kind === 'switch'));
  assert.ok(has('alice', 'session-deleted', target => target.sessionId === aliceSettings.sessionId && target.by === 'boss'));
  assert.ok(has('alice', 'session-reset', target => target.by === 'boss'), 'the reset under control is in alice\'s users.log');
  assert.ok(!events.some(line => line.event === 'session-created'), 'no session-created any more: a session is implicit');
  assert.ok(has('erin', 'session-deleted', target => target.sessionId === erinSettings.sessionId && target.by === 'boss'));
  assert.ok(!events.some(line => line.user === 'boss' && /^(node|archive)-/.test(line.event)), 'observation or admin actions reached users.log');
  for (const event of ['node-created', 'node-stopped', 'node-deleted']) {
    assert.ok(has('alice', event, target => target.nodeId === aliceCtl && target.by === 'boss'), `alice's users.log lacks ${event} by boss`);
  }
  assert.ok(has('alice', 'archive-saved', target => target.by === 'boss'));
  assert.ok(!events.some(line => line.target?.by === 'boss' && line.target?.nodeId === aliceSwitch && line.event === 'node-stopped'), 'a refused request was logged as done');
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
