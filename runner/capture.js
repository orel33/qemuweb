'use strict';

// Traffic capture of one session: QEMU's own `filter-dump` network filter, added to and removed
// from a RUNNING host through the HMP monitor. It sits between a NIC and its netdev inside the
// QEMU process and writes every frame, both directions, to a PCAP file; nothing runs in the guest
// and no program of ours writes the file. Design and findings: docs/architecture.md, "Traffic capture".
//
// A capture is {id, nodeId, interface: 'ethN', index, file, state, reason, startedAt, endedAt, bytes}:
//   state   'recording' | 'stopped'
//   reason  null while recording; 'user' | 'size-limit' | 'host-stopped' | 'error' when stopped
// The files are <node dir>/captures/<id>.pcap, named by this module only. The records live in
// memory (they die with the session); the files die with the node directory.
const fs = require('fs');
const path = require('path');
const {LIMITS, WATCH_INTERVAL_MS, isCaptureId, interfaceIndex, captureId} = require('../common/capture');
const {statusError} = require('./commands/errors');

const CAPTURE_DIR = 'captures';
// Everything the monitor line could be confused by: whitespace, quotes, backslash, controls.
const UNSAFE_PATH = /[\s"'\\\x00-\x1f\x7f]/;

const REASON_TEXT = {
  user: 'stopped',
  'size-limit': 'stopped: size limit reached',
  'host-stopped': 'stopped: host stopped',
  error: 'stopped: error'
};

function createCapture(ctx) {
  const {appendLog} = ctx.runtime;
  // nodeId -> Map(captureId -> record). A record also holds `machine` (the process it recorded
  // from), `objectId` and `path`, which never leave this module.
  const records = new Map();
  let timer = null;
  const now = ctx.now || (() => new Date());

  const nodeRecords = nodeId => records.get(nodeId) || records.set(nodeId, new Map()).get(nodeId);

  function sizeOf(record) {
    try { return fs.statSync(record.path).size; } catch (_) { return record.bytes || 0; }
  }

  function describe(record) {
    const recording = record.state !== 'stopped';
    return {id: record.id, nodeId: record.nodeId, interface: record.interface, index: record.index, file: `${record.id}.pcap`,
      state: record.state, reason: record.reason, message: recording ? (record.state === 'stopping' ? 'stopping…' : 'recording') : REASON_TEXT[record.reason],
      startedAt: record.startedAt, endedAt: record.endedAt, bytes: recording ? sizeOf(record) : record.bytes};
  }

  const publish = nodeId => ctx.events.emit('captures', {nodeId, captures: list(nodeId)});

  // The captures of a node, oldest first; every node of the session when nodeId is omitted.
  function list(nodeId = null) {
    const nodes = nodeId ? [nodeId] : [...records.keys()];
    return nodes.flatMap(id => [...(records.get(id)?.values() || [])].map(describe));
  }

  function recordOf(node, id) {
    const record = isCaptureId(id) && records.get(node.id)?.get(id);
    if (!record) throw statusError('Unknown capture.', 404);
    return record;
  }

  function schedule() {
    const active = [...records.values()].some(entries => [...entries.values()].some(record => record.state === 'recording'));
    if (active && !timer) {
      timer = setInterval(() => watch().catch(error => console.error('Capture watch:', error)), WATCH_INTERVAL_MS);
      timer.unref();
    } else if (!active && timer) { clearInterval(timer); timer = null; }
  }

  // Marks a capture stopped and keeps the final size of its file.
  function finish(record, reason) {
    record.bytes = sizeOf(record);
    record.state = 'stopped';
    record.reason = reason;
    record.endedAt = now().toISOString();
  }

  // Asks QEMU to drop the filter. A machine that is gone, or a filter QEMU no longer knows, is
  // already what we want.
  async function removeFilter(node, record) {
    if (node.machine !== record.machine) return;
    const reply = await ctx.monitor.sendMonitorCommand(node, `object_del ${record.objectId}`);
    if (reply && !/not found/i.test(reply)) throw new Error(reply);
  }

  async function stopRecord(node, record, reason) {
    if (record.state !== 'recording') return record;
    // Leaves 'recording' before awaiting: the user's Stop and the size watcher never both remove it.
    record.state = 'stopping';
    try { await removeFilter(node, record); }
    catch (error) { appendLog(node, `# Capture ${record.id}: cannot remove the filter: ${error.message}`); reason = 'error'; }
    finish(record, reason);
    appendLog(node, `# Capture ${record.interface} ${REASON_TEXT[reason]}: ${record.id}.pcap (${record.bytes} bytes)`);
    schedule();
    publish(node.id);
    return record;
  }

  async function watch() {
    for (const [nodeId, entries] of records) {
      const node = ctx.session.nodes.get(nodeId);
      for (const record of entries.values()) {
        if (record.state !== 'recording') continue;
        if (!node || node.machine !== record.machine) { hostStopped(node || {id: nodeId}, null, record); continue; }
        if (sizeOf(record) >= LIMITS.maxBytes) await stopRecord(node, record, 'size-limit');
      }
    }
  }

  // The host process is gone (stop, crash, kill): its recordings end, their files stay.
  // `machine` limits it to the recordings of that process (the late exit of an old one).
  function hostStopped(node, machine = null, only = null) {
    let changed = false;
    for (const record of (only ? [only] : records.get(node.id)?.values() || [])) {
      if (record.state !== 'recording' || (machine && record.machine !== machine)) continue;
      finish(record, 'host-stopped');
      changed = true;
    }
    if (!changed) return;
    schedule();
    publish(node.id);
  }

  // The node is being deleted: forget its captures (the files go with the node directory).
  function nodeRemoved(node) {
    hostStopped(node);
    records.delete(node.id);
    schedule();
  }

  function requireCapturable(node, index) {
    if (!node || node.kind !== 'host') throw statusError('Only a host can be captured.', 400);
    if (!node.engine?.startsWith('qemu')) throw statusError('Capture is available for QEMU hosts only.', 409);
    if (!node.machine || node.action || node.stopping) throw statusError('The host is not running.', 409);
    const nic = node.activeConfig?.networkInterfaces[index];
    if (!nic) throw statusError(`The running host has no Ethernet interface eth${index}.`, 409);
    if (nic.switchId === null) throw statusError(`eth${index} is not connected to a switch.`, 409);
    return nic;
  }

  // Starts recording the interface `ethN` (or N) of a running QEMU host.
  async function start(node, value) {
    const index = interfaceIndex(value);
    if (index === null) throw statusError('Unknown interface; use eth0 to eth3.', 400);
    requireCapturable(node, index);
    const entries = nodeRecords(node.id);
    const same = [...entries.values()].find(record => record.index === index && record.state !== 'stopped');
    if (same) throw statusError(`eth${index} is already being captured.`, 409);
    if (entries.size >= LIMITS.maxPerNode) throw statusError(`A host keeps at most ${LIMITS.maxPerNode} captures; delete one first.`, 409);
    const directory = path.join(node.runtimeDir, CAPTURE_DIR);
    if (UNSAFE_PATH.test(directory)) throw statusError('The runtime directory path contains characters the QEMU monitor cannot take; move the project.', 500);
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    // QEMU truncates an existing file: never reuse a name.
    const date = now();
    let id = captureId(index, date);
    for (let repeat = 1; entries.has(id) || fs.existsSync(path.join(directory, `${id}.pcap`)); repeat++) id = captureId(index, date, repeat);
    const record = {id, nodeId: node.id, interface: `eth${index}`, index, state: 'starting', reason: null, startedAt: date.toISOString(),
      endedAt: null, bytes: 0, machine: node.machine, objectId: `cap-${id}`, path: path.join(directory, `${id}.pcap`)};
    entries.set(id, record);
    // The netdev ids are lan<N> (runner/engines/qemu.js); a comma of the path is doubled for QEMU.
    const command = `object_add filter-dump,id=${record.objectId},netdev=lan${index},file=${record.path.replace(/,/g, ',,')},queue=all`;
    appendLog(node, `$ QEMU monitor: ${command}`);
    try {
      const reply = await ctx.monitor.sendMonitorCommand(node, command);
      // QEMU's monitor says nothing when it cannot open the file or find the netdev: the file
      // exists once the filter does.
      if (reply || !fs.existsSync(record.path)) throw new Error(reply || 'QEMU did not create the capture file.');
      if (node.machine !== record.machine) throw new Error('The host stopped.');
    } catch (error) {
      entries.delete(id);
      fs.rmSync(record.path, {force: true});
      appendLog(node, `# Capture ${record.interface} failed: ${error.message}`);
      throw statusError(`Cannot start the capture: ${error.message}`, 500);
    }
    record.state = 'recording';
    appendLog(node, `# Capture ${record.interface} started: ${id}.pcap`);
    schedule();
    publish(node.id);
    return describe(record);
  }

  async function stop(node, id) {
    const record = recordOf(node, id);
    if (record.state === 'starting') throw statusError('The capture is starting.', 409);
    return describe(await stopRecord(node, record, 'user'));
  }

  function remove(node, id) {
    const record = recordOf(node, id);
    if (record.state !== 'stopped') throw statusError('Stop the capture before deleting it.', 409);
    fs.rmSync(record.path, {force: true});
    records.get(node.id).delete(id);
    appendLog(node, `# Capture deleted: ${id}.pcap`);
    publish(node.id);
    return {ok: true};
  }

  // What a download or the live view reads: the file of a capture this module lists.
  function fileOf(node, id) {
    const record = recordOf(node, id);
    if (record.state === 'starting') throw statusError('The capture is starting.', 409);
    return {path: record.path, name: `${record.id}.pcap`, recording: record.state !== 'stopped', size: sizeOf(record)};
  }

  // `poll` is the size watcher's step (a timer calls it; tests too).
  return {list, start, stop, remove, fileOf, hostStopped, nodeRemoved, poll: watch};
}

module.exports = {createCapture, CAPTURE_DIR};
