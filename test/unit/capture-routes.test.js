// Traffic capture, server side: the routes of server/routes/captures.js behind the session router
// (fake runner, real express on a loopback port), the rights of an observer and of an administrator
// holding the control lock, the audit entries, and the observation gate's capture exception.
const assert = require('node:assert/strict');
const http = require('node:http');
const {Readable} = require('node:stream');
const test = require('node:test');
const express = require('express');
const settle = () => new Promise(resolve => setImmediate(resolve));
const {createSessionRouter, userEvent} = require('../../server/routes');
const {observationGate} = require('../../server/routes/admin');
const {MAX_DOWNLOAD} = require('../../server/routes/captures');

const HOST = 'h-0000000000000001';
const CAP = 'eth0-20261120T101530Z';
const session = {owner: 'toto', id: 'sess'};

// Serves the session router with the caller described by `who`: {user, observed, observedControl}.
async function serve(t, {runner, who}) {
  const sent = [];
  const fake = {
    request: async (command, args) => {
      sent.push([command, args]);
      return runner.request ? runner.request(command, args) : {ok: true};
    },
    incoming: id => runner.incoming(id)
  };
  const userLog = {entries: [], record(...args) { this.entries.push(args); }};
  const audit = {entries: [], record(...args) { this.entries.push(args); }};
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, who); next(); });
  app.use(createSessionRouter({session, runner: fake, userLog, audit}));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body) => fetch(base + path, {method, headers: {'content-type': 'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {})});
  return {call, sent, userLog, audit};
}

const owner = {user: {login: 'toto', role: 'student'}};
const observer = {user: {login: 'boss', role: 'admin'}, observed: {}};
const controller = {user: {login: 'boss', role: 'admin'}, observed: {}, observedControl: true};
const ROUTES = [
  ['GET', '/api/captures'], ['GET', `/api/nodes/${HOST}/captures`], ['POST', `/api/nodes/${HOST}/captures`, {interface: 'eth0'}],
  ['POST', `/api/nodes/${HOST}/captures/${CAP}/stop`], ['DELETE', `/api/nodes/${HOST}/captures/${CAP}`], ['GET', `/api/nodes/${HOST}/captures/${CAP}/download`]
];

test('a plain observer can do nothing with captures, not even list or download', async t => {
  const {call, sent, userLog, audit} = await serve(t, {runner: {}, who: observer});
  for (const [method, path, body] of ROUTES) {
    const response = await call(method, path, body);
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.match((await response.json()).error, /Read-only observation/);
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(userLog.entries, []);
  assert.deepEqual(audit.entries, []);
});

test('the owner starts, lists, stops and deletes; the runner command and its arguments are exact', async t => {
  const {call, sent, userLog} = await serve(t, {runner: {request: async command => (command === 'captures.list' ? {limits: {}, captures: []} : {id: CAP})}, who: owner});
  assert.equal((await call('GET', '/api/captures')).status, 200);
  assert.equal((await call('GET', `/api/nodes/${HOST}/captures`)).headers.get('cache-control'), 'no-store');
  const started = await call('POST', `/api/nodes/${HOST}/captures`, {interface: 'eth0'});
  assert.equal(started.status, 200);
  assert.equal((await call('POST', `/api/nodes/${HOST}/captures/${CAP}/stop`)).status, 200);
  assert.equal((await call('DELETE', `/api/nodes/${HOST}/captures/${CAP}`)).status, 200);
  assert.deepEqual(sent, [['captures.list', {}], ['captures.list', {nodeId: HOST}], ['capture.start', {nodeId: HOST, interface: 'eth0'}],
    ['capture.stop', {nodeId: HOST, captureId: CAP}], ['capture.delete', {nodeId: HOST, captureId: CAP}]]);
  await settle();
  assert.deepEqual(userLog.entries.map(entry => [entry[0], entry[1], entry[2], entry[3]]), [
    ['toto', 'capture-started', {nodeId: HOST, interface: 'eth0'}, 'ok'],
    ['toto', 'capture-stopped', {nodeId: HOST, captureId: CAP}, 'ok'],
    ['toto', 'capture-deleted', {nodeId: HOST, captureId: CAP}, 'ok']]);
});

test('malformed interface or capture IDs are refused before the runner, and the runner status comes through', async t => {
  const {call, sent} = await serve(t, {runner: {request: async () => { throw Object.assign(new Error('The host is not running.'), {status: 409}); }}, who: owner});
  for (const body of [undefined, {}, {interface: 'eth9'}, {interface: '../x'}, {interface: 'eth0; rm'}]) {
    assert.equal((await call('POST', `/api/nodes/${HOST}/captures`, body)).status, 400, JSON.stringify(body));
  }
  for (const bad of ['eth0-1', 'eth0-20261120T101530Z.pcap', 'x']) {
    for (const [method, suffix] of [['POST', '/stop'], ['DELETE', ''], ['GET', '/download']]) {
      assert.equal((await call(method, `/api/nodes/${HOST}/captures/${bad}${suffix}`)).status, 404, `${method} ${bad}${suffix}`);
    }
  }
  assert.deepEqual(sent, []);
  const refused = await call('POST', `/api/nodes/${HOST}/captures`, {interface: 'eth0'});
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {error: 'The host is not running.'});
});

test('download streams the file from the runner with a PCAP attachment, and refuses an oversized one', async t => {
  const runner = {request: async () => ({stream: 3, size: 5, name: `${CAP}.pcap`}), incoming: () => Readable.from([Buffer.from('he'), Buffer.from('llo')])};
  const {call, userLog} = await serve(t, {runner, who: owner});
  const response = await call('GET', `/api/nodes/${HOST}/captures/${CAP}/download`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '5');
  assert.equal(response.headers.get('content-type'), 'application/vnd.tcpdump.pcap');
  assert.match(response.headers.get('content-disposition'), new RegExp(`attachment; filename="${CAP}.pcap"`));
  assert.equal(await response.text(), 'hello');
  await settle();
  assert.deepEqual(userLog.entries.map(entry => entry[1]), ['capture-downloaded']);
  const big = await serve(t, {runner: {request: async () => ({stream: 4, size: MAX_DOWNLOAD + 1, name: `${CAP}.pcap`}), incoming: () => Readable.from([])}, who: owner});
  assert.equal((await big.call('GET', `/api/nodes/${HOST}/captures/${CAP}/download`)).status, 413);
});

test('an administrator holding the control lock may use the capture routes; the audit log says who and on whose session', async t => {
  const {call, sent, audit, userLog} = await serve(t, {runner: {request: async () => ({id: CAP})}, who: controller});
  assert.equal((await call('POST', `/api/nodes/${HOST}/captures`, {interface: 'eth1'})).status, 200);
  assert.equal((await call('DELETE', `/api/nodes/${HOST}/captures/${CAP}`)).status, 200);
  assert.equal(sent.length, 2);
  await settle();
  assert.deepEqual(audit.entries, [
    ['boss', 'capture-started', {login: 'toto', nodeId: HOST, interface: 'eth1'}, 'ok'],
    ['boss', 'capture-deleted', {login: 'toto', nodeId: HOST, captureId: CAP}, 'ok']]);
  assert.deepEqual(userLog.entries, [], "the owner's users.log is not written for the admin's actions");
});

test('userEvent names the capture events and drops anything that is not an ID', () => {
  const key = (method, path, body) => userEvent({method, path, body});
  assert.deepEqual(key('POST', `/api/nodes/${HOST}/captures`, {interface: 'eth2'}), {event: 'capture-started', target: {nodeId: HOST, interface: 'eth2'}});
  assert.deepEqual(key('POST', `/api/nodes/${HOST}/captures`, {interface: '../etc'}), {event: 'capture-started', target: {nodeId: HOST}});
  assert.deepEqual(key('POST', `/api/nodes/zzz/captures/${CAP}/stop`), {event: 'capture-stopped', target: {nodeId: null, captureId: CAP}});
  assert.equal(key('GET', `/api/nodes/${HOST}/captures`), null);
  assert.equal(key('GET', '/api/captures'), null);
});

test('the observation gate admits capture requests of the admin holding the control lock, and nothing else', () => {
  const workspace = {owner: 'toto', session: {id: 'sess'}};
  const manager = {get: login => (login === 'toto' ? workspace : null)};
  const held = new Set();
  const gate = observationGate(manager, {controlHeld: (sessionId, admin) => held.has(`${sessionId}:${admin}`)});
  const run = options => {
    const lower = {'x-observe': 'toto'};
    const req = {method: 'GET', path: '/api/nodes', headers: lower, user: {login: 'boss', role: 'admin'}, get: name => lower[name.toLowerCase()], ...options};
    const res = {statusCode: 200, status(code) { this.statusCode = code; return this; }, json() { return this; }};
    let passed = false;
    gate(req, res, () => { passed = true; });
    return {passed, status: res.statusCode, req};
  };
  const captureRequests = [['POST', `/api/nodes/${HOST}/captures`], ['POST', `/api/nodes/${HOST}/captures/${CAP}/stop`],
    ['DELETE', `/api/nodes/${HOST}/captures/${CAP}`], ['GET', `/api/nodes/${HOST}/captures/${CAP}/download`], ['GET', '/api/captures']];
  // Without the lock: writes refused, reads pass without the control mark (the routes then refuse them).
  for (const [method, path] of captureRequests) {
    const result = run({method, path});
    assert.equal(result.passed, method === 'GET', `${method} ${path} without lock`);
    if (method !== 'GET') assert.equal(result.status, 403);
    else assert.equal(result.req.observedControl, undefined);
  }
  held.add('sess:boss');
  for (const [method, path] of captureRequests) {
    const result = run({method, path});
    assert.equal(result.passed, true, `${method} ${path} with lock`);
    assert.equal(result.req.observedControl, true);
    assert.equal(result.req.observed, workspace);
  }
  // Everything else a write stays refused, even with the lock; so do near misses of the capture paths.
  for (const [method, path] of [['POST', `/api/nodes/${HOST}/start`], ['DELETE', `/api/nodes/${HOST}`], ['POST', '/api/nodes/stop-all'],
    ['DELETE', '/api/captures'], ['POST', '/api/captures'], ['POST', `/api/nodes/${HOST}/captures-x`], ['POST', `/api/nodes/${HOST}/captures/${CAP}/stop/x`],
    ['PUT', `/api/nodes/${HOST}/captures`], ['PATCH', `/api/nodes/${HOST}/captures/${CAP}`]]) {
    const result = run({method, path});
    assert.equal(result.passed, false, `${method} ${path}`);
    assert.equal(result.status, 403);
  }
  // Another admin, or the lock of another session, gives nothing.
  assert.equal(run({method: 'POST', path: `/api/nodes/${HOST}/captures`, user: {login: 'other', role: 'admin'}}).status, 403);
  assert.equal(run({method: 'GET', path: `/api/nodes/${HOST}/captures`, user: {login: 'other', role: 'admin'}}).req.observedControl, undefined);
  // The mounted gate sees paths relative to /api.
  assert.equal(run({method: 'POST', baseUrl: '/api', path: `/nodes/${HOST}/captures`}).passed, true);
  // The observation of an unknown user is still 404 for a read and 403 for a write.
  assert.equal(run({headers: {'x-observe': 'nobody'}, get: () => 'nobody'}).status, 404);
});
