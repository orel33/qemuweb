// A capture lasts as long as the Capture dialog of the tab that started it (server/capture-lease.js):
// the lease of a capture belongs to one socket, other tabs can list the leases but not take them,
// and when the socket closes the runner is told to stop and delete what it leased. A fake socket
// and a fake runner; nothing is started.
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const test = require('node:test');
const {attachCaptureLease, MAX_LEASES} = require('../../server/capture-lease');
const {captureId, isCaptureId} = require('../../common/capture');

const HOST = 'h-0123456789abcdef';
// Capture IDs as the runner builds them (common/capture.js captureId), not typed by hand: the lease
// checks the same format as the live view and the routes, and does not look a capture up (the dialog
// leases right after Start, before any list could know the capture).
const at = seconds => new Date(Date.UTC(2026, 10, 20, 10, 15, seconds));
const CAP = captureId(0, at(30));
const CAP2 = captureId(1, at(31));

function tab({leases = new Map(), allowed = true, id = 's1'} = {}) {
  const socket = new EventEmitter();
  socket.id = id;
  const runner = {requests: [], async request(command, args) { this.requests.push([command, args]); if (this.fail === command) throw new Error('gone'); return {}; }};
  const recorded = [];
  attachCaptureLease(socket, {runner, guard: handler => handler, allowed: () => allowed, leases, record: entry => recorded.push(entry)});
  const ask = (event, request) => new Promise(resolve => socket.emit(event, request, resolve));
  return {socket, runner, recorded, ask, leases};
}

test('the IDs the runner builds are accepted, right after Start, and the ones the real code would refuse are not', async () => {
  const one = tab();
  for (const id of [CAP, captureId(2, at(0)), captureId(3, at(59), 1), captureId(0, at(30), 12)]) {
    assert.equal(isCaptureId(id), true, id);
    assert.deepEqual(await one.ask('capture-lease', {nodeId: HOST, captureId: id}), {ok: true}, id);
  }
  // The format of the live view and the routes: anything else is unknown, whatever the node.
  for (const id of ['eth0-20260101-000000', 'eth4-20261120T101530Z', 'eth0-20261120T101530Z-0', 'eth0-20261120T101530Z.pcap', 'ETH0-20261120T101530Z']) {
    assert.match((await one.ask('capture-lease', {nodeId: HOST, captureId: id})).error, /Unknown capture/, id);
  }
});

test('a lease is refused to an observer without control and for malformed requests', async () => {
  const observer = tab({allowed: false});
  assert.match((await observer.ask('capture-lease', {nodeId: HOST, captureId: CAP})).error, /Read-only observation/);
  assert.match((await observer.ask('capture-leased', {nodeId: HOST})).error, /Read-only observation/);
  const owner = tab();
  for (const request of [null, {nodeId: 1, captureId: CAP}, {nodeId: 'a/b', captureId: CAP}, {nodeId: HOST, captureId: '../x'}, {nodeId: 'h'.repeat(65), captureId: CAP}]) {
    assert.match((await owner.ask('capture-lease', request)).error, /Unknown capture/);
  }
  assert.equal(owner.leases.size, 0);
});

test('a lease belongs to one tab: another tab lists it but cannot take it', async () => {
  const leases = new Map();
  const first = tab({leases, id: 's1'});
  const second = tab({leases, id: 's2'});
  assert.deepEqual(await first.ask('capture-lease', {nodeId: HOST, captureId: CAP}), {ok: true});
  assert.deepEqual(await first.ask('capture-lease', {nodeId: HOST, captureId: CAP}), {ok: true}, 'again, by its tab');
  assert.match((await second.ask('capture-lease', {nodeId: HOST, captureId: CAP})).error, /another window/);
  assert.deepEqual(await second.ask('capture-leased', {nodeId: HOST}), {leased: [CAP]});
  assert.deepEqual(await second.ask('capture-leased', {nodeId: 'h-ffffffffffffffff'}), {leased: []});
  second.socket.emit('capture-unlease', {nodeId: HOST, captureId: CAP});
  assert.equal(leases.size, 1, 'another tab cannot release it');
  first.socket.emit('capture-unlease', {nodeId: HOST, captureId: CAP});
  assert.equal(leases.size, 0);
});

test('the number of leases of one tab is limited', async () => {
  const one = tab();
  const nth = index => captureId(0, new Date(Date.UTC(2026, 0, 1) + index * 1000));
  for (let index = 0; index < MAX_LEASES; index++) assert.deepEqual(await one.ask('capture-lease', {nodeId: HOST, captureId: nth(index)}), {ok: true});
  assert.match((await one.ask('capture-lease', {nodeId: HOST, captureId: nth(MAX_LEASES)})).error, /Too many/);
  assert.deepEqual(await one.ask('capture-lease', {nodeId: HOST, captureId: nth(0)}), {ok: true}, 'a lease it already has is not a new one');
});

test('when the socket closes its captures are stopped then deleted, those of other tabs are not', async () => {
  const leases = new Map();
  const first = tab({leases, id: 's1'});
  const second = tab({leases, id: 's2'});
  await first.ask('capture-lease', {nodeId: HOST, captureId: CAP});
  await second.ask('capture-lease', {nodeId: HOST, captureId: CAP2});
  first.socket.emit('disconnect');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(first.runner.requests, [['capture.stop', {nodeId: HOST, captureId: CAP}], ['capture.delete', {nodeId: HOST, captureId: CAP}]]);
  assert.deepEqual([...leases.keys()], [`${HOST}/${CAP2}`], 'the lease of the other tab stays');
  assert.deepEqual(first.recorded, [{nodeId: HOST, captureId: CAP}]);
  assert.deepEqual(second.runner.requests, []);
});

test('a capture already stopped or gone does not stop the cleanup of the others', async () => {
  const one = tab();
  one.runner.fail = 'capture.stop';
  await one.ask('capture-lease', {nodeId: HOST, captureId: CAP});
  await one.ask('capture-lease', {nodeId: HOST, captureId: CAP2});
  one.socket.emit('disconnect');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(one.runner.requests.map(([command]) => command), ['capture.stop', 'capture.delete', 'capture.stop', 'capture.delete']);
  assert.equal(one.leases.size, 0);
});
