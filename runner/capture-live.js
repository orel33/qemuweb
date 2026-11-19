'use strict';

// The live Capture view: the packets of a capture file as text, while they arrive. The only
// place where a program of ours reads a capture: `tcpdump -l -n -r -` is spawned with an argument
// array (never a shell), fed with the growing PCAP file by this module, and its output goes out
// as 'capture-live' events {liveId, data} and, once, {liveId, end: <message>} when the view ends
// by itself (the capture stopped and was read to its end, tcpdump failed or is missing). A view
// asked to stop sends nothing more. Nothing is left behind: the tcpdump process is killed when
// the view stops, the node is removed or the session shuts down.
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const {StringDecoder} = require('string_decoder');
const {validateFilter, LIVE_ID, MAX_LIVE} = require('../common/capture');
const {statusError} = require('./commands/errors');

const READ_BLOCK = 64 * 1024;
const POLL_MS = 100;
const FLUSH_MS = 50;
const FLUSH_BYTES = 32 * 1024;
// Output waiting above this pauses tcpdump (and so the reading of the file) until it is sent; sending itself waits
// while the control connection is congested (ctx.flow.paused, runner/endpoint.js).
const HIGH_MARK = 256 * 1024;
const KILL_AFTER_MS = 2000;
const SBIN = ['/usr/sbin', '/sbin', '/usr/local/sbin'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The absolute path of tcpdump: the PATH of the runner, then the sbin directories a user PATH often lacks.
function findTcpdump(env = process.env) {
  for (const directory of [...(env.PATH || '').split(path.delimiter), ...SBIN]) {
    if (!directory) continue;
    const candidate = path.join(directory, 'tcpdump');
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch (_) { /* Not here. */ }
  }
  return null;
}

function createCaptureLive(ctx, {locate = findTcpdump, spawnProcess = spawn} = {}) {
  const lives = new Map(); // liveId -> {nodeId, stop()}

  const emit = payload => ctx.events.emit('capture-live', payload);

  // Starts the view of capture `captureId` of `node`. Answers at once; the text comes as events.
  function start(node, {liveId, captureId, filter}) {
    if (typeof liveId !== 'string' || !LIVE_ID.test(liveId) || lives.has(liveId)) throw statusError('Invalid live view.', 400);
    let expression;
    try { expression = validateFilter(filter); } catch (error) { throw statusError(error.message, 400); }
    if (lives.size >= MAX_LIVE) throw statusError(`At most ${MAX_LIVE} live captures at once.`, 409);
    const file = ctx.capture.fileOf(node, captureId);
    const tcpdump = locate();
    if (!tcpdump) throw statusError('tcpdump is not installed on the machine of the runner; install it (see docs/install.md).', 409);
    const args = ['-l', '-n', '-r', '-', ...(expression ? ['--', expression] : [])];
    const child = spawnProcess(tcpdump, args, {stdio: ['pipe', 'pipe', 'pipe']});
    const live = {nodeId: node.id, stopped: false, ended: false, pending: '', paused: false, timer: null, killer: null};
    lives.set(liveId, live);

    const flush = () => {
      live.timer = null;
      if (live.stopped) return;
      if (ctx.flow?.paused) { live.timer = setTimeout(flush, FLUSH_MS * 4); return; }
      while (live.pending) {
        emit({liveId, data: live.pending.slice(0, FLUSH_BYTES)});
        live.pending = live.pending.slice(FLUSH_BYTES);
      }
      if (live.paused) { live.paused = false; child.stdout.resume(); child.stderr.resume(); }
    };
    const push = chunk => {
      if (live.stopped) return;
      live.pending += chunk;
      if (!live.timer) live.timer = setTimeout(flush, FLUSH_MS);
      if (live.pending.length > HIGH_MARK && !live.paused) { live.paused = true; child.stdout.pause(); child.stderr.pause(); }
    };
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    child.stdout.on('data', chunk => push(decoders[0].write(chunk)));
    child.stderr.on('data', chunk => push(decoders[1].write(chunk)));
    child.stdin.on('error', () => {});

    // The file is read from its start, up to its end, then as it grows while the capture records.
    (async () => {
      let fd;
      try {
        fd = await fs.promises.open(file.path, 'r');
        let offset = 0;
        for (;;) {
          if (live.stopped || live.ended) break;
          let recording = false;
          try { recording = ctx.capture.fileOf(node, captureId).recording; } catch (_) { /* Deleted: read what is left. */ }
          const block = Buffer.alloc(READ_BLOCK);
          const {bytesRead} = await fd.read(block, 0, READ_BLOCK, offset);
          if (bytesRead > 0) {
            offset += bytesRead;
            if (!child.stdin.write(block.subarray(0, bytesRead))) await new Promise(resolve => child.stdin.once('drain', resolve).once('close', resolve));
          } else if (!recording) break;
          else await sleep(POLL_MS);
        }
      } catch (error) {
        if (!live.stopped) finish(`Cannot read the capture: ${error.message}`);
      } finally {
        if (fd) await fd.close().catch(() => {});
        if (!child.stdin.destroyed) child.stdin.end();
      }
    })();

    function finish(message) {
      if (live.ended || live.stopped) return;
      live.ended = true;
      live.message = message;
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    child.once('error', error => {
      if (live.stopped) return;
      live.ended = true;
      live.message = `Cannot run tcpdump: ${error.message}`;
      closed();
    });
    child.once('close', code => closed(code));

    function closed(code = 0) {
      live.ended = true;
      clearTimeout(live.killer);
      clearTimeout(live.timer);
      if (!lives.delete(liveId)) return;
      if (live.stopped) return;
      for (const decoder of decoders) live.pending += decoder.end();
      const rest = live.pending;
      live.pending = '';
      for (let at = 0; at < rest.length; at += FLUSH_BYTES) emit({liveId, data: rest.slice(at, at + FLUSH_BYTES)});
      emit({liveId, end: live.message || (code ? `tcpdump stopped (status ${code}).` : 'End of the capture.')});
    }

    live.stop = () => {
      if (live.stopped) return;
      live.stopped = true;
      live.pending = '';
      clearTimeout(live.timer);
      lives.delete(liveId);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        live.killer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, KILL_AFTER_MS);
        live.killer.unref();
      }
    };
    return {liveId};
  }

  function stop(liveId) {
    lives.get(liveId)?.stop();
    return {ok: true};
  }

  // Every view of a node, or of the session when nodeId is omitted.
  function stopNode(nodeId = null) {
    for (const live of [...lives.values()]) if (!nodeId || live.nodeId === nodeId) live.stop();
  }

  return {start, stop, stopNode, count: () => lives.size};
}

module.exports = {createCaptureLive, findTcpdump};
