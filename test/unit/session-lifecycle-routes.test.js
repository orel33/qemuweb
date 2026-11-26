// UXS02, server side: the routes of the session lifecycle behind the session router (fake runner and
// lifecycle, real express on a loopback port). A route that creates nodes places the session first
// (503 without a runner, nothing sent), a route that may leave it empty releases it once the creation
// ended, and Reset session is the owner's or the controlling admin's, audited as session-reset.
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const {createSessionRouter} = require('../../server/routes');

const HOST = 'h-00000001';
const session = {owner: 'toto', id: 'sess'};

async function serve(t, {who, place = async () => {}, fail = null}) {
  const calls = [];
  let creations = 0;
  const runner = {request: async (command, args) => {
    calls.push(['runner', command, creations]);
    if (fail === command) throw Object.assign(new Error('refused'), {status: 409});
    return {ok: true, args};
  }};
  const lifecycle = {
    begin() { creations += 1; calls.push(['begin']); let ended = false; return () => { if (!ended) { ended = true; creations -= 1; calls.push(['end']); } }; },
    place: async () => { calls.push(['place']); await place(); },
    release: async () => { calls.push(['release', creations]); },
    reset: async by => { calls.push(['reset', by]); return {reset: true}; }
  };
  const userLog = {entries: [], record(...args) { this.entries.push(args); }};
  const audit = {entries: [], record(...args) { this.entries.push(args); }};
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, who); next(); });
  app.use(createSessionRouter({session, runner, userLog, audit, lifecycle}));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body) => fetch(base + path, {method, headers: {'content-type': 'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {})});
  return {call, calls, userLog, audit, creations: () => creations};
}

const owner = {user: {login: 'toto', role: 'student'}};
const controller = {user: {login: 'boss', role: 'admin'}, observed: {}, observedControl: true};
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('a node creation places the session first; its release (a failed first node) runs only once the creation ended', async t => {
  const {call, calls, creations} = await serve(t, {who: owner});
  assert.equal((await call('POST', '/api/switches', {id: 's-00000001', name: 'sw1'})).status, 200);
  assert.equal((await call('POST', '/api/hosts', {id: HOST})).status, 200);
  await settle();
  assert.deepEqual(calls, [['begin'], ['place'], ['runner', 'switch.create', 1], ['end'], ['release', 0],
    ['begin'], ['place'], ['runner', 'host.create', 1], ['end'], ['release', 0]]);
  assert.equal(creations(), 0);
});

test('without a runner a creation answers 503 and sends nothing to a runner', async t => {
  const {call, calls, creations} = await serve(t, {who: owner,
    place: async () => { throw Object.assign(new Error('No runner is available.'), {status: 503}); }});
  const response = await call('POST', '/api/topology', {text: 'SWITCH sw1'});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {error: 'No runner is available.'});
  assert.deepEqual(calls.filter(([kind]) => kind === 'runner'), []);
  assert.equal(creations(), 0);
});

test('removing a node, or a load that failed, releases the session (empty or not, the manager decides)', async t => {
  const {call, calls} = await serve(t, {who: owner, fail: 'topology.load'});
  assert.equal((await call('DELETE', `/api/nodes/${HOST}`)).status, 200);
  assert.equal((await call('POST', '/api/topology', {text: 'SWITCH sw1'})).status, 409);
  assert.deepEqual(calls, [['runner', 'node.delete', 0], ['release', 0], ['begin'], ['place'], ['runner', 'topology.load', 1], ['end'], ['release', 0]]);
  assert.equal((await call('DELETE', '/api/nodes')).status, 404, 'no route removes every node: Reset session does');
});

test('Reset session: the owner, audited in users.log; the admin holding control, audited in both logs', async t => {
  const mine = await serve(t, {who: owner});
  assert.equal((await mine.call('POST', '/api/session/reset')).status, 200);
  await settle();
  assert.deepEqual(mine.calls, [['reset', 'toto']]);
  assert.deepEqual(mine.userLog.entries, [['toto', 'session-reset', {}, 'ok']]);
  const theirs = await serve(t, {who: controller});
  assert.deepEqual(await (await theirs.call('POST', '/api/session/reset')).json(), {reset: true});
  await settle();
  assert.deepEqual(theirs.calls, [['reset', 'boss']]);
  assert.deepEqual(theirs.audit.entries, [['boss', 'session-reset', {login: 'toto'}, 'ok']]);
  assert.deepEqual(theirs.userLog.entries, [['toto', 'session-reset', {by: 'boss'}, 'ok']]);
  assert.equal((await theirs.call('DELETE', '/api/session')).status, 404, 'the former Delete session route is gone');
});
