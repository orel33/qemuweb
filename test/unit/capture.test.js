// Traffic capture, runner side (runner/capture.js, runner/commands/captures.js, runner/pcap.js,
// common/capture.js) with a fake QEMU monitor: no emulator is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const test = require('node:test');
const {LIMITS, isCaptureId, interfaceIndex, captureId} = require('../../common/capture');
const {createCapture} = require('../../runner/capture');
const {completeLength} = require('../../runner/pcap');
const {commands} = require('../../runner/commands/captures');

const HOST = 'h-00000001';
const SWITCH = 's-00000001';

// A fake monitor that behaves like QEMU's: object_add creates the file (unless told to fail
// silently, as QEMU does for a bad netdev or path), object_del forgets the filter.
function setup({engine = 'qemu', running = true, nics = [{switchId: SWITCH}, {switchId: null}], silent = false} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-cap-'));
  const node = {id: HOST, kind: 'host', engine, runtimeDir: path.join(dir, HOST), machine: running ? {} : null, action: null, stopping: false,
    activeConfig: {networkInterfaces: nics}};
  fs.mkdirSync(node.runtimeDir, {recursive: true});
  const sent = [];
  const filters = new Set();
  const monitor = {async sendMonitorCommand(_node, command) {
    sent.push(command);
    const add = /^object_add filter-dump,id=([^,]+),netdev=([^,]+),file=(.+),queue=all$/.exec(command);
    if (add) {
      if (silent) return '';
      filters.add(add[1]);
      fs.writeFileSync(add[3].replace(/,,/g, ','), pcap([]));
      return '';
    }
    const del = /^object_del (\S+)$/.exec(command);
    if (del) {
      if (!filters.delete(del[1])) return `Error: object '${del[1]}' not found`;
      return '';
    }
    throw new Error(`unexpected monitor command: ${command}`);
  }};
  const logs = [];
  const events = new EventEmitter();
  let clock = Date.parse('2026-11-20T10:15:30Z');
  const ctx = {runtime: {appendLog: (_node, line) => logs.push(line)}, monitor, events, session: {nodes: new Map([[HOST, node]])}, now: () => new Date(clock)};
  const capture = createCapture(ctx);
  const runner = {capture};
  const session = ctx.session;
  return {dir, node, sent, filters, logs, events, capture, runner, session, tick: ms => { clock += ms; },
    cleanup: () => fs.rmSync(dir, {recursive: true, force: true})};
}

// A PCAP: file header and the given packets (Buffers), little endian like QEMU's.
function pcap(packets) {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0); header.writeUInt16LE(2, 4); header.writeUInt16LE(4, 6);
  header.writeUInt32LE(65536, 16); header.writeUInt32LE(1, 20);
  return Buffer.concat([header, ...packets.map(data => {
    const record = Buffer.alloc(16);
    record.writeUInt32LE(data.length, 8); record.writeUInt32LE(data.length, 12);
    return Buffer.concat([record, data]);
  })]);
}

test('capture IDs: the file name of a capture is built by the runner and checked everywhere', () => {
  assert.equal(captureId(0, new Date('2026-11-20T10:15:30.123Z')), 'eth0-20261120T101530Z');
  assert.equal(captureId(3, new Date('2026-11-20T10:15:30Z'), 2), 'eth3-20261120T101530Z-2');
  for (const good of ['eth0-20261120T101530Z', 'eth3-20261120T101530Z-12']) assert.ok(isCaptureId(good), good);
  for (const bad of ['', 'eth4-20261120T101530Z', '../eth0-20261120T101530Z', 'eth0-20261120T101530Z.pcap', 'eth0-20261120T101530Z-0',
    'eth0-20261120T101530Z/..', 'eth0-2026', null, 7, {}]) assert.ok(!isCaptureId(bad), String(bad));
  assert.equal(interfaceIndex('eth2'), 2);
  assert.equal(interfaceIndex(1), 1);
  for (const bad of ['eth4', 'eth', 'eth01', '../eth0', -1, 4, 1.5, null, undefined]) assert.equal(interfaceIndex(bad), null, String(bad));
  assert.deepEqual(LIMITS, {maxBytes: 100 * 1024 * 1024, maxPerNode: 4});
});

