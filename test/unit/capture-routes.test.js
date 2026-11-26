// Traffic capture, server side: the routes of server/routes/captures.js behind the session router
// (fake runner, real express on a loopback port), the rights of an observer and of an administrator
// holding the control lock, the audit entries, and the observation gate under control (CTL01).
const assert = require('node:assert/strict');
const http = require('node:http');
const {Readable} = require('node:stream');
const test = require('node:test');
const express = require('express');
const settle = () => new Promise(resolve => setImmediate(resolve));
const {createSessionRouter, userEvent, auditEntries} = require('../../server/routes');
const {observationGate} = require('../../server/routes/admin');
const {MAX_DOWNLOAD} = require('../../server/routes/captures');

const HOST = 'h-00000001';
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
  assert.deepEqual(userLog.entries, [
    ['toto', 'capture-started', {nodeId: HOST, interface: 'eth1', by: 'boss'}, 'ok'],
    ['toto', 'capture-deleted', {nodeId: HOST, captureId: CAP, by: 'boss'}, 'ok']], "the owner's users.log says the admin did it");
});

test('CTL01: every write of the admin holding control is audited, the user events in both logs; the saved archive bears the owner\'s name', async t => {
  const runner = {request: async command => (command === 'archive.export' ? {stream: 7, size: 2} : {ok: true}), incoming: () => Readable.from([Buffer.from('PK')])};
  const {call, audit, userLog} = await serve(t, {runner, who: controller});
  assert.equal((await call('POST', '/api/nodes/stop-all')).status, 200);
  assert.equal((await call('POST', `/api/nodes/${HOST}/reboot`)).status, 200);
  assert.equal((await call('GET', '/api/nodes')).status, 200);
  const exported = await call('POST', '/api/session-archive/export', {includeDisks: false});
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /filename="qemuweb-session-toto\.zip"/);
  await exported.arrayBuffer();
  await settle();
  assert.deepEqual(audit.entries, [
    ['boss', 'node-stopped', {login: 'toto', all: true}, 'ok'],
    ['boss', 'controlled-request', {login: 'toto', method: 'POST', path: `/api/nodes/${HOST}/reboot`}, 'ok'],
    ['boss', 'archive-saved', {login: 'toto', kind: 'session'}, 'ok']], 'reads are not audited');
  assert.deepEqual(userLog.entries, [
    ['toto', 'node-stopped', {all: true, by: 'boss'}, 'ok'],
    ['toto', 'archive-saved', {kind: 'session', by: 'boss'}, 'ok']]);
  const own = await serve(t, {runner, who: owner});
  assert.match((await own.call('POST', '/api/session-archive/export', {})).headers.get('content-disposition'), /filename="qemuweb-session\.zip"/);
});

test('auditEntries: the owner, a plain observer and the admin in control', () => {
  const entries = (who, method, path, body) => auditEntries({method, path, body, ...who}, 'toto');
  assert.deepEqual(entries(owner, 'POST', '/api/nodes/stop-all'), [['user', 'toto', 'node-stopped', {all: true}]]);
  assert.deepEqual(entries(owner, 'POST', `/api/nodes/${HOST}/reboot`), [], 'not a user event');
  assert.deepEqual(entries(observer, 'POST', '/api/nodes/stop-all'), []);
  assert.deepEqual(entries(controller, 'GET', '/api/nodes'), []);
  assert.deepEqual(entries(controller, 'PUT', `/api/nodes/${HOST}/config`), [['admin', 'boss', 'controlled-request', {login: 'toto', method: 'PUT', path: `/api/nodes/${HOST}/config`}]]);
  assert.equal(entries(controller, 'POST', `/api/${'x'.repeat(300)}`)[0][3].path.length, 200, 'the path is cut');
});

test('userEvent names the capture events and drops anything that is not an ID', () => {
  const key = (method, path, body) => userEvent({method, path, body});
  assert.deepEqual(key('POST', `/api/nodes/${HOST}/captures`, {interface: 'eth2'}), {event: 'capture-started', target: {nodeId: HOST, interface: 'eth2'}});
  assert.deepEqual(key('POST', `/api/nodes/${HOST}/captures`, {interface: '../etc'}), {event: 'capture-started', target: {nodeId: HOST}});
  assert.deepEqual(key('POST', `/api/nodes/zzz/captures/${CAP}/stop`), {event: 'capture-stopped', target: {nodeId: null, captureId: CAP}});
  assert.equal(key('GET', `/api/nodes/${HOST}/captures`), null);
  assert.equal(key('GET', '/api/captures'), null);
});

test('the observation gate admits every request of the admin holding the control lock, marked as control; reads only without it', () => {
  const workspace = {owner: 'toto', session: {id: 'sess'}};
  const manager = {get: login => (login === 'toto' ? workspace : null)};
  const held = new Set();
  const gate = observationGate(manager, {control: {admin: sessionId => ([...held].find(key => key.startsWith(`${sessionId}:`)) || '').split(':')[1] || null, touch: () => {}}});
  const run = options => {
    const lower = {'x-observe': 'toto'};
    const req = {method: 'GET', path: '/api/nodes', headers: lower, user: {login: 'boss', role: 'admin'}, get: name => lower[name.toLowerCase()], ...options};
    const res = {statusCode: 200, status(code) { this.statusCode = code; return this; }, json() { return this; }};
    let passed = false;
    gate(req, res, () => { passed = true; });
    return {passed, status: res.statusCode, req};
  };
  const requests = [['POST', `/api/nodes/${HOST}/captures`], ['POST', `/api/nodes/${HOST}/captures/${CAP}/stop`],
    ['DELETE', `/api/nodes/${HOST}/captures/${CAP}`], ['GET', `/api/nodes/${HOST}/captures/${CAP}/download`], ['GET', '/api/captures'],
    ['POST', `/api/nodes/${HOST}/start`], ['DELETE', `/api/nodes/${HOST}`], ['POST', '/api/nodes/stop-all'], ['PUT', `/api/nodes/${HOST}/config`]];
  // Without the lock: writes refused, reads pass without the control mark (the capture routes then refuse them).
  for (const [method, path] of requests) {
    const result = run({method, path});
    assert.equal(result.passed, method === 'GET', `${method} ${path} without lock`);
    if (method !== 'GET') assert.equal(result.status, 403);
    else assert.equal(result.req.observedControl, undefined);
  }
  held.add('sess:boss');
  for (const [method, path] of requests) {
    const result = run({method, path});
    assert.equal(result.passed, true, `${method} ${path} with lock`);
    assert.equal(result.req.observedControl, true);
    assert.equal(result.req.observed, workspace);
  }
  // Another admin, or the lock of another session, gives nothing.
  assert.equal(run({method: 'POST', path: `/api/nodes/${HOST}/captures`, user: {login: 'other', role: 'admin'}}).status, 403);
  assert.equal(run({method: 'GET', path: `/api/nodes/${HOST}/captures`, user: {login: 'other', role: 'admin'}}).req.observedControl, undefined);
  // The mounted gate sees paths relative to /api; Reset session is allowed to the admin holding the lock (UXS02).
  assert.equal(run({method: 'POST', baseUrl: '/api', path: `/nodes/${HOST}/captures`}).passed, true);
  assert.equal(run({method: 'POST', baseUrl: '/api', path: '/session/reset'}).passed, true);
  // The observation of an unknown user is still 404 for a read and 403 for a write.
  assert.equal(run({headers: {'x-observe': 'nobody'}, get: () => 'nobody'}).status, 404);
});
