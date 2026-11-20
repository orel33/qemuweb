// The routes of the server's examples (server/routes/examples.js) behind the session router: the list, the
// file for the review, and the load from the server's disk through the same runner commands as an upload
// (fake runner, real express on a loopback port). Rights, names, 404, content checks, audit, busy lock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {Writable, finished} = require('node:stream');
const test = require('node:test');
const express = require('express');
const {createSessionRouter, userEvent} = require('../../server/routes');

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('archive body')]);
const TOPO = '### Two hosts\nSWITCH sw\nHOST debian13-legacy a sw\n';
const settle = () => new Promise(resolve => setImmediate(resolve));
const owner = {user: {login: 'toto', role: 'student'}};
const observer = {user: {login: 'boss', role: 'admin'}, observed: {}};

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-examples-routes-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

// A runner that records its commands and the bytes of the stream sent with archive.import.
function fakeRunner({importError = null} = {}) {
  const sent = [];
  const uploads = [];
  let busyDuringImport = null;
  const runner = {
    sent, uploads,
    get busy() { return busyDuringImport; },
    outgoing() {
      const chunks = [];
      const stream = new Writable({write(chunk, _encoding, done) { chunks.push(chunk); done(); }});
      const entry = {id: 7, stream, chunks, ended: new Promise(resolve => finished(stream, () => resolve()))};
      uploads.push(entry);
      return entry;
    },
    async request(command, args) {
      sent.push([command, args]);
      if (command === 'archive.import') {
        busyDuringImport = runner.session.archiveBusy;
        if (importError) throw importError;
        await uploads.at(-1).ended;
        return {ok: true, hosts: 1, switches: 1, startErrors: [], warnings: []};
      }
      return {created: 2, errors: []};
    }
  };
  return runner;
}