test('completeLength keeps whole packets only', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-pcap-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'x.pcap');
  const whole = pcap([Buffer.alloc(60, 1), Buffer.alloc(100, 2)]);
  fs.writeFileSync(file, Buffer.concat([whole, Buffer.alloc(16 + 20)]));
  assert.equal(completeLength(file, whole.length), whole.length);
  const cut = Buffer.concat([whole, Buffer.alloc(8)]);
  fs.writeFileSync(file, cut);
  assert.equal(completeLength(file, cut.length), whole.length);
  const half = pcap([Buffer.alloc(60, 1)]);
  fs.writeFileSync(file, Buffer.concat([half, (() => { const r = Buffer.alloc(16); r.writeUInt32LE(50, 8); return Buffer.concat([r, Buffer.alloc(10)]); })()]));
  assert.equal(completeLength(file, fs.statSync(file).size), half.length);
  fs.writeFileSync(file, Buffer.alloc(10));
  assert.equal(completeLength(file, 10), 0);
  fs.writeFileSync(file, Buffer.alloc(100, 7));
  assert.equal(completeLength(file, 100), 0);
});

test('start adds a filter-dump to the running host through the monitor and lists the capture', async t => {
  const {capture, node, sent, dir, events, cleanup} = setup();
  t.after(cleanup);
  const published = [];
  events.on('captures', payload => published.push(payload));
  const started = await capture.start(node, 'eth0');
  assert.equal(started.id, 'eth0-20261120T101530Z');
  assert.equal(started.state, 'recording');
  assert.equal(started.interface, 'eth0');
  assert.equal(started.file, 'eth0-20261120T101530Z.pcap');
  const file = path.join(node.runtimeDir, 'captures', 'eth0-20261120T101530Z.pcap');
  assert.deepEqual(sent, [`object_add filter-dump,id=cap-eth0-20261120T101530Z,netdev=lan0,file=${file},queue=all`]);
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(path.join(node.runtimeDir, 'captures')).mode & 0o777, 0o700);
  assert.deepEqual(capture.list(HOST).map(item => [item.id, item.state, item.reason]), [['eth0-20261120T101530Z', 'recording', null]]);
  assert.deepEqual(capture.list().map(item => item.nodeId), [HOST]);
  assert.equal(published.length, 1);
  assert.equal(published[0].nodeId, HOST);
  assert.equal(JSON.stringify(started).includes(dir), false, 'no path leaves the runner');
  await capture.stop(node, started.id);
});

test('stop removes the filter, keeps the file and records why it stopped', async t => {
  const {capture, node, sent, cleanup, filters} = setup();
  t.after(cleanup);
  const {id} = await capture.start(node, 'eth0');
  fs.appendFileSync(path.join(node.runtimeDir, 'captures', `${id}.pcap`), Buffer.alloc(500));
  const stopped = await capture.stop(node, id);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.reason, 'user');
  assert.equal(stopped.bytes, 24 + 500);
  assert.ok(stopped.endedAt);
  assert.equal(sent.at(-1), `object_del cap-${id}`);
  assert.equal(filters.size, 0);
  assert.ok(fs.existsSync(path.join(node.runtimeDir, 'captures', `${id}.pcap`)));
  // A second stop finds a stopped capture and changes nothing.
  assert.equal((await capture.stop(node, id)).state, 'stopped');
  assert.equal(sent.filter(command => command.startsWith('object_del')).length, 1);
});

test('a second capture on the same interface is refused, another interface is not', async t => {
  const {capture, node, cleanup} = setup({nics: [{switchId: SWITCH}, {switchId: SWITCH}]});
  t.after(cleanup);
  await capture.start(node, 'eth0');
  await assert.rejects(capture.start(node, 'eth0'), error => error.status === 409 && /already being captured/.test(error.message));
  const second = await capture.start(node, 'eth1');
  assert.equal(second.interface, 'eth1');
});

test('two captures of one interface in the same second never share a file', async t => {
  const {capture, node, cleanup} = setup();
  t.after(cleanup);
  const first = await capture.start(node, 'eth0');
  await capture.stop(node, first.id);
  const second = await capture.start(node, 'eth0');
  assert.notEqual(second.id, first.id);
  assert.equal(second.id, `${first.id}-1`);
  assert.ok(isCaptureId(second.id));
});

test('a node keeps at most four captures; deleting one makes room', async t => {
  const {capture, node, cleanup, tick} = setup();
  t.after(cleanup);
  const ids = [];
  for (let n = 0; n < LIMITS.maxPerNode; n++) {
    tick(1000);
    const item = await capture.start(node, 'eth0');
    ids.push(item.id);
    await capture.stop(node, item.id);
  }
  await assert.rejects(capture.start(node, 'eth0'), error => error.status === 409 && /at most 4 captures/.test(error.message));
  assert.deepEqual(capture.remove(node, ids[0]), {ok: true});
  assert.ok(!fs.existsSync(path.join(node.runtimeDir, 'captures', `${ids[0]}.pcap`)));
  assert.equal(capture.list(HOST).length, 3);
  tick(1000);
  assert.equal((await capture.start(node, 'eth0')).state, 'recording');
});

