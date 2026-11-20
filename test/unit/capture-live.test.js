// The live Capture view: filter validation, the runner side (runner/capture-live.js with a fake
// tcpdump process: no program is started) and the server's relay (server/capture-live.js with a
// fake socket and runner).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const test = require('node:test');
const {validateFilter, FILTER_MAX, MAX_LIVE} = require('../../common/capture');
const {createCaptureLive} = require('../../runner/capture-live');
const {attachCaptureLive} = require('../../server/capture-live');
const {commands} = require('../../runner/commands/captures');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const HOST = 'h-0000000000000001';
const CAP = 'eth0-20261120T101530Z';
const LIVE = '0123456789abcdef';

test('the filter is one tcpdump expression: allowed characters, length limit, no leading dash', () => {
  for (const good of ['', '  ', 'icmp', 'icmp and host 10.0.0.2', 'tcp port 80 or udp port 53', 'ether host 52:54:00:00:00:01',
    'tcp[tcpflags] & tcp-syn != 0', 'not (arp or ip6)', 'net 10.0.0.0/24 && !port 22', 'ip[8] < 2 || portrange 1-1024']) {
    assert.equal(typeof validateFilter(good), 'string', good);
  }
  assert.equal(validateFilter('  arp  '), 'arp');
  assert.equal(validateFilter(undefined), '');
  assert.equal(validateFilter('x'.repeat(FILTER_MAX)).length, FILTER_MAX);
  for (const bad of ['x'.repeat(FILTER_MAX + 1), 'a; b', '$(id)', '`id`', 'a\nb', 'a\\b', '"a"', "'a'", '{a}', 'a#b', 'a~b', '-w /tmp/x', '--help', '-', 5, {}, ['a']]) {
    assert.throws(() => validateFilter(bad), Error, JSON.stringify(bad));
  }
  assert.throws(() => validateFilter('a;b'), /characters a tcpdump expression does not use/);
  assert.throws(() => validateFilter('-w x'), /cannot start with "-"/);
});