async function serve(t, {who = owner, dir, runner = fakeRunner()}) {
  const session = {owner: 'toto', id: 'sess', archiveBusy: false};
  runner.session = session;
  const userLog = {entries: [], record(...args) { this.entries.push(args); }};
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, who); next(); });
  app.use(createSessionRouter({session, runner, userLog, examplesDir: dir}));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, route, body) => fetch(base + route, {method, headers: {'content-type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  return {call, runner, session, userLog};
}

function populated(t) {
  const dir = directory(t);
  fs.writeFileSync(path.join(dir, 'lan.zip'), ZIP);
  fs.writeFileSync(path.join(dir, 'lan.topo'), TOPO);
  fs.writeFileSync(path.join(dir, 'fake.zip'), 'SWITCH sw\n');
  fs.writeFileSync(path.join(dir, 'fake.topo'), ZIP);
  return dir;
}

test('GET /api/examples lists name, kind, size and description, not cached, nothing else', async t => {
  const {call} = await serve(t, {dir: populated(t)});
  const response = await call('GET', '/api/examples');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const list = await response.json();
  assert.deepEqual(list.map(entry => entry.name), ['fake.topo', 'fake.zip', 'lan.topo', 'lan.zip']);
  assert.deepEqual(list.find(entry => entry.name === 'lan.topo'), {name: 'lan.topo', kind: 'topology', size: TOPO.length, description: 'Two hosts'});
  for (const entry of list) assert.deepEqual(Object.keys(entry).sort(), ['description', 'kind', 'name', 'size']);
  assert.doesNotMatch(JSON.stringify(list), /qemuweb-examples-routes|\/tmp|mtime|uid/);
});

test('a missing examples directory, or none configured, lists nothing', async t => {
  const dir = directory(t);
  assert.deepEqual(await (await (await serve(t, {dir: path.join(dir, 'absent')})).call('GET', '/api/examples')).json(), []);
  assert.deepEqual(await (await (await serve(t, {dir: null})).call('GET', '/api/examples')).json(), []);
});

test('a file added or removed is seen by the next request: the listing is not cached', async t => {
  const dir = directory(t);
  const {call} = await serve(t, {dir});
  assert.deepEqual(await (await call('GET', '/api/examples')).json(), []);
  fs.writeFileSync(path.join(dir, 'late.topo'), TOPO);
  assert.equal((await (await call('GET', '/api/examples')).json()).length, 1);
  assert.equal((await call('POST', '/api/examples/load', {name: 'late.topo'})).status, 200);
  fs.rmSync(path.join(dir, 'late.topo'));
  assert.equal((await call('POST', '/api/examples/load', {name: 'late.topo'})).status, 404);
});

test('an observer cannot load or read an example: 403 and nothing sent to the runner', async t => {
  const {call, runner, userLog} = await serve(t, {who: observer, dir: populated(t)});
  for (const route of ['/api/examples/load', '/api/examples/file']) {
    const response = await call('POST', route, {name: 'lan.zip'});
    assert.equal(response.status, 403, route);
    assert.match((await response.json()).error, /Read-only observation/);
  }
  assert.deepEqual(runner.sent, []);
  assert.deepEqual(userLog.entries, []);
});

test('an unlisted name is a 404, a malformed name a 400, and nothing reaches the runner', async t => {
  const {call, runner} = await serve(t, {dir: populated(t)});
  for (const route of ['/api/examples/load', '/api/examples/file']) {
    assert.equal((await call('POST', route, {name: 'absent.zip'})).status, 404, route);
    assert.equal((await call('POST', route, {name: 'LAN.zip'})).status, 404, route);
    for (const name of ['../lan.zip', '/etc/passwd', 'a/../lan.zip', '.hidden.zip', 'lan.txt', 'lan', '', 'lan.zip\0', 'x'.repeat(200) + '.zip', 7, null, ['lan.zip'], {name: 'lan.zip'}]) {
      assert.equal((await call('POST', route, {name})).status, 400, `${route} ${JSON.stringify(name)}`);
    }
    assert.equal((await call('POST', route, {})).status, 400);
    assert.equal((await call('POST', route)).status, 400);
  }
  assert.deepEqual(runner.sent, []);
});

test('a symbolic link in the directory is a 404, even to a good example', async t => {
  const dir = populated(t);
  fs.symlinkSync(path.join(dir, 'lan.zip'), path.join(dir, 'alias.zip'));
  fs.symlinkSync('/etc/hostname', path.join(dir, 'host.topo'));
  const {call, runner} = await serve(t, {dir});
  assert.deepEqual((await (await call('GET', '/api/examples')).json()).map(entry => entry.name).filter(name => /alias|host/.test(name)), []);
  for (const name of ['alias.zip', 'host.topo']) {
    assert.equal((await call('POST', '/api/examples/load', {name})).status, 404, name);
    assert.equal((await call('POST', '/api/examples/file', {name})).status, 404, name);
  }
  assert.deepEqual(runner.sent, []);
});

test('POST /api/examples/file returns the bytes of a listed example', async t => {
  const {call} = await serve(t, {dir: populated(t)});
  const response = await call('POST', '/api/examples/file', {name: 'lan.zip'});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), ZIP);
  assert.equal(await (await call('POST', '/api/examples/file', {name: 'lan.topo'})).text(), TOPO);
});

test('loading a session example feeds the file from disk into archive.import, like an upload', async t => {
  const {call, runner, session, userLog} = await serve(t, {dir: populated(t)});
  const response = await call('POST', '/api/examples/load', {name: 'lan.zip', autoStart: true, discardDisks: false});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {ok: true, hosts: 1, switches: 1, startErrors: [], warnings: []});
  assert.deepEqual(runner.sent, [['archive.import', {stream: 7, query: {autoStart: 'true', discardDisks: 'false'}, contentType: 'application/zip', declaredBytes: String(ZIP.length)}]]);
  assert.deepEqual(Buffer.concat(runner.uploads[0].chunks), ZIP);
  assert.equal(runner.busy, true, 'the session is locked during the import, as for an upload');
  assert.equal(session.archiveBusy, false, 'and released after it');
  await settle();
  assert.deepEqual(userLog.entries, [['toto', 'archive-loaded', {kind: 'session', example: 'lan.zip'}, 'ok']]);
});

