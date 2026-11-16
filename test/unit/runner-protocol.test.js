// Runner protocol: frame codec, control-plane client, runner endpoint and dispatcher, and
// archive streams with credit flow control, over in-memory stream pairs. No process is spawned.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {EventEmitter, once} = require('node:events');
const {duplexPair, Readable, Writable} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {encodeJson, encodeChunk, FrameDecoder, Connection, MAX_FRAME, STREAM_WINDOW} = require('../../common/runner-protocol');
const {RunnerClient} = require('../../lib/runner-client');
const {serveConnection} = require('../../runner/endpoint');
const {runnerPair} = require('./runner-pair');

const turn = () => new Promise(resolve => setImmediate(resolve));

// A client connected to the endpoint of a fake service.
function fakeRunner(service) {
  const fake = {events: new EventEmitter(), input() {}, setConsoleFlow() {}, hello: () => ({type: 'hello', protocol: 1, sessions: []}), ...service};
  const [controlSide, runnerSide] = duplexPair();
  const client = new RunnerClient(new Connection(controlSide));
  const runnerConnection = new Connection(runnerSide);
  serveConnection(runnerConnection, fake);
  return {client, fake, runnerConnection};
}

test('frames survive any split or merge of the byte stream', () => {
  const frames = Buffer.concat([encodeJson({type: 'event', n: 1}), encodeChunk(7, Buffer.from([0, 1, 2, 255])), encodeJson({type: 'x', text: 'é'})]);
  for (const size of [1, 3, 5, 9, frames.length]) {
    const decoder = new FrameDecoder();
    const out = [];
    for (let offset = 0; offset < frames.length; offset += size) out.push(...decoder.push(frames.subarray(offset, offset + size)));
    assert.deepEqual(out.map(frame => frame.json || {streamId: frame.streamId, data: [...frame.data]}),
      [{type: 'event', n: 1}, {streamId: 7, data: [0, 1, 2, 255]}, {type: 'x', text: 'é'}], `chunks of ${size}`);
  }
});

test('malformed and oversized frames are refused', () => {
  const header = (length, type) => { const buffer = Buffer.alloc(5); buffer.writeUInt32BE(length); buffer[4] = type; return buffer; };
  assert.throws(() => new FrameDecoder().push(header(MAX_FRAME + 1, 0x4a)), /length/);
  assert.throws(() => new FrameDecoder().push(header(0, 0x4a)), /length/);
  assert.throws(() => new FrameDecoder().push(Buffer.concat([header(3, 0x51), Buffer.from('ab')])), /type/);
  assert.throws(() => new FrameDecoder().push(Buffer.concat([header(3, 0x4a), Buffer.from('[]')])), /message/);
  assert.throws(() => encodeJson({type: 'big', data: 'x'.repeat(MAX_FRAME)}), /too large/);
});

test('responses match their requests in any order, errors keep the runner status', async () => {
  const {client} = fakeRunner({
    async handle(command, sessionId, args) {
      if (command === 'slow') { await new Promise(resolve => setTimeout(resolve, 20)); return {slow: args.n}; }
      if (command === 'fail') throw Object.assign(new Error('No such node.'), {status: 404});
      if (command === 'plain') throw new Error('Plain failure.');
      return {sessionId, command};
    }
  });
  await once(client, 'hello');
  const session = client.session('0000000000000001');
  const [slow, fast] = await Promise.all([session.request('slow', {n: 1}), session.request('fast')]);
  assert.deepEqual(slow, {slow: 1});
  assert.deepEqual(fast, {sessionId: '0000000000000001', command: 'fast'});
  await assert.rejects(session.request('fail'), error => error.status === 404 && error.message === 'No such node.');
  await assert.rejects(session.request('plain'), error => error.status === undefined && error.message === 'Plain failure.');
  client.close();
});

test('a lost connection fails pending and later requests with 503', async () => {
  const {client, runnerConnection} = fakeRunner({handle: () => new Promise(() => {})});
  await once(client, 'hello');
  const pending = client.session('0000000000000001').request('never');
  runnerConnection.close();
  await assert.rejects(pending, error => error.status === 503);
  await assert.rejects(client.request('again'), error => error.status === 503);
});

test('events reach only the handles of known sessions; input and requests keep their order', async () => {
  const order = [];
  const {client, fake} = fakeRunner({
    handle: (command, sessionId, args) => { order.push(`${command}:${args.n}`); return null; },
    input: (sessionId, nodeId, data) => order.push(`input:${data}`)
  });
  await once(client, 'hello');
  const toto = client.session('0000000000000001');
  const seen = [];
  toto.events.on('state', payload => seen.push(payload.nodeId));
  fake.events.emit('event', '0000000000000001', 'state', {nodeId: 'h-1'});
  fake.events.emit('event', '00000000000000ff', 'state', {nodeId: 'h-2'});
  toto.request('one', {n: 1});
  toto.input('h-1', 'a');
  await toto.request('two', {n: 2});
  assert.deepEqual(seen, ['h-1']);
  assert.deepEqual(order, ['one:1', 'input:a', 'two:2']);
  client.release('0000000000000001');
  fake.events.emit('event', '0000000000000001', 'state', {nodeId: 'h-3'});
  await client.request('sync', {n: 3});
  assert.deepEqual(seen, ['h-1'], 'a released session gets no event');
  client.close();
});

