'use strict';

// The guest agent client and poller (runner/guest-agent.js) against a FAKE agent on a Unix socket and fake
// timers: no QEMU, no VM. The replies are the ones recorded in the GAG01 study (test/fixtures).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {queryAgent, createGuestAgent, ALLOWED_COMMANDS} = require('../../runner/guest-agent');
const {NODE_FILES, socketPathsBelowRuntime, SOCKET_LIMIT} = require('../../common/runtime-dir');
const fixtures = require('../fixtures/guest-agent-replies');

// A fake qemu-ga. mode: ok | silent | no-command | huge | malformed | error | wrong-sync
async function startFakeAgent(t, mode, value = fixtures.debianLegacy) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-qga-'));
  const file = path.join(directory, 'qga.sock');
  const seen = [];
  const server = net.createServer(connection => {
    let pending = '';
    let open = true;
    connection.on('close', () => { open = false; });
    connection.on('error', () => {});
    connection.on('data', chunk => {
      if (mode === 'silent') return;
      pending += chunk.toString('latin1');
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).replace(/^\xff+/, '');
        pending = pending.slice(end + 1);
        const request = JSON.parse(line);
        seen.push(request.execute);
        if (request.execute === 'guest-sync-delimited') {
          connection.write(Buffer.from(`\xff${JSON.stringify({return: mode === 'wrong-sync' ? request.arguments.id + 1 : request.arguments.id})}\n`, 'latin1'));
        } else if (mode === 'no-command') {
          // answers the handshake, never the command
        } else if (mode === 'huge') {
          const block = Buffer.alloc(16384, 0x41);
          const flood = () => { while (open && connection.write(block)); if (open) connection.once('drain', flood); };
          flood();
        } else if (mode === 'malformed') connection.write('this is not json\n');
        else if (mode === 'error') connection.write(`${JSON.stringify({error: {class: 'CommandNotFound', desc: 'Command has been disabled'}})}\n`);
        else connection.write(`${JSON.stringify({return: value})}\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(file, resolve));
  t.after(() => { server.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  return {file, seen};
}

test('a normal agent: handshake, then the one command, and the reply value comes back', async t => {
  const agent = await startFakeAgent(t, 'ok');
  const value = await queryAgent(agent.file, 'guest-network-get-interfaces', {timeoutMs: 1000});
  assert.deepEqual(value, fixtures.debianLegacy);
  assert.deepEqual(agent.seen, ['guest-sync-delimited', 'guest-network-get-interfaces']);
});

test('only the read-only commands of the allowlist can be sent; nothing is connected for the others', async () => {
  assert.deepEqual([...ALLOWED_COMMANDS].sort(), ['guest-info', 'guest-network-get-interfaces', 'guest-ping']);
  for (const command of ['guest-exec', 'guest-file-open', 'guest-shutdown', 'guest-set-user-password', 'guest-ssh-add-authorized-keys', '', 'guest-ping; guest-exec']) {
    await assert.rejects(queryAgent('/nonexistent/qga.sock', command), /not allowed/, command);
  }
});

test('an agent that never answers (stopped, absent, starting): the call ends at the deadline', async t => {
  const agent = await startFakeAgent(t, 'silent');
  const started = Date.now();
  await assert.rejects(queryAgent(agent.file, 'guest-ping', {timeoutMs: 200}), /did not answer/);
  assert.ok(Date.now() - started < 1500);
});

test('an agent that answers the handshake but not the command: the same deadline', async t => {
  const agent = await startFakeAgent(t, 'no-command');
  await assert.rejects(queryAgent(agent.file, 'guest-ping', {timeoutMs: 200}), /did not answer/);
  assert.deepEqual(agent.seen, ['guest-sync-delimited', 'guest-ping']);
});

test('no socket yet (QEMU starting, host stopped): an error, not a hang', async () => {
  await assert.rejects(queryAgent(path.join(os.tmpdir(), 'qw-no-such-dir', 'qga.sock'), 'guest-ping', {timeoutMs: 500}), /ENOENT/);
});

test('an endless reply is cut at the byte cap and the connection is dropped', async t => {
  const agent = await startFakeAgent(t, 'huge');
  const started = Date.now();
  await assert.rejects(queryAgent(agent.file, 'guest-network-get-interfaces', {timeoutMs: 3000, maxBytes: 4096}), /too long/);
  assert.ok(Date.now() - started < 2500, 'the cap ends the call long before the deadline');
});

test('a malformed reply, an agent error and a wrong handshake id are refused', async t => {
  await assert.rejects(queryAgent((await startFakeAgent(t, 'malformed')).file, 'guest-ping', {timeoutMs: 1000}), /malformed/);
  await assert.rejects(queryAgent((await startFakeAgent(t, 'error')).file, 'guest-ping', {timeoutMs: 1000}), /refused the command/);
  await assert.rejects(queryAgent((await startFakeAgent(t, 'wrong-sync')).file, 'guest-ping', {timeoutMs: 1000}), /handshake/);
});

test('a forged reply is returned as data: the validation is the job of common/guest-addresses.js', async t => {
  const value = await queryAgent((await startFakeAgent(t, 'ok', fixtures.hostile)).file, 'guest-network-get-interfaces', {timeoutMs: 1000});
  assert.deepEqual(value, fixtures.hostile);
});

// --- the poller, with fake timers and a fake query ---------------------------------------------------------

function pollerFixture({answers}) {
  const events = new EventEmitter();
  const sent = [];
  events.on('guest-info', payload => sent.push(payload));
  const timers = [];
  const calls = [];
  const queue = [...answers];
  const guest = createGuestAgent({events}, {
    query: (file, command, options) => { calls.push({file, command, options}); const next = queue.shift(); return next instanceof Error ? Promise.reject(next) : Promise.resolve(next); },
    queryVBox: async () => { throw new Error('VirtualBox must not be asked'); },
    setTimer: (fn, ms) => { const timer = {fn, ms, cleared: false, unref() {}}; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; },
    random: () => 0.5
  });
  const node = {id: 'h-0000000000000001', kind: 'host', engine: 'qemu', machine: {}, generation: 1, guestAgentPath: '/run/qga.sock',
    guestAddresses: {}, networkInterfaces: [{mac: '52:54:00:aa:bb:01'}, {mac: '52:54:00:aa:bb:02'}]};
  const pending = () => timers.filter(timer => !timer.cleared && !timer.fired);
  const fire = async () => { const timer = pending().at(-1); timer.fired = true; await timer.fn(); return timer; };
  return {guest, node, sent, timers, calls, pending, fire};
}
const SILENT = new Error('The guest agent did not answer.');

test('a system without the agent is never polled', () => {
  const fx = pollerFixture({answers: []});
  fx.guest.watch(fx.node, {guestAgent: false});
  fx.guest.watch(fx.node, {});
  assert.equal(fx.timers.length, 0);
  assert.equal(fx.guest.watching(fx.node.id), false);
});

test('a host with the agent: the first poll after 2 s, the address is published, then a poll every 5 s', async () => {
  const fx = pollerFixture({answers: [fixtures.debianLegacy, fixtures.debianLegacy]});
  fx.guest.watch(fx.node, {guestAgent: true});
  assert.equal(fx.pending()[0].ms, 2000);
  await fx.fire();
  assert.deepEqual(fx.calls[0], {file: '/run/qga.sock', command: 'guest-network-get-interfaces', options: {timeoutMs: 2000}});
  assert.deepEqual(fx.sent, [{nodeId: fx.node.id, addresses: {0: ['10.1.2.3/24']}}]);
  assert.deepEqual(fx.node.guestAddresses, {0: ['10.1.2.3/24']});
  assert.equal(fx.pending()[0].ms, 5000);
  await fx.fire();
  assert.equal(fx.sent.length, 1, 'an unchanged reply sends no event');
});

test('a change in the guest (ip addr add, DHCP lease) is published once', async () => {
  const fx = pollerFixture({answers: [fixtures.debianLegacy, fixtures.alpineChanged.map(face => ({...face, 'hardware-address': face.name === 'eth0' ? '52:54:00:aa:bb:01' : face['hardware-address']}))]});
  fx.guest.watch(fx.node, {guestAgent: true});
  await fx.fire();
  await fx.fire();
  assert.deepEqual(fx.sent.map(event => event.addresses), [{0: ['10.1.2.3/24']}, {0: ['192.168.7.9/28']}]);
});

test('a silent agent: nothing is shown, no error, and the interval grows to 10 s', async () => {
  const fx = pollerFixture({answers: [SILENT, SILENT, SILENT, SILENT, SILENT]});
  fx.guest.watch(fx.node, {guestAgent: true});
  const delays = [];
  for (let attempt = 0; attempt < 5; attempt++) { await fx.fire(); delays.push(fx.pending()[0].ms); }
  assert.deepEqual(delays, [3000, 4500, 6750, 10000, 10000]);
  assert.deepEqual(fx.sent, []);
});

test('the agent comes up late: the first answer publishes and the interval goes back to 5 s', async () => {
  const fx = pollerFixture({answers: [SILENT, SILENT, fixtures.debianLegacy]});
  fx.guest.watch(fx.node, {guestAgent: true});
  await fx.fire(); await fx.fire(); await fx.fire();
  assert.deepEqual(fx.sent.map(event => event.addresses), [{0: ['10.1.2.3/24']}]);
  assert.equal(fx.pending()[0].ms, 5000);
});

test('two failed polls in a row clear the addresses (the guest rebooted or the agent stopped), one does not', async () => {
  const fx = pollerFixture({answers: [fixtures.debianLegacy, SILENT, SILENT, fixtures.debianLegacy]});
  fx.guest.watch(fx.node, {guestAgent: true});
  await fx.fire();
  await fx.fire();
  assert.deepEqual(fx.node.guestAddresses, {0: ['10.1.2.3/24']}, 'one failure keeps the last answer');
  await fx.fire();
  assert.deepEqual(fx.node.guestAddresses, {});
  assert.deepEqual(fx.sent.at(-1), {nodeId: fx.node.id, addresses: {}});
  await fx.fire();
  assert.deepEqual(fx.node.guestAddresses, {0: ['10.1.2.3/24']});
});

test('a malformed reply counts as a failure and never reaches the node', async () => {
  const fx = pollerFixture({answers: ['not a list', {}, null]});
  fx.guest.watch(fx.node, {guestAgent: true});
  for (let attempt = 0; attempt < 3; attempt++) await fx.fire();
  assert.deepEqual(fx.sent, []);
  assert.deepEqual(fx.node.guestAddresses, {});
});

test('hostile replies publish only well formed strings', async () => {
  const fx = pollerFixture({answers: [fixtures.hostile]});
  fx.guest.watch(fx.node, {guestAgent: true});
  await fx.fire();
  assert.deepEqual(fx.node.guestAddresses, {0: ['8.8.8.8/24', '2001:db8::5/64']});
  assert.ok(!JSON.stringify(fx.sent).includes('<'));
});

test('one call at a time: the next poll is scheduled only when the previous one is over', async () => {
  const fx = pollerFixture({answers: []});
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const events = new EventEmitter();
  const timers = [];
  const guest = createGuestAgent({events}, {query: () => gate, setTimer: fn => { const timer = {fn, unref() {}}; timers.push(timer); return timer; }, clearTimer() {}, random: () => 0.5});
  guest.watch(fx.node, {guestAgent: true});
  const running = timers[0].fn();
  assert.equal(timers.length, 1, 'no second timer while the call is in flight');
  release(fixtures.debianLegacy);
  await running;
  assert.equal(timers.length, 2);
});

test('stopping the host clears the addresses at once and cancels the poll; a late answer is ignored', async () => {
  const fx = pollerFixture({answers: [fixtures.debianLegacy]});
  fx.guest.watch(fx.node, {guestAgent: true});
  await fx.fire();
  fx.guest.unwatch(fx.node);
  assert.deepEqual(fx.node.guestAddresses, {});
  assert.deepEqual(fx.sent.at(-1), {nodeId: fx.node.id, addresses: {}});
  assert.equal(fx.guest.watching(fx.node.id), false);
  assert.equal(fx.pending().length, 0, 'the timer was cleared');
});

test('a tick that finds the host stopped, or restarted (another generation), stops by itself', async () => {
  const stopped = pollerFixture({answers: [fixtures.debianLegacy]});
  stopped.guest.watch(stopped.node, {guestAgent: true});
  stopped.node.machine = null;
  await stopped.fire();
  assert.equal(stopped.calls.length, 0);
  assert.equal(stopped.guest.watching(stopped.node.id), false);
  const restarted = pollerFixture({answers: [fixtures.debianLegacy]});
  restarted.guest.watch(restarted.node, {guestAgent: true});
  restarted.node.generation += 1;
  await restarted.fire();
  assert.equal(restarted.calls.length, 0);
});

test('VirtualBox is not asked while guestAgent:vbox is false (the poller is inert for it)', () => {
  const fx = pollerFixture({answers: []});
  fx.node.engine = 'vbox';
  fx.guest.watch(fx.node, {guestAgent: false});
  assert.equal(fx.timers.length, 0);
});

test('the agent socket is accounted in the 107 byte budget and is never the longest path', () => {
  const paths = socketPathsBelowRuntime();
  assert.ok(paths.some(file => file.endsWith(`/${NODE_FILES.qga}`)), 'qga.sock is listed');
  assert.equal(NODE_FILES.qga, 'qga.sock');
  const longest = Math.max(...paths.map(file => Buffer.byteLength(file)));
  assert.ok(Buffer.byteLength(path.join('sessions', '0'.repeat(16), `h-${'0'.repeat(16)}`, NODE_FILES.qga)) <= longest);
  assert.ok(longest + 1 < SOCKET_LIMIT);
});