test('start refuses a stopped, busy, VirtualBox or unconnected host and a bad interface', async t => {
  const refused = async (options, name, status, pattern) => {
    const fixture = setup(options);
    t.after(fixture.cleanup);
    await assert.rejects(fixture.capture.start(fixture.node, name), error => error.status === status && pattern.test(error.message), JSON.stringify(options));
    assert.deepEqual(fixture.sent, []);
  };
  await refused({running: false}, 'eth0', 409, /not running/);
  await refused({engine: 'vbox'}, 'eth0', 409, /QEMU hosts only/);
  await refused({}, 'eth1', 409, /not connected to a switch/);
  await refused({}, 'eth2', 409, /no Ethernet interface eth2/);
  await refused({}, 'eth9', 400, /Unknown interface/);
  await refused({}, '../x', 400, /Unknown interface/);
  const busy = setup();
  t.after(busy.cleanup);
  busy.node.action = 'reboot';
  await assert.rejects(busy.capture.start(busy.node, 'eth0'), error => error.status === 409);
  await assert.rejects(busy.capture.start({id: SWITCH, kind: 'switch'}, 'eth0'), error => error.status === 400);
});

test('a filter QEMU silently refused is reported and leaves nothing behind', async t => {
  const {capture, node, cleanup, logs} = setup({silent: true});
  t.after(cleanup);
  await assert.rejects(capture.start(node, 'eth0'), error => error.status === 500 && /did not create the capture file/.test(error.message));
  assert.deepEqual(capture.list(HOST), []);
  assert.ok(logs.some(line => /failed/.test(line)));
});

test('a monitor error message fails the start', async t => {
  const fixture = setup();
  t.after(fixture.cleanup);
  const {capture, node} = fixture;
  const capturing = createCapture({runtime: {appendLog() {}}, monitor: {sendMonitorCommand: async () => "Error: attempt to add duplicate property 'x'"},
    events: new EventEmitter(), session: {nodes: new Map([[HOST, node]])}});
  await assert.rejects(capturing.start(node, 'eth0'), error => /duplicate property/.test(error.message));
  assert.deepEqual(capture.list(), []);
});

test('the file name and commas: a runtime path with a comma is doubled, one with spaces is refused', async t => {
  const comma = setup();
  t.after(comma.cleanup);
  comma.node.runtimeDir = path.join(comma.dir, 'a,b');
  fs.mkdirSync(comma.node.runtimeDir);
  await comma.capture.start(comma.node, 'eth0');
  assert.match(comma.sent[0], /file=.*a,,b[\\/]captures[\\/]eth0-/);
  const spaced = setup();
  t.after(spaced.cleanup);
  spaced.node.runtimeDir = path.join(spaced.dir, 'a b');
  fs.mkdirSync(spaced.node.runtimeDir);
  await assert.rejects(spaced.capture.start(spaced.node, 'eth0'), error => error.status === 500 && /cannot take/.test(error.message));
  assert.deepEqual(spaced.sent, []);
});

test('the size watcher removes the filter at the limit and says why', async t => {
  const {capture, node, sent, cleanup, events} = setup();
  t.after(cleanup);
  const {id} = await capture.start(node, 'eth0');
  const file = path.join(node.runtimeDir, 'captures', `${id}.pcap`);
  await capture.poll();
  assert.equal(capture.list(HOST)[0].state, 'recording');
  fs.truncateSync(file, LIMITS.maxBytes - 1);
  await capture.poll();
  assert.equal(capture.list(HOST)[0].state, 'recording', 'one byte below the limit');
  fs.truncateSync(file, LIMITS.maxBytes);
  const published = [];
  events.on('captures', payload => published.push(payload));
  await capture.poll();
  const [entry] = capture.list(HOST);
  assert.equal(entry.state, 'stopped');
  assert.equal(entry.reason, 'size-limit');
  assert.equal(entry.message, 'stopped: size limit reached');
  assert.equal(entry.bytes, LIMITS.maxBytes);
  assert.equal(sent.at(-1), `object_del cap-${id}`);
  assert.equal(published.length, 1);
  await capture.poll();
  assert.equal(sent.filter(command => command.startsWith('object_del')).length, 1, 'removed once');
});

