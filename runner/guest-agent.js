'use strict';

// Live addresses of a running host, read from the guest: the QEMU guest agent (a virtio-serial channel
// exposed as <node dir>/qga.sock) or, inert for now, the VirtualBox Guest Additions properties.
// The guest is untrusted (a student is root in it): this module sends ONE fixed read-only command, caps and
// times every reply, validates everything (common/guest-addresses.js) and publishes strings that are
// informational only. Design, measurements and the safety rules: docs/guest-agent.md.
//
// Per host with `guestAgent` true in its system profile: while the host runs, one poll at a time
// (`guest-network-get-interfaces`, 2 s deadline, 64 KB cap), every 5 s after an answer; without an answer
// the interval grows from 2 s by 1.5x up to 10 s (an agent starts late in the boot, and a guest without
// agent costs one failed connect or one silent call per 10 s). The addresses are cleared after two failed
// polls in a row and when the host stops. Result: node.guestAddresses = {"<nic index>": ["10.0.0.1/24"]},
// sent as the `guest-info` event {nodeId, addresses} only when it changes.
const net = require('net');
const {LIMITS, parseGuestInterfaces, matchAddresses, sameAddresses} = require('../common/guest-addresses');
const {queryVirtualBox} = require('./engines/vbox-guest');

// The ONLY commands this runner ever sends to a guest agent. Nothing takes a command from outside.
const ALLOWED_COMMANDS = new Set(['guest-ping', 'guest-info', 'guest-network-get-interfaces']);
const TIMEOUT_MS = 2000;
const FIRST_DELAY_MS = 2000;
const STEADY_DELAY_MS = 5000;
const MAX_BACKOFF_MS = 10000;
const CLEAR_AFTER_FAILURES = 2;
const SYNC_MARK = 0xff;

// Asks one agent one allowed command. The handshake is guest-sync-delimited (an id the guest must echo; the
// 0xFF byte makes the agent drop what a previous, abandoned call left in its buffer). Rejects on a refused
// command, an agent error, a malformed reply, more than `maxBytes` read in total, or no reply within
// `timeoutMs`; resolves the `return` value. `connect` is injectable for tests.
function queryAgent(socketPath, command, {timeoutMs = TIMEOUT_MS, maxBytes = LIMITS.replyBytes, connect = net.createConnection} = {}) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_COMMANDS.has(command)) { reject(new Error(`Command not allowed: ${command}`)); return; }
    const id = Math.floor(Math.random() * 2 ** 31);
    let socket = null;
    let done = false;
    let stage = 'sync';
    let received = 0;
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('The guest agent did not answer.')), timeoutMs);
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (socket) socket.destroy();
      if (error) reject(error); else resolve(value);
    }
    function parse(bytes) {
      try { return JSON.parse(bytes.toString('utf8')); } catch (_) { return undefined; }
    }
    function onData(chunk) {
      received += chunk.length;
      if (received > maxBytes) { finish(new Error('The guest agent reply is too long.')); return; }
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'sync') {
        const mark = buffer.lastIndexOf(SYNC_MARK);
        const end = mark < 0 ? -1 : buffer.indexOf(0x0a, mark);
        if (end < 0) return;
        const reply = parse(buffer.subarray(mark + 1, end));
        if (reply?.return !== id) { finish(new Error('The guest agent handshake failed.')); return; }
        buffer = buffer.subarray(end + 1);
        stage = 'command';
        socket.write(`${JSON.stringify({execute: command})}\n`);
      }
      if (stage === 'command') {
        const end = buffer.indexOf(0x0a);
        if (end < 0) return;
        let start = 0;
        while (start < end && buffer[start] === SYNC_MARK) start += 1;
        const reply = parse(buffer.subarray(start, end));
        if (reply === undefined || reply === null || typeof reply !== 'object') finish(new Error('The guest agent reply is malformed.'));
        else if (reply.error !== undefined) finish(new Error('The guest agent refused the command.'));
        else finish(null, reply.return);
      }
    }
    try {
      socket = connect(socketPath);
      socket.on('error', error => finish(error));
      socket.on('close', () => finish(new Error('The guest agent connection closed.')));
      socket.on('data', onData);
      socket.on('connect', () => socket.write(`${String.fromCharCode(SYNC_MARK)}${JSON.stringify({execute: 'guest-sync-delimited', arguments: {id}})}\n`, 'latin1'));
    } catch (error) { finish(error); }
  });
}

function createGuestAgent(ctx, {query = queryAgent, queryVBox = queryVirtualBox, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random} = {}) {
  const watchers = new Map();

  function setAddresses(node, addresses) {
    if (sameAddresses(node.guestAddresses || {}, addresses)) return;
    node.guestAddresses = addresses;
    ctx.events.emit('guest-info', {nodeId: node.id, addresses});
  }

  async function interfacesOf(node) {
    if (node.engine?.startsWith('qemu')) return parseGuestInterfaces(await query(node.guestAgentPath, 'guest-network-get-interfaces', {timeoutMs: TIMEOUT_MS}));
    return parseGuestInterfaces(await queryVBox(ctx, node));
  }

  function delayOf(watch) {
    const base = watch.failures === 0 ? (watch.answered ? STEADY_DELAY_MS : FIRST_DELAY_MS) : Math.min(FIRST_DELAY_MS * 1.5 ** watch.failures, MAX_BACKOFF_MS);
    return Math.round(base * (0.9 + 0.2 * random()));
  }

  function schedule(node, watch, delay) {
    watch.timer = setTimer(() => poll(node, watch), delay);
    if (watch.timer?.unref) watch.timer.unref();
  }

  async function poll(node, watch) {
    watch.timer = null;
    if (watchers.get(node.id) !== watch) return;
    if (!node.machine || node.generation !== watch.generation) { unwatch(node); return; }
    try {
      const interfaces = await interfacesOf(node);
      if (watchers.get(node.id) !== watch) return;
      watch.failures = 0;
      watch.answered = true;
      setAddresses(node, matchAddresses(interfaces, node.networkInterfaces));
    } catch (_) {
      if (watchers.get(node.id) !== watch) return;
      watch.failures += 1;
      if (watch.failures >= CLEAR_AFTER_FAILURES) setAddresses(node, {});
    }
    schedule(node, watch, delayOf(watch));
  }

  // Starts reading the addresses of a host that was just started (no-op when its system has no agent).
  function watch(node, image = node.selectedImage) {
    unwatch(node);
    if (node.kind !== 'host' || !image?.guestAgent) return;
    const entry = {generation: node.generation, failures: 0, answered: false, timer: null};
    watchers.set(node.id, entry);
    schedule(node, entry, FIRST_DELAY_MS);
  }

  // Stops reading and clears the addresses (the host stopped, was reset or removed).
  function unwatch(node) {
    const entry = watchers.get(node.id);
    if (entry) {
      if (entry.timer) clearTimer(entry.timer);
      watchers.delete(node.id);
    }
    setAddresses(node, {});
  }

  return {watch, unwatch, watching: nodeId => watchers.has(nodeId)};
}

module.exports = {ALLOWED_COMMANDS, queryAgent, createGuestAgent};
