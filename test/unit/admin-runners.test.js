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
const {createRunnersRouter, connectHint, publicOrigin} = require('../../server/routes/admin-runners');
const {createRegisterRouter, createRateLimiter} = require('../../server/routes/runner-register');

const fakeClient = () => Object.assign(new EventEmitter(), {close() { this.emit('close', null); }});

// An HTTP server around the router, as admin.js mounts it (same `audited` contract).
async function setup(t, {trustProxy = false, localRunner = true} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-adminr-'));
  const registry = new RunnerRegistry();
  const store = createRunnerStore(path.join(dir, 'runners.json'));
  const tokens = createRegistrationTokens();
  const workspaces = [];
  // What the router uses of the SessionManager: the sessions per runner, the grace left, the forced drop.
  const graces = new Map();
  const dropped = [];
  const manager = {registry, list: () => workspaces, graceLeft: id => graces.get(id) ?? null,
    sessionsOf: id => workspaces.filter(workspace => workspace.session.runnerId === id).length,
    dropRunnerSessions(id, reason) {
      const mine = workspaces.filter(workspace => workspace.session.runnerId === id);
      for (const workspace of mine) workspaces.splice(workspaces.indexOf(workspace), 1);
      dropped.push([id, reason, mine.length]);
      return mine.length;
    }};
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
  app.use('/runners', createRunnersRouter({manager, store, tokens, audited, port: 3002, graceSeconds: 300, trustProxy, localRunner}));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); fs.rmSync(dir, {recursive: true, force: true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, {method, headers: {'Content-Type': 'application/json', ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: response.status, body: await response.json()};
  };
  return {registry, store, tokens, workspaces, audit, call, graces, dropped};
}

test('no runner: an empty list and the command to start one', async t => {
  const {call} = await setup(t);
  const {body} = await call('GET', '/runners');
  assert.deepEqual([body.runners, body.connectHint, body.registrationTokens, body.runnerGraceSeconds, body.lifetimes], [[], './scripts/runner.sh', [], 300, [15, 60, 1440]]);
  assert.equal(connectHint({runners: [], port: 4100, runtime: '/rt', localRunner: true}), './scripts/runner.sh --port 4100 --token-file /rt/local-runner.token');
  assert.equal(connectHint({runners: [], port: 3002, localRunner: true}), './scripts/runner.sh');
  assert.equal(connectHint({runners: [], port: 4100, runtime: '/rt'}), null, 'a server without --local-runner has no local runner to start');
});

test('summaries: every registered runner, "local" included, with the same fields and no flag, token or hash', async t => {
  const {registry, store, call, workspaces} = await setup(t);
  const localRecord = store.ensureLocal();
  const local = fakeClient();
  registry.add({id: 'local', client: local, name: localRecord.name, registeredAt: Date.parse(localRecord.createdAt)});
  local.emit('hello', {engines: ['qemu'], kvm: true, cpus: 8, memoryBytes: 16 * 2 ** 30, images: {debian: {}, alpine: {}}, warnings: ['x: missing'], runtimeRoot: '/tmp/qw/3002', pid: 4242});
  const {record} = store.add({name: '<b>far</b>'});
  workspaces.push({session: {runnerId: 'local'}}, {session: {runnerId: record.id}});
  let {body} = await call('GET', '/runners');
  assert.equal(body.connectHint, null);
  assert.deepEqual(body.runners[0], {id: 'local', name: 'local', state: 'online', paused: false, lastSeen: null, address: null, directory: '/tmp/qw/3002', pid: 4242, engines: ['qemu'], kvm: true,
    cpus: 8, memoryBytes: 16 * 2 ** 30, systems: ['alpine', 'debian'], warnings: ['x: missing'], sessions: 1, maxSessions: null, graceLeft: null});
  assert.deepEqual(Object.keys(body.runners[1]), Object.keys(body.runners[0]), 'the same fields for every row');
  assert.deepEqual([body.runners[1].name, body.runners[1].state, body.runners[1].sessions], ['<b>far</b>', 'offline', 1]);
  const text = JSON.stringify(body);
  assert.ok(!/"(local|trusted|tokenHash|transport)"\s*:/.test(text) && !text.includes(store.list()[1].tokenHash), 'no flag, no token hash');
  const remote = fakeClient();
  registry.add({id: record.id, client: remote, name: record.name, address: '10.0.0.5'});
  remote.emit('hello', {engines: ['vbox'], limits: {maxSessions: 4}});
  body = (await call('GET', '/runners')).body;
  assert.deepEqual([body.runners[1].state, body.runners[1].address, body.runners[1].maxSessions], ['online', '10.0.0.5', 4]);
  local.close();
  body = (await call('GET', '/runners')).body;
  assert.deepEqual([body.runners[0].id, body.runners[0].state, body.runners[0].directory, body.runners[0].pid, body.runners[0].address], ['local', 'offline', null, null, null], 'a lost local runner stays listed, offline');
  assert.equal(body.connectHint, null, 'another runner is online');
  remote.close();
  assert.equal((await call('GET', '/runners')).body.connectHint, './scripts/runner.sh', 'no runner online: the hint');
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

test('pause, resume, revoke and forget work the same for "local" and for a remote runner; all audited', async t => {
  const {registry, store, call, audit} = await setup(t);
  store.ensureLocal();
  const local = fakeClient();
  registry.add({id: 'local', client: local, name: 'local'});
  const {record} = store.add({name: 'far'});
  const remote = fakeClient();
  registry.add({id: record.id, client: remote, name: 'far'});
  remote.emit('hello', {engines: ['qemu']});
  assert.equal((await call('POST', '/runners/local/pause')).body.paused, true);
  assert.equal(registry.get('local').paused, true);
  assert.equal(store.get('local').paused, true, 'the pause of "local" is written to runners.json');
  assert.equal(createRunnerStore(store.file).get('local').paused, true, 'and survives a server restart');
  assert.equal((await call('POST', '/runners/local/resume')).body.paused, false);
  assert.ok(!store.get('local').paused);
  assert.equal((await call('POST', `/runners/${record.id}/pause`)).body.paused, true);
  assert.equal(store.get(record.id).paused, true);
  assert.equal((await call('POST', `/runners/${record.id}/resume`)).body.paused, false);
  assert.ok(!store.get(record.id).paused);
  assert.equal((await call('POST', '/runners/r-00000000/pause')).status, 404);
  assert.equal((await call('POST', '/runners/remote/pause')).status, 404, 'an invalid id');
  assert.equal((await call('DELETE', `/runners/${record.id}`)).status, 409, 'not revoked');
  assert.equal((await call('DELETE', '/runners/local')).status, 409, 'local is not revoked either');
  const revoked = await call('POST', `/runners/${record.id}/revoke`);
  assert.equal(revoked.body.state, 'revoked');
  assert.equal(registry.get(record.id).state, 'lost', 'disconnected');
  assert.equal(store.verify(record.id, 'anything'), null);
  assert.equal((await call('DELETE', `/runners/${record.id}`)).status, 200);
  assert.equal(store.get(record.id), null);
  assert.equal(registry.get(record.id), null);
  const revokedLocal = await call('POST', '/runners/local/revoke');
  assert.equal(revokedLocal.status, 200);
  assert.equal(revokedLocal.body.state, 'revoked');
  assert.equal(registry.get('local').state, 'lost', 'the connection of "local" is closed');
  assert.equal(store.get('local').revoked, true);
  assert.equal((await call('DELETE', '/runners/local')).status, 200);
  assert.equal(store.count(), 0);
  assert.equal(registry.get('local'), null);
  const actions = audit.map(entry => entry.action);
  for (const action of ['pause-runner', 'resume-runner', 'revoke-runner', 'remove-runner']) assert.ok(actions.includes(action), `${action} audited`);
  assert.ok(audit.every(entry => entry.admin === 'boss'));
  assert.ok(audit.some(entry => entry.action === 'remove-runner' && entry.result.startsWith('error')), 'refusals are audited too');
});

test('revoking a runner drops its sessions at once, without waiting for the grace period', async t => {
  const {registry, store, call, workspaces, dropped, audit} = await setup(t);
  const {record} = store.add({name: 'far'});
  const remote = fakeClient();
  registry.add({id: record.id, client: remote, name: 'far'});
  remote.emit('hello', {engines: ['qemu']});
  workspaces.push({session: {runnerId: record.id}}, {session: {runnerId: 'local'}});
  assert.equal((await call('POST', `/runners/${record.id}/revoke`)).status, 200);
  assert.deepEqual(dropped, [[record.id, 'runner lost', 1]], 'only the sessions of that runner, with the usual reason');
  assert.equal(workspaces.length, 1);
  assert.deepEqual(audit.at(-1), {admin: 'boss', action: 'revoke-runner', target: {runnerId: record.id}, result: 'ok'});
});

test('forced loss: drops the sessions of an offline runner at once, refused while it is online, audited with the count', async t => {
  const {registry, store, call, workspaces, dropped, audit, graces} = await setup(t);
  store.ensureLocal();
  const {record} = store.add({name: 'far'});
  const remote = fakeClient();
  registry.add({id: record.id, client: remote, name: 'far'});
  remote.emit('hello', {engines: ['qemu']});
  workspaces.push({session: {runnerId: record.id}}, {session: {runnerId: record.id}}, {session: {runnerId: 'local'}});
  const online = await call('POST', `/runners/${record.id}/drop-sessions`);
  assert.equal(online.status, 409);
  assert.match(online.body.error, /online/);
  assert.equal(workspaces.length, 3, 'nothing was dropped');
  remote.close();
  graces.set(record.id, 120);
  let {body} = await call('GET', '/runners');
  assert.deepEqual([body.runners[1].state, body.runners[1].sessions, body.runners[1].graceLeft], ['offline', 2, 120], 'the seconds left are shown');
  assert.equal(body.runners[0].graceLeft, null);
  const forced = await call('POST', `/runners/${record.id}/drop-sessions`);
  assert.equal(forced.status, 200);
  assert.equal(forced.body.dropped, 2);
  assert.deepEqual(dropped, [[record.id, 'runner lost', 2]]);
  assert.equal(forced.body.runner.sessions, 0);
  assert.deepEqual(audit.at(-1), {admin: 'boss', action: 'drop-runner-sessions', target: {runnerId: record.id, sessions: 2}, result: 'ok'});
  assert.ok(!/token|hash/i.test(JSON.stringify(audit.at(-1))), 'no secret in the audit line');
  assert.equal((await call('POST', '/runners/r-00000000/drop-sessions')).status, 404, 'an unknown runner');
  assert.equal((await call('POST', '/runners/remote/drop-sessions')).status, 404, 'an invalid id');
  // A runner that never connected since the server start (only restored sessions) is offline too.
  workspaces.push({session: {runnerId: 'local'}});
  assert.equal((await call('POST', '/runners/local/drop-sessions')).body.dropped, 2);
  body = (await call('GET', '/runners')).body;
  assert.equal(body.runners[0].sessions, 0);
});
