// Connections panel (server/ws-transports.js, GET /api/admin/connections) and the /ws-test namespace
// (server/ws-test.js): the registry of live Socket.IO connections and their transport, the "still on
// polling" log line (20 s rule, once per login every 10 minutes) with an injected clock, the admin
// gate and the shape of the route, the namespace refusing non-admins. No server socket is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const {EventEmitter} = require('node:events');
const {createTransportRegistry, POLLING_WARN_AFTER_MS, WARN_EVERY_MS} = require('../../server/ws-transports');
const {attachWsTest, WS_TEST_NAMESPACE} = require('../../server/ws-test');
const {createAdminRouter} = require('../../server/routes/admin');
const {createAuth} = require('../../server/auth');
const {defaultSettings} = require('../../server/options');

// A fake clock with a scheduler, and a fake Socket.IO socket (its engine connection included).
function harness() {
  let time = Date.parse('2026-01-01T00:00:00Z');
  const pending = new Set();
  const lines = [];
  const registry = createTransportRegistry({
    now: () => time,
    timers: {set: (fn, ms) => { const timer = {fn, at: time + ms}; pending.add(timer); return timer; }, clear: timer => pending.delete(timer)},
    warn: line => lines.push(line)
  });
  const advance = ms => {
    time += ms;
    for (const timer of [...pending]) if (timer.at <= time) { pending.delete(timer); timer.fn(); }
  };
  const socket = (transport = 'polling') => Object.assign(new EventEmitter(), {conn: Object.assign(new EventEmitter(), {transport: {name: transport}})});
  const upgrade = s => { s.conn.transport = {name: 'websocket'}; s.conn.emit('upgrade', s.conn.transport); };
  return {registry, lines, advance, socket, upgrade};
}

test('the registry counts connections per transport and follows the upgrade event', () => {
  const {registry, socket, upgrade} = harness();
  const a = socket('polling'), b = socket('websocket'), c = socket('websocket');
  registry.track(a, {login: 'alice', main: true});
  registry.track(b, {login: 'bob'});
  registry.track(c, {login: 'root', observer: true});
  assert.deepEqual(registry.summary().items.map(item => [item.login, item.transport, item.main, item.observer]),
    [['alice', 'polling', true, false], ['bob', 'websocket', false, false], ['root', 'websocket', false, true]]);
  assert.deepEqual({...registry.summary(), items: undefined}, {total: 3, websocket: 2, polling: 1, items: undefined});
  upgrade(a);
  assert.deepEqual({...registry.summary(), items: undefined}, {total: 3, websocket: 3, polling: 0, items: undefined});
  b.emit('disconnect');
  assert.equal(registry.summary().total, 2);
});

test('an entry shows only login, transport, connection time, main and observer', () => {
  const {registry, socket} = harness();
  const s = socket();
  s.handshake = {headers: {cookie: 'secret', 'user-agent': 'x'}, address: '10.0.0.1'};
  registry.track(s, {login: 'alice', main: true});
  const [item] = registry.summary().items;
  assert.deepEqual(Object.keys(item).sort(), ['login', 'main', 'observer', 'since', 'transport']);
  assert.equal(item.since, '2026-01-01T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(registry.summary()), /secret|10\.0\.0\.1/);
});

test('a connection still on polling after 20 s is logged once, with no cookie, key or address', () => {
  const {registry, lines, advance, socket} = harness();
  registry.track(socket('polling'), {login: 'alice'});
  advance(POLLING_WARN_AFTER_MS - 1);
  assert.deepEqual(lines, []);
  advance(1);
  assert.deepEqual(lines, ['[sockets] alice: still on polling 20 s after connecting (no WebSocket upgrade: check that the reverse proxy forwards Upgrade and Connection)']);
});

test('a connection upgraded or closed before 20 s is not logged', () => {
  const {registry, lines, advance, socket, upgrade} = harness();
  const upgraded = socket('polling'), closed = socket('polling');
  registry.track(upgraded, {login: 'alice'});
  registry.track(closed, {login: 'bob'});
  registry.track(socket('websocket'), {login: 'carol'});
  advance(5000);
  upgrade(upgraded);
  closed.emit('disconnect');
  advance(POLLING_WARN_AFTER_MS);
  assert.deepEqual(lines, []);
});

test('the polling line is written at most once per login every 10 minutes', () => {
  const {registry, lines, advance, socket} = harness();
  for (let i = 0; i < 3; i++) registry.track(socket('polling'), {login: 'alice'});
  registry.track(socket('polling'), {login: 'bob'});
  advance(POLLING_WARN_AFTER_MS);
  assert.deepEqual(lines.map(line => line.split(':')[0]), ['[sockets] alice', '[sockets] bob']);
  advance(WARN_EVERY_MS - POLLING_WARN_AFTER_MS - 1);
  registry.track(socket('polling'), {login: 'alice'});
  advance(POLLING_WARN_AFTER_MS);
  assert.equal(lines.length, 2, 'still inside the 10 minutes of the first line');
  registry.track(socket('polling'), {login: 'alice'});
  advance(WARN_EVERY_MS);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /^\[sockets\] alice: /);
});

