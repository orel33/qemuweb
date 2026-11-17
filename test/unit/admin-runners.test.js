// The runners panel API (server/routes/admin-runners.js): summaries, registration tokens, pause,
// resume, revoke and remove, each audited; and POST /api/runner/register (routes/runner-register.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const {EventEmitter} = require('node:events');
const {RunnerRegistry} = require('../../server/runner-registry');
const {createRunnerStore} = require('../../server/runner-store');
const {createRegistrationTokens} = require('../../server/runner-registration');
const {createRunnersRouter, runnerSummaries, connectHint, publicOrigin} = require('../../server/routes/admin-runners');
const {createRegisterRouter, createRateLimiter} = require('../../server/routes/runner-register');

const fakeClient = () => Object.assign(new EventEmitter(), {close() { this.emit('close', null); }});

// An HTTP server around the router, as admin.js mounts it (same `audited` contract).
async function setup(t, {trustProxy = false} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-adminr-'));
  const registry = new RunnerRegistry();
  const store = createRunnerStore(path.join(dir, 'runners.json'));
  const tokens = createRegistrationTokens();
  const workspaces = [];
  const manager = {registry, list: () => workspaces};
  const audit = [];
  const audited = async (req, res, action, target, run, status = () => 400) => {
    try { const result = await run(); audit.push({admin: req.user.login, action, target, result: 'ok'}); res.json(result); }
    catch (error) { audit.push({admin: req.user.login, action, target, result: `error: ${error.message}`}); res.status(error.status || status(error)).json({error: error.message}); }
  };
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(express.json());
  app.use((req, _res, next) => { req.user = {login: 'boss', role: 'admin'}; next(); });
  app.use('/api/runner/register', createRegisterRouter({tokens, store, audit: {record: (admin, action, target, result) => audit.push({admin, action, target, result})}}));
  app.use('/runners', createRunnersRouter({manager, store, tokens, audited, port: 3002, graceSeconds: 300, trustProxy}));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); fs.rmSync(dir, {recursive: true, force: true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, {method, headers: {'Content-Type': 'application/json', ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: response.status, body: await response.json()};
  };
  return {registry, store, tokens, workspaces, audit, call};
}

test('no runner: an empty list and the command to start one', async t => {
  const {call} = await setup(t);
  const {body} = await call('GET', '/runners');
  assert.deepEqual([body.runners, body.connectHint, body.registrationTokens, body.runnerGraceSeconds, body.lifetimes], [[], './scripts/runner.sh', [], 300, [15, 60, 1440]]);
  assert.equal(connectHint({runners: [], port: 4100, runtime: '/rt'}), './scripts/runner.sh --port 4100 --runtime /rt');
});

test('summaries: the local runner while connected, then the registered remote runners with their state', async t => {
  const {registry, store, call, workspaces} = await setup(t);
  const local = fakeClient();
  registry.add({id: 'local', client: local, local: true, trusted: true});
  local.emit('hello', {engines: ['qemu'], kvm: true, cpus: 8, memoryBytes: 16 * 2 ** 30, images: {debian: {}, alpine: {}}, warnings: ['x: missing']});
  const {record} = store.add({name: '<b>far</b>'});
  workspaces.push({session: {runnerId: 'local'}}, {session: {runnerId: record.id}});
  let {body} = await call('GET', '/runners');
  assert.equal(body.connectHint, null);
  assert.deepEqual(body.runners[0], {id: 'local', name: 'local', local: true, state: 'online', paused: false, lastSeen: null, address: null, engines: ['qemu'], kvm: true,
    cpus: 8, memoryBytes: 16 * 2 ** 30, systems: ['alpine', 'debian'], warnings: ['x: missing'], sessions: 1, maxSessions: null});
  assert.deepEqual([body.runners[1].name, body.runners[1].state, body.runners[1].local, body.runners[1].sessions], ['<b>far</b>', 'offline', false, 1]);
  const remote = fakeClient();
  registry.add({id: record.id, client: remote, name: record.name, address: '10.0.0.5'});
  remote.emit('hello', {engines: ['vbox'], limits: {maxSessions: 4}});
  body = (await call('GET', '/runners')).body;
  assert.deepEqual([body.runners[1].state, body.runners[1].address, body.runners[1].maxSessions], ['online', '10.0.0.5', 4]);
  local.close();
  assert.equal(runnerSummaries({registry, manager: {list: () => []}}).length, 0, 'a lost local runner is not listed');
});

test('a registration token: created once with its command, listed without the secret, single use, audited without the token', async t => {
  const {call, audit} = await setup(t);
  const created = await call('POST', '/runners/registration-tokens', {minutes: 60});
  assert.equal(created.status, 200);
  assert.match(created.body.command, new RegExp(`^\\./scripts/runner\\.sh register --url http://127\\.0\\.0\\.1:\\d+ --token ${created.body.token}$`));
  const listed = (await call('GET', '/runners')).body.registrationTokens;
  assert.equal(listed.length, 1);
  assert.ok(!JSON.stringify(listed).includes(created.body.token));
  assert.equal((await call('POST', '/runners/registration-tokens', {minutes: 5})).status, 400);
  assert.ok(!JSON.stringify(audit).includes(created.body.token), 'the token is not in the audit');
  assert.deepEqual(audit[0], {admin: 'boss', action: 'create-runner-token', target: {minutes: 60}, result: 'ok'});
  assert.equal((await call('DELETE', `/runners/registration-tokens/${listed[0].id}`)).status, 200);
  assert.equal((await call('DELETE', `/runners/registration-tokens/${listed[0].id}`)).status, 404);
});

test('the registration command honours X-Forwarded-Proto and -Host only behind a trusted proxy', async t => {
  const forwarded = {'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'qemuweb.example.org'};
  const trusted = await setup(t, {trustProxy: true});
  assert.match((await trusted.call('POST', '/runners/registration-tokens', {minutes: 15}, forwarded)).body.command, /--url https:\/\/qemuweb\.example\.org --token/);
  const plain = await setup(t);
  assert.match((await plain.call('POST', '/runners/registration-tokens', {minutes: 15}, forwarded)).body.command, /--url http:\/\/127\.0\.0\.1:\d+ --token/);
  assert.equal(publicOrigin({get: name => ({host: 'a b'})[name], protocol: 'http'}, false), '<server URL>');
});

test('registration: the token buys an identity once; a wrong or reused token is refused; attempts are limited', async t => {
  const {call, tokens, store, audit} = await setup(t);
  const {token} = tokens.create({minutes: 15, by: 'boss'});
  const registered = await call('POST', '/api/runner/register', {token, name: 'salle-12'});
  assert.equal(registered.status, 200);
  assert.match(registered.body.runnerId, /^r-[0-9a-f]{8}$/);
  assert.equal(store.verify(registered.body.runnerId, registered.body.authToken).name, 'salle-12');
  assert.deepEqual(audit.at(-1), {admin: 'boss', action: 'register-runner', target: {runnerId: registered.body.runnerId, name: 'salle-12'}, result: 'ok'});
  assert.equal((await call('POST', '/api/runner/register', {token})).status, 403, 'single use');
  assert.equal((await call('POST', '/api/runner/register', {})).status, 403);
  const allow = createRateLimiter({max: 2, windowMs: 1000, now: () => 0});
  assert.deepEqual([allow('a'), allow('a'), allow('a'), allow('b')], [true, true, false, true]);
});

test('pause and resume (the local runner too), revoke disconnects, remove needs an offline revoked runner; all audited', async t => {
  const {registry, store, call, audit} = await setup(t);
  const local = fakeClient();
  registry.add({id: 'local', client: local, local: true, trusted: true});
  const {record} = store.add({name: 'far'});
  const remote = fakeClient();
  registry.add({id: record.id, client: remote, name: 'far'});
  remote.emit('hello', {engines: ['qemu']});
  assert.equal((await call('POST', '/runners/local/pause')).body.paused, true);
  assert.equal(registry.get('local').paused, true);
  assert.equal((await call('POST', `/runners/${record.id}/pause`)).body.paused, true);
  assert.equal(store.get(record.id).paused, true);
  assert.equal((await call('POST', `/runners/${record.id}/resume`)).body.paused, false);
  assert.ok(!store.get(record.id).paused);
  assert.equal((await call('POST', '/runners/local/revoke')).status, 403);
  assert.equal((await call('DELETE', '/runners/local')).status, 403);
  assert.equal((await call('POST', '/runners/r-00000000/pause')).status, 404);
  assert.equal((await call('DELETE', `/runners/${record.id}`)).status, 409, 'not revoked');
  const revoked = await call('POST', `/runners/${record.id}/revoke`);
  assert.equal(revoked.body.state, 'revoked');
  assert.equal(registry.get(record.id).state, 'lost', 'disconnected');
  assert.equal(store.verify(record.id, 'anything'), null);
  assert.equal((await call('DELETE', `/runners/${record.id}`)).status, 200);
  assert.equal(store.count(), 0);
  assert.equal(registry.get(record.id), null);
  const actions = audit.map(entry => entry.action);
  for (const action of ['pause-runner', 'resume-runner', 'revoke-runner', 'remove-runner']) assert.ok(actions.includes(action), `${action} audited`);
  assert.ok(audit.every(entry => entry.admin === 'boss'));
  assert.ok(audit.some(entry => entry.action === 'revoke-runner' && entry.result.startsWith('error')), 'refusals are audited too');
});