// A fake tcpdump: what it is given on stdin it keeps; its output is written by the test, which
// also makes it exit (finish) as the real one does after the end of its input; kill() ends it.
function fakeChild() {
  const child = new EventEmitter();
  Object.assign(child, {stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, received: []});
  child.stdin.on('data', chunk => child.received.push(chunk));
  child.kills = [];
  child.finish = code => {
    if (child.exitCode !== null || child.signalCode) return;
    child.exitCode = code;
    child.stdout.end(); child.stderr.end();
    setImmediate(() => child.emit('close', code, null));
  };
  child.stdinEnded = false;
  child.stdin.on('end', () => { child.stdinEnded = true; });
  child.kill = signal => {
    child.kills.push(signal);
    if (child.exitCode !== null || child.signalCode) return true;
    child.signalCode = signal;
    child.stdout.end(); child.stderr.end();
    setImmediate(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

function setupLive({recording = false, file = Buffer.from('PCAPDATA'), tcpdump = '/usr/sbin/tcpdump'} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-live-'));
  const filePath = path.join(dir, `${CAP}.pcap`);
  fs.writeFileSync(filePath, file);
  const state = {recording};
  const events = new EventEmitter();
  const emitted = [];
  events.on('capture-live', payload => emitted.push(payload));
  const ctx = {events, flow: {paused: false}, capture: {fileOf: (_node, id) => {
    if (id !== CAP) throw Object.assign(new Error('Unknown capture.'), {status: 404});
    return {path: filePath, name: `${CAP}.pcap`, recording: state.recording, size: fs.statSync(filePath).size};
  }}};
  const spawned = [];
  const live = createCaptureLive(ctx, {locate: () => tcpdump, spawnProcess: (command, args, options) => {
    const child = fakeChild();
    spawned.push({command, args, options, child});
    return child;
  }});
  const node = {id: HOST};
  return {live, ctx, emitted, spawned, state, node, filePath, cleanup: () => fs.rmSync(dir, {recursive: true, force: true})};
}

test('the live view spawns tcpdump with an argument array, never a shell, and the filter as one argument after --', async t => {
  const fixture = setupLive();
  t.after(fixture.cleanup);
  const {live, spawned, node} = fixture;
  live.start(node, {liveId: LIVE, captureId: CAP});
  live.start(node, {liveId: 'fedcba9876543210', captureId: CAP, filter: ' icmp and host 10.0.0.1 '});
  assert.deepEqual(spawned.map(item => item.args), [['-l', '-n', '-r', '-'], ['-l', '-n', '-r', '-', '--', 'icmp and host 10.0.0.1']]);
  for (const item of spawned) {
    assert.equal(item.command, '/usr/sbin/tcpdump');
    assert.deepEqual(item.options, {stdio: ['pipe', 'pipe', 'pipe']});
    assert.equal(item.options.shell, undefined);
  }
  live.stopNode();
  await sleep(20);
});

test('a finished capture is read to its end, its text goes out, and the view ends by itself', async t => {
  const fixture = setupLive();
  t.after(fixture.cleanup);
  const {live, emitted, spawned, node} = fixture;
  assert.deepEqual(live.start(node, {liveId: LIVE, captureId: CAP}), {liveId: LIVE});
  const {child} = spawned[0];
  await sleep(60);
  assert.equal(Buffer.concat(child.received).toString(), 'PCAPDATA', 'the file goes to tcpdump from its first byte');
  assert.equal(child.stdinEnded, true, 'the end of a stopped capture is the end of the input');
  child.stdout.write('12:00:00 IP 10.0.0.1 > 10.0.0.2: ICMP echo request\n');
  child.stderr.write('reading from file -, link-type EN10MB\n');
  child.finish(0);
  await sleep(120);
  assert.equal(live.count(), 0, 'the view is over');
  const text = emitted.filter(item => item.data).map(item => item.data).join('');
  assert.match(text, /ICMP echo request/);
  assert.match(text, /reading from file/);
  assert.deepEqual(emitted.at(-1), {liveId: LIVE, end: 'End of the capture.'});
  assert.equal(emitted.filter(item => item.end).length, 1);
  assert.ok(emitted.every(item => item.liveId === LIVE));
});

test('a recording capture is followed as it grows, until it stops', async t => {
  const fixture = setupLive({recording: true});
  t.after(fixture.cleanup);
  const {live, spawned, state, node, filePath, emitted} = fixture;
  live.start(node, {liveId: LIVE, captureId: CAP});
  const {child} = spawned[0];
  await sleep(60);
  assert.equal(live.count(), 1, 'still open while recording');
  fs.appendFileSync(filePath, '+MORE');
  await sleep(250);
  assert.equal(Buffer.concat(child.received).toString(), 'PCAPDATA+MORE');
  assert.equal(child.stdinEnded, false, 'the input stays open while recording');
  state.recording = false;
  await sleep(300);
  assert.equal(child.stdinEnded, true);
  child.finish(0);
  await sleep(50);
  assert.equal(live.count(), 0);
  assert.deepEqual(emitted.at(-1), {liveId: LIVE, end: 'End of the capture.'});
});

test('stopping a view kills its tcpdump and says nothing more; a node or the connection ending stops its views', async t => {
  const fixture = setupLive({recording: true});
  t.after(fixture.cleanup);
  const {live, spawned, node, emitted} = fixture;
  live.start(node, {liveId: LIVE, captureId: CAP});
  live.start({id: 'h-0000000000000002'}, {liveId: 'fedcba9876543210', captureId: CAP});
  await sleep(40);
  assert.deepEqual(live.stop(LIVE), {ok: true});
  assert.deepEqual(spawned[0].child.kills, ['SIGTERM']);
  assert.equal(live.count(), 1);
  live.stopNode(HOST);
  assert.deepEqual(spawned[1].child.kills, [], 'another node is left alone');
  live.stopNode('h-0000000000000002');
  assert.deepEqual(spawned[1].child.kills, ['SIGTERM']);
  assert.deepEqual(live.stop(LIVE), {ok: true}, 'stopping twice is harmless');
  assert.deepEqual(live.stop('0000000000000000'), {ok: true});
  await sleep(80);
  assert.equal(live.count(), 0);
  assert.equal(emitted.filter(item => item.end).length, 0, 'a stopped view sends no end');
  assert.equal(spawned[0].child.kills.length, 1, 'killed once');
});

test('refusals: bad identifiers, bad filters, a missing capture, too many views, tcpdump not installed', async t => {
  const fixture = setupLive();
  t.after(fixture.cleanup);
  const {live, node, spawned} = fixture;
  const refused = (args, status, pattern) => assert.throws(() => live.start(node, args), error => error.status === status && pattern.test(error.message), JSON.stringify(args));
  refused({liveId: 'nope', captureId: CAP}, 400, /Invalid live view/);
  refused({liveId: undefined, captureId: CAP}, 400, /Invalid live view/);
  refused({liveId: LIVE, captureId: CAP, filter: 'a; rm -rf /'}, 400, /characters/);
  refused({liveId: LIVE, captureId: CAP, filter: '-w /tmp/x'}, 400, /cannot start with/);
  refused({liveId: LIVE, captureId: CAP, filter: 'x'.repeat(FILTER_MAX + 1)}, 400, /too long/);
  refused({liveId: LIVE, captureId: 'eth0-20990101T000000Z'}, 404, /Unknown capture/);
  refused({liveId: LIVE, captureId: '../../etc/passwd'}, 404, /Unknown capture/);
  assert.deepEqual(spawned, [], 'nothing is spawned for a refused request');
  live.start(node, {liveId: LIVE, captureId: CAP});
  refused({liveId: LIVE, captureId: CAP}, 400, /Invalid live view/);
  for (let index = 1; index < MAX_LIVE; index++) live.start(node, {liveId: index.toString(16).padStart(16, '0'), captureId: CAP});
  refused({liveId: 'aaaaaaaaaaaaaaaa', captureId: CAP}, 409, /At most 4 live captures/);
  live.stopNode();
  await sleep(40);
  const missing = setupLive({tcpdump: null});
  t.after(missing.cleanup);
  assert.throws(() => missing.live.start(missing.node, {liveId: LIVE, captureId: CAP}), error => error.status === 409 && /tcpdump is not installed/.test(error.message));
});

test('without an injected locate, the command resolved by the start-up check is used', t => {
  const fixture = setupLive();
  t.after(fixture.cleanup);
  const spawned = [];
  const withCommands = commandsObject => createCaptureLive({...fixture.ctx, commands: commandsObject}, {spawnProcess: (command, args) => { spawned.push([command, args]); return fakeChild(); }});
  const live = withCommands({TCPDUMP: '/opt/tools/tcpdump'});
  live.start(fixture.node, {liveId: LIVE, captureId: CAP});
  assert.deepEqual(spawned, [['/opt/tools/tcpdump', ['-l', '-n', '-r', '-']]]);
  live.stopNode();
  assert.throws(() => withCommands({TCPDUMP: null}).start(fixture.node, {liveId: LIVE, captureId: CAP}), error => error.status === 409 && /tcpdump is not installed/.test(error.message));
  assert.equal(spawned.length, 1, 'nothing is spawned when the command is missing');
});

test('a tcpdump that fails or cannot start ends the view with its message', async t => {
  const fixture = setupLive({recording: true});
  t.after(fixture.cleanup);
  const {live, spawned, emitted, node} = fixture;
  live.start(node, {liveId: LIVE, captureId: CAP, filter: 'icmp and ('});
  spawned[0].child.stderr.write("tcpdump: can't parse filter expression: syntax error\n");
  spawned[0].child.finish(1);
  await sleep(150);
  assert.match(emitted.filter(item => item.data).map(item => item.data).join(''), /can't parse filter expression/);
  assert.deepEqual(emitted.at(-1), {liveId: LIVE, end: 'tcpdump stopped (status 1).'});
  assert.equal(live.count(), 0);
  emitted.length = 0;
  live.start(node, {liveId: 'fedcba9876543210', captureId: CAP});
  spawned[1].child.emit('error', new Error('spawn tcpdump ENOENT'));
  await sleep(50);
  assert.deepEqual(emitted.at(-1), {liveId: 'fedcba9876543210', end: 'Cannot run tcpdump: spawn tcpdump ENOENT'});
  assert.equal(live.count(), 0);
});

test('output waits while the connection is congested', async t => {
  const fixture = setupLive({recording: true});
  t.after(fixture.cleanup);
  const {live, spawned, ctx, emitted, node} = fixture;
  ctx.flow.paused = true;
  live.start(node, {liveId: LIVE, captureId: CAP});
  spawned[0].child.stdout.write('packet\n');
  await sleep(150);
  assert.deepEqual(emitted, [], 'nothing is sent while paused');
  ctx.flow.paused = false;
  await sleep(300);
  assert.equal(emitted.map(item => item.data).join(''), 'packet\n');
  live.stopNode();
});

test('the live commands go to the capture-live module of the session', () => {
  const calls = [];
  const runner = {captureLive: {start: (node, args) => { calls.push(['start', node.id, args]); return {liveId: args.liveId}; }, stop: id => { calls.push(['stop', id]); return {ok: true}; }}};
  const session = {nodes: new Map([[HOST, {id: HOST}]])};
  assert.deepEqual(commands['capture.live.start']({session, runner}, {nodeId: HOST, captureId: CAP, liveId: LIVE, filter: 'arp'}), {liveId: LIVE});
  assert.deepEqual(commands['capture.live.stop']({session, runner}, {liveId: LIVE}), {ok: true});
  assert.throws(() => commands['capture.live.start']({session, runner}, {nodeId: 'h-ffffffffffffffff', captureId: CAP, liveId: LIVE}), error => error.status === 404);
  assert.deepEqual(calls, [['start', HOST, {liveId: LIVE, captureId: CAP, filter: 'arp'}], ['stop', LIVE]]);
});

// ---- The server's relay ------------------------------------------------------------------------
function relay({allowed = true} = {}) {
  const socket = new EventEmitter();
  const sent = [];
  socket.emit = (event, ...args) => { if (event.startsWith('capture-live-') && event !== 'capture-live-stop') { sent.push([event, ...args]); return true; } return EventEmitter.prototype.emit.call(socket, event, ...args); };
  const runner = {events: new EventEmitter(), requests: [], async request(command, args) {
    this.requests.push([command, args]);
    if (this.fail && command === 'capture.live.start') throw new Error(this.fail);
    return {};
  }};
  const recorded = [];
  attachCaptureLive(socket, {runner, guard: handler => handler, allowed: () => allowed, record: entry => recorded.push(entry)});
  const ask = request => new Promise(resolve => EventEmitter.prototype.emit.call(socket, 'capture-live', request, resolve));
  return {socket, runner, sent, recorded, ask};
}

test('the relay refuses an observer without control and malformed requests before the runner', async () => {
  const observer = relay({allowed: false});
  assert.match((await observer.ask({nodeId: HOST, captureId: CAP})).error, /Read-only observation/);
  assert.deepEqual(observer.runner.requests, []);
  const owner = relay();
  for (const request of [undefined, {}, {nodeId: HOST}, {nodeId: HOST, captureId: '../x'}, {nodeId: 7, captureId: CAP}, {nodeId: HOST, captureId: CAP, filter: 5},
    {nodeId: HOST, captureId: CAP, filter: 'x'.repeat(FILTER_MAX + 1)}]) {
    assert.ok((await owner.ask(request)).error, JSON.stringify(request));
  }
  assert.deepEqual(owner.runner.requests, []);
});

test('the relay starts a view with its own random ID, forwards its text and end, and stops on request or disconnect', async () => {
  const {socket, runner, sent, recorded, ask} = relay();
  assert.deepEqual(await ask({nodeId: HOST, captureId: CAP, filter: 'icmp'}), {ok: true});
  const [command, args] = runner.requests[0];
  assert.equal(command, 'capture.live.start');
  assert.match(args.liveId, /^[0-9a-f]{16}$/);
  assert.deepEqual({...args, liveId: undefined}, {liveId: undefined, nodeId: HOST, captureId: CAP, filter: 'icmp'});
  assert.deepEqual(recorded, [{nodeId: HOST, captureId: CAP}]);
  runner.events.emit('capture-live', {liveId: 'ffffffffffffffff', data: 'other view'});
  runner.events.emit('capture-live', {liveId: args.liveId, data: 'packet 1\n'});
  assert.deepEqual(sent, [['capture-live-data', {data: 'packet 1\n'}]]);
  // A second request replaces the first one: the runner is told to stop it.
  await ask({nodeId: HOST, captureId: CAP});
  assert.deepEqual(runner.requests[1], ['capture.live.stop', {liveId: args.liveId}]);
  assert.equal(runner.events.listenerCount('capture-live'), 1);
  const second = runner.requests[2][1].liveId;
  runner.events.emit('capture-live', {liveId: second, end: 'End of the capture.'});
  assert.deepEqual(sent.at(-1), ['capture-live-end', {message: 'End of the capture.'}]);
  assert.equal(runner.events.listenerCount('capture-live'), 0, 'ended: no more listening');
  await ask({nodeId: HOST, captureId: CAP});
  const third = runner.requests.at(-1)[1].liveId;
  EventEmitter.prototype.emit.call(socket, 'capture-live-stop');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runner.requests.at(-1), ['capture.live.stop', {liveId: third}]);
  assert.equal(runner.events.listenerCount('capture-live'), 0);
  await ask({nodeId: HOST, captureId: CAP});
  const fourth = runner.requests.at(-1)[1].liveId;
  EventEmitter.prototype.emit.call(socket, 'disconnect');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runner.requests.at(-1), ['capture.live.stop', {liveId: fourth}]);
  assert.equal(runner.events.listenerCount('capture-live'), 0, 'no listener is left after the socket closed');
});

test('a runner that refuses the view gives the user its message and leaves no listener', async () => {
  const {runner, ask, recorded} = relay();
  runner.fail = 'tcpdump is not installed on the machine of the runner; install it (see docs/install.md).';
  assert.match((await ask({nodeId: HOST, captureId: CAP})).error, /tcpdump is not installed/);
  assert.equal(runner.events.listenerCount('capture-live'), 0);
  assert.deepEqual(recorded, []);
});