test('the host stopping or dying ends its recordings and keeps the files; deleting the node forgets them', async t => {
  const {capture, node, cleanup, events} = setup({nics: [{switchId: SWITCH}, {switchId: SWITCH}]});
  t.after(cleanup);
  const a = await capture.start(node, 'eth0');
  const b = await capture.start(node, 'eth1');
  const published = [];
  events.on('captures', payload => published.push(payload));
  capture.hostStopped(node, {});
  assert.deepEqual(capture.list(HOST).map(item => item.state), ['recording', 'recording'], 'the exit of another process changes nothing');
  node.machine = null;
  await capture.poll();
  assert.deepEqual(capture.list(HOST).map(item => [item.state, item.reason]), [['stopped', 'host-stopped'], ['stopped', 'host-stopped']]);
  assert.equal(capture.list(HOST)[0].message, 'stopped: host stopped');
  for (const id of [a.id, b.id]) assert.ok(fs.existsSync(path.join(node.runtimeDir, 'captures', `${id}.pcap`)));
  assert.ok(published.length >= 1);
  await assert.rejects(capture.start(node, 'eth0'), error => error.status === 409 && /not running/.test(error.message), 'a stopped host cannot start');
  capture.nodeRemoved(node);
  assert.deepEqual(capture.list(), []);
});

test('delete refuses a recording capture; unknown or malformed IDs are 404', async t => {
  const {capture, node, cleanup} = setup();
  t.after(cleanup);
  const {id} = await capture.start(node, 'eth0');
  assert.throws(() => capture.remove(node, id), error => error.status === 409 && /Stop the capture/.test(error.message));
  for (const bad of ['eth0-20990101T000000Z', '../../etc/passwd', `${id}.pcap`, '', undefined, 42]) {
    assert.throws(() => capture.remove(node, bad), error => error.status === 404, String(bad));
    assert.throws(() => capture.fileOf(node, bad), error => error.status === 404, String(bad));
    await assert.rejects(capture.stop(node, bad), error => error.status === 404, String(bad));
  }
});

// The command layer: the answers are the bodies of the HTTP routes.
function io() {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', chunk => chunks.push(chunk));
  const after = [];
  return {outgoing: () => ({id: 7, stream}), afterResponse: fn => after.push(fn), chunks, after, stream};
}

test('captures.list and capture.start/stop/delete answer with the capture and the limits', async t => {
  const {runner, session, cleanup} = setup();
  t.after(cleanup);
  assert.deepEqual(commands['captures.list']({session, runner}, {}), {limits: LIMITS, captures: []});
  const started = await commands['capture.start']({session, runner}, {nodeId: HOST, interface: 'eth0'});
  assert.equal(started.state, 'recording');
  assert.equal(commands['captures.list']({session, runner}, {nodeId: HOST}).captures.length, 1);
  assert.throws(() => commands['captures.list']({session, runner}, {nodeId: 's-ffffffff'}), error => error.status === 404);
  await assert.rejects(async () => commands['capture.start']({session, runner}, {nodeId: 'h-ffffffff', interface: 'eth0'}), error => error.status === 404);
  assert.equal((await commands['capture.stop']({session, runner}, {nodeId: HOST, captureId: started.id})).state, 'stopped');
  assert.deepEqual(commands['capture.delete']({session, runner}, {nodeId: HOST, captureId: started.id}), {ok: true});
  assert.deepEqual(commands['captures.list']({session, runner}, {}).captures, []);
});

test('capture.download streams the file (whole packets only while recording) and nothing else', async t => {
  const {runner, session, node, cleanup} = setup();
  t.after(cleanup);
  const started = await commands['capture.start']({session, runner}, {nodeId: HOST, interface: 'eth0'});
  const file = path.join(node.runtimeDir, 'captures', `${started.id}.pcap`);
  // Header only: no packet yet is still a valid, empty capture of 24 bytes.
  const body = pcap([Buffer.alloc(60, 1), Buffer.alloc(80, 2)]);
  fs.writeFileSync(file, Buffer.concat([body, Buffer.alloc(9, 3)]));
  const channel = io();
  const answer = await commands['capture.download']({session, runner, io: channel}, {nodeId: HOST, captureId: started.id});
  assert.deepEqual(answer, {stream: 7, size: body.length, name: `${started.id}.pcap`});
  await channel.after[0]();
  assert.deepEqual(Buffer.concat(channel.chunks), body);
  await commands['capture.stop']({session, runner}, {nodeId: HOST, captureId: started.id});
  const finished = io();
  assert.equal((await commands['capture.download']({session, runner, io: finished}, {nodeId: HOST, captureId: started.id})).size, body.length + 9);
  await assert.rejects(async () => commands['capture.download']({session, runner, io: io()}, {nodeId: HOST, captureId: '../../../etc/passwd'}), error => error.status === 404);
});

test('capture.download of a capture with no packet header yet is refused', async t => {
  const {runner, session, node, cleanup} = setup();
  t.after(cleanup);
  const started = await commands['capture.start']({session, runner}, {nodeId: HOST, interface: 'eth0'});
  fs.writeFileSync(path.join(node.runtimeDir, 'captures', `${started.id}.pcap`), Buffer.alloc(10));
  await assert.rejects(async () => commands['capture.download']({session, runner, io: io()}, {nodeId: HOST, captureId: started.id}), error => error.status === 409);
});