test('console output is coalesced per node and flushed before a response and other events', async () => {
  const events = new EventEmitter();
  const {client} = fakeRunner({
    events,
    handle: () => {
      events.emit('event', 's', 'serial', {nodeId: 'h-1', data: 'a'});
      events.emit('event', 's', 'serial', {nodeId: 'h-1', data: 'b'});
      return {snapshot: 'ab'};
    }
  });
  await once(client, 'hello');
  const session = client.session('s');
  const received = [];
  session.events.on('serial', payload => received.push(['serial', payload.data]));
  session.events.on('state', payload => received.push(['state', payload.nodeId]));
  const result = await session.request('console.attach');
  received.push(['response', result.snapshot]);
  events.emit('event', 's', 'serial', {nodeId: 'h-1', data: 'c'});
  events.emit('event', 's', 'serial', {nodeId: 'h-1', data: 'd'});
  events.emit('event', 's', 'state', {nodeId: 'h-1'});
  await client.request('sync');
  assert.deepEqual(received, [['serial', 'ab'], ['response', 'ab'], ['serial', 'cd'], ['state', 'h-1']]);
  client.close();
});

test('streams carry binary data in order without exceeding the credit window', async () => {
  const [left, right] = duplexPair();
  const sender = new Connection(left);
  const receiver = new Connection(right);
  const data = crypto.randomBytes(3 * STREAM_WINDOW + 12345);
  const {id, stream} = sender.outgoing();
  let maxInFlight = 0;
  const entry = sender.outgoingStreams.get(id);
  const chunks = [];
  const slowReader = new Writable({write(chunk, _encoding, callback) {
    maxInFlight = Math.max(maxInFlight, entry.inFlight);
    chunks.push(chunk);
    setImmediate(callback);
  }});
  await Promise.all([pipeline(Readable.from([data]), stream), pipeline(receiver.incoming(id), slowReader)]);
  assert.ok(Buffer.concat(chunks).equals(data));
  assert.ok(maxInFlight <= STREAM_WINDOW, `in flight ${maxInFlight}`);
  sender.close();
});

test('a receiver that cancels a stream stops its sender', async () => {
  const [left, right] = duplexPair();
  const sender = new Connection(left);
  const receiver = new Connection(right);
  const {id, stream} = sender.outgoing();
  const failed = once(stream, 'error');
  stream.write(Buffer.alloc(10));
  const incoming = receiver.incoming(id);
  await turn();
  incoming.destroy(new Error('Not wanted.'));
  const [error] = await failed;
  assert.match(error.message, /Not wanted/);
  sender.close();
});

test('the dispatcher refuses unknown commands, sessions and nodes', async t => {
  const {client, service} = await runnerPair(t);
  const sessionId = '00000000000000a1';
  await assert.rejects(client.request('session.create', {owner: 'toto'}, 'not-an-id'), /Invalid session ID/);
  await client.request('session.create', {owner: 'toto'}, sessionId);
  await assert.rejects(client.request('session.create', {owner: 'toto'}, sessionId), error => error.status === 409);
  const session = client.session(sessionId);
  await assert.rejects(session.request('no.such.command'), /Unknown runner command/);
  await assert.rejects(client.session('00000000000000a2').request('nodes.list'), error => error.status === 404);
  await assert.rejects(session.request('node.start', {nodeId: 'h-00000000000000aa'}), error => error.status === 404 && /Unknown host or switch/.test(error.message));
  await assert.rejects(session.request('console.attach', {nodeId: 'h-00000000000000aa'}), error => !error.status && error.message === 'Unknown node.');
  assert.deepEqual(await session.request('nodes.list'), []);
  assert.deepEqual(service.hello().sessions, [{sessionId, engine: 'qemu', nodes: []}]);
  const hello = service.hello();
  assert.equal(hello.protocol, 1);
  assert.ok(Array.isArray(hello.engines) && hello.engines.includes('qemu'));
  assert.equal(typeof hello.kvm, 'boolean');
  assert.ok(Number.isInteger(hello.cpus) && Number.isInteger(hello.memoryBytes));
  assert.equal(typeof hello.images, 'object');
  assert.deepEqual(await session.request('session.delete'), {deleted: true});
  assert.deepEqual(service.hello().sessions, []);
});
