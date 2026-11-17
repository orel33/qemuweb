// GET /api/admin/runners (server/routes/admin-runners.js): the summaries and the connect hint.
const assert = require('node:assert/strict');
const test = require('node:test');
const {EventEmitter} = require('node:events');
const {RunnerRegistry} = require('../../server/runner-registry');
const {runnersHandler, runnerSummaries, connectHint} = require('../../server/routes/admin-runners');

function fakeClient() {
  return Object.assign(new EventEmitter(), {close() { this.emit('close', null); }});
}

function call(handler) {
  let body = null;
  handler({}, {json: value => { body = value; }});
  return body;
}

test('no runner: an empty list and the command to start one (it is the same for every server)', () => {
  const registry = new RunnerRegistry();
  const manager = {registry, list: () => []};
  assert.deepEqual(call(runnersHandler({manager, port: 3002})), {runners: [], connectHint: './scripts/runner.sh'});
  assert.equal(call(runnersHandler({manager, port: 4100})).connectHint, 'PORT=4100 ./scripts/runner.sh');
});

test('an online runner: capabilities, warnings and the number of its sessions', () => {
  const registry = new RunnerRegistry();
  const client = fakeClient();
  registry.add({id: 'local', client, trusted: true});
  assert.equal(runnerSummaries({registry, manager: {list: () => []}})[0].state, 'starting');
  client.emit('hello', {engines: ['qemu'], kvm: true, cpus: 8, memoryBytes: 16 * 2 ** 30, images: {debian: {}, alpine: {}}, warnings: ['x: missing'], runtimeRoot: '/r'});
  const workspaces = [{session: {runnerId: 'local'}}, {session: {runnerId: 'local'}}, {session: {runnerId: 'other'}}];
  const manager = {registry, list: () => workspaces};
  const body = call(runnersHandler({manager, port: 3002}));
  assert.deepEqual(body, {connectHint: null, runners: [{id: 'local', state: 'online', engines: ['qemu'], kvm: true, cpus: 8,
    memoryBytes: 16 * 2 ** 30, systems: ['alpine', 'debian'], warnings: ['x: missing'], sessions: 2}]});
  assert.equal(connectHint({runners: body.runners, port: 3002}), null, 'a runner is online');
});

test('a lost runner is not listed', () => {
  const registry = new RunnerRegistry();
  const client = fakeClient();
  registry.add({id: 'local', client});
  client.close();
  assert.deepEqual(runnerSummaries({registry, manager: {list: () => []}}), []);
});