test('the load options of a session example are passed as the upload passes them, and only booleans are accepted', async t => {
  const {call, runner} = await serve(t, {dir: populated(t)});
  assert.equal((await call('POST', '/api/examples/load', {name: 'lan.zip'})).status, 200);
  assert.deepEqual(runner.sent[0][1].query, {});
  for (const bad of [{autoStart: 'true'}, {discardDisks: 1}, {autoStart: null}]) {
    const response = await call('POST', '/api/examples/load', {name: 'lan.zip', ...bad});
    assert.equal(response.status, 400, JSON.stringify(bad));
  }
  assert.equal(runner.sent.length, 1, 'a refused option sends nothing');
});

test('the runner refusal of a session example (not empty, bad archive) is returned with its status and releases the session', async t => {
  const refusal = Object.assign(new Error('Load requires an empty session.'), {status: 409});
  const {call, session, userLog} = await serve(t, {dir: populated(t), runner: fakeRunner({importError: refusal})});
  const response = await call('POST', '/api/examples/load', {name: 'lan.zip'});
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {error: 'Load requires an empty session.'});
  assert.equal(session.archiveBusy, false);
  await settle();
  assert.deepEqual(userLog.entries, [['toto', 'archive-loaded', {kind: 'session', example: 'lan.zip'}, 'error: HTTP 409']]);
});

test('loading a topology example sends its text to topology.load with the options of the dialog', async t => {
  const {call, runner, userLog} = await serve(t, {dir: populated(t)});
  const response = await call('POST', '/api/examples/load', {name: 'lan.topo', engine: 'qemu', autostart: true});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {created: 2, errors: []});
  assert.deepEqual(runner.sent, [['topology.load', {body: {text: TOPO, engine: 'qemu', autostart: true}}]]);
  await settle();
  assert.deepEqual(userLog.entries, [['toto', 'archive-loaded', {kind: 'topology', example: 'lan.topo'}, 'ok']]);
  for (const bad of [{autostart: 'yes'}, {engine: 3}]) {
    assert.equal((await call('POST', '/api/examples/load', {name: 'lan.topo', ...bad})).status, 400, JSON.stringify(bad));
  }
  assert.equal(runner.sent.length, 1);
});

test('a file whose content is not of its kind is refused with a clear message and sent nowhere', async t => {
  const {call, runner} = await serve(t, {dir: populated(t)});
  for (const route of ['/api/examples/load', '/api/examples/file']) {
    const zip = await call('POST', route, {name: 'fake.zip'});
    assert.equal(zip.status, 400);
    assert.match((await zip.json()).error, /fake\.zip: This file is not a ZIP archive/);
    const topo = await call('POST', route, {name: 'fake.topo'});
    assert.equal(topo.status, 400);
    assert.match((await topo.json()).error, /fake\.topo: This file is not a topology/);
  }
  assert.deepEqual(runner.sent, []);
});

test('a file too large for an upload of its kind is not an example', async t => {
  const dir = directory(t);
  fs.writeFileSync(path.join(dir, 'big.topo'), Buffer.alloc(262145, 0x23));
  const {call, runner} = await serve(t, {dir});
  assert.deepEqual(await (await call('GET', '/api/examples')).json(), []);
  assert.equal((await call('POST', '/api/examples/load', {name: 'big.topo'})).status, 404);
  assert.deepEqual(runner.sent, []);
});

test('while an archive operation runs the load of an example is refused like any write', async t => {
  const {call, session, runner} = await serve(t, {dir: populated(t)});
  session.archiveBusy = true;
  assert.equal((await call('POST', '/api/examples/load', {name: 'lan.zip'})).status, 409);
  assert.equal((await call('GET', '/api/examples')).status, 200, 'the list stays readable');
  assert.deepEqual(runner.sent, []);
});

test('the audit event names the example only when its name is well formed', () => {
  const event = body => userEvent({method: 'POST', path: '/api/examples/load', body});
  assert.deepEqual(event({name: 'lan.zip'}), {event: 'archive-loaded', target: {kind: 'session', example: 'lan.zip'}});
  assert.deepEqual(event({name: 'lan.topo'}), {event: 'archive-loaded', target: {kind: 'topology', example: 'lan.topo'}});
  for (const body of [{name: '../../etc/passwd.zip'}, {name: 'a\nb.zip'}, {name: 7}, {}, undefined]) assert.equal(event(body), null);
  assert.equal(userEvent({method: 'GET', path: '/api/examples'}), null);
});