// The admin router on a real Express app, with the real requireAdmin of createAuth.
async function withRouter(t, connections) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-wst-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const auth = createAuth({settings: {...defaultSettings(path.join(__dirname, '..', '..')), usersFile: path.join(dir, 'users.json')}});
  const app = express();
  app.use((req, _res, next) => { req.user = {login: req.get('X-Test-User'), role: req.get('X-Test-Role')}; next(); });
  app.use('/api/admin', createAdminRouter({manager: {list: () => []}, auth, audit: {record() {}}, disconnectUser() {}, browsers: () => 0, connections, logDir: dir, port: 0}));
  const server = await new Promise(resolve => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  return async (url, role) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {headers: {'X-Test-User': 'u', 'X-Test-Role': role}});
    return {status: response.status, body: await response.json()};
  };
}

test('GET /api/admin/connections is 403 for a student and answers {total, websocket, polling, items} to an admin', async t => {
  const {registry, socket} = harness();
  registry.track(socket('websocket'), {login: 'alice', main: true});
  registry.track(socket('polling'), {login: 'bob'});
  const get = await withRouter(t, () => registry.summary());
  assert.equal((await get('/api/admin/connections', 'student')).status, 403);
  assert.equal((await get('/api/admin/connections/unknown', 'student')).status, 403);
  const {status, body} = await get('/api/admin/connections', 'admin');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['items', 'polling', 'total', 'websocket']);
  assert.deepEqual([body.total, body.websocket, body.polling], [2, 1, 1]);
  assert.deepEqual(body.items.map(item => item.login), ['alice', 'bob']);
});

test('the /ws-test namespace refuses non-admins and accounts that stopped being admin', async () => {
  const middlewares = [];
  let onConnection;
  const namespace = {use: fn => middlewares.push(fn), on: (_event, fn) => { onConnection = fn; }};
  const io = {of: name => { assert.equal(name, WS_TEST_NAMESPACE); return namespace; }};
  let accounts = {root: {login: 'root', role: 'admin'}, alice: {login: 'alice', role: 'student'}};
  const authenticate = (socket, next) => { socket.data = {user: socket.user}; next(); };
  attachWsTest(io, {socketMiddleware: authenticate, currentUser: login => accounts[login] || null});
  const connect = user => new Promise(resolve => {
    const socket = {user};
    let index = 0;
    const next = error => (error || index === middlewares.length ? resolve(error) : middlewares[index++](socket, next));
    middlewares[index++](socket, next);
  });
  assert.equal(await connect({login: 'root', role: 'admin'}), undefined);
  assert.match((await connect({login: 'alice', role: 'student'})).message, /Administrator role required/);
  accounts = {root: {login: 'root', role: 'student'}};
  assert.match((await connect({login: 'root', role: 'admin'})).message, /Administrator role required/);
  // The echo answers through the acknowledgement and ignores a call without one.
  const handlers = {};
  onConnection({on: (event, fn) => { handlers[event] = fn; }});
  const answers = [];
  handlers.echo('ping', answer => answers.push(answer));
  handlers.echo({big: true}, answer => answers.push(answer));
  handlers.echo('no acknowledgement');
  assert.deepEqual(answers, ['ping', null]);
});
