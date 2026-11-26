'use strict';

// runner.status (ADM04): what scripts/status.sh shows for a runner of this machine, measured by the
// runner itself so that it works for a remote runner too. Read-only, and limited to the runner's own
// processes: the runner (process.pid), and the children it started and holds (node.machine.pid of a
// QEMU host or a vde_switch, node.switchTerminal.pid of a vdeterm). It never lists the processes of
// the machine, never reads a command line, an environment or a path: only /proc/stat and
// /proc/<pid>/stat and /proc/<pid>/status of those pids (parsed by runner/metrics.js). A VirtualBox
// VM is detached from the runner (its VBoxHeadless belongs to the VirtualBox daemon): its memory and
// CPU come from the samples the runner already takes (runner/resources.js, VBoxManage metrics), its
// pid is not known (null).
// CPU is in percent of one logical CPU, between two samples: the previous call's, or, when a pid has
// no recent sample, two samples SAMPLE_GAP_MS apart (an asynchronous wait). Calls made while a
// measurement runs share it.
// The shape is described in common/runner-status.js. The result is bounded: at most MAX_SESSIONS sessions and MAX_NODES nodes in all (truncated: true
// beyond), texts cut to MAX_TEXT characters.
const fs = require('fs');
const {parseHostCpu, parseProcessCpu, parseProcessRss, processCpuPercent} = require('./metrics');
const {MAX_SESSIONS, MAX_NODES, MAX_TEXT, roundCpu, totalsOf} = require('../common/runner-status');

const SAMPLE_GAP_MS = 500;
const SAMPLE_MAX_AGE_MS = 60000;

const text = value => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : null);
// The sum of the known values, null when none is known.
const sumKnown = values => (values.some(Number.isFinite) ? values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0) : null);

// The configured memory of a host in MB: the settings it runs with, else its launch settings.
function configuredMemoryMb(node) {
  const memory = (node.machine && node.activeConfig ? node.activeConfig.settings : node.launchSettings)?.memory;
  return Number.isSafeInteger(memory) && memory > 0 ? memory : null;
}

// The pids a node is measured by, the first one shown: [qemu] or [vde_switch, vdeterm]; none for a
// stopped node or a VirtualBox host.
function nodePids(node) {
  if (!node.machine) return [];
  if (node.kind === 'switch') return [node.machine.pid, node.switchTerminal?.pid].filter(Number.isSafeInteger);
  return node.engine === 'vbox' ? [] : [node.machine.pid].filter(Number.isSafeInteger);
}

// `readFile(path)` returns the text of a /proc file or '' (injected by the unit tests). `now()` and
// `uptime()` (seconds) are the clock and the runner's uptime; `wait(ms)` an asynchronous pause.
function createRunnerStatus({readFile = file => { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; } },
  pid = process.pid, now = Date.now, uptime = process.uptime, wait = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  let previous = {at: 0, processes: new Map()};
  let running = null;

  // {at, host, processes: pid -> {cpu, rssBytes}} for the given pids.
  function sample(pids) {
    const host = parseHostCpu(readFile('/proc/stat'));
    const processes = new Map();
    for (const item of pids) {
      const cpu = parseProcessCpu(readFile(`/proc/${item}/stat`));
      if (cpu) processes.set(item, {cpu: {...cpu, hostTicks: host?.totalTicks}, rssBytes: parseProcessRss(readFile(`/proc/${item}/status`))});
    }
    return {at: now(), host, processes};
  }

  async function measure(pids) {
    const fresh = now() - previous.at <= SAMPLE_MAX_AGE_MS;
    if (!fresh || pids.some(item => !previous.processes.has(item))) {
      previous = sample(pids);
      await wait(SAMPLE_GAP_MS);
    }
    const current = sample(pids);
    const result = new Map();
    for (const item of pids) {
      const entry = current.processes.get(item);
      if (!entry) continue;
      const before = previous.processes.get(item);
      result.set(item, {rssBytes: entry.rssBytes, cpuPercent: before ? processCpuPercent(before.cpu, entry.cpu, current.host) : null});
    }
    previous = current;
    return result;
  }

  // `sessions`: the runner's Session objects. Returns the status (see the header of this file).
  function status(sessions) {
    if (!running) running = build([...sessions]).finally(() => { running = null; });
    return running;
  }

  async function build(sessions) {
    let truncated = sessions.length > MAX_SESSIONS;
    let budget = MAX_NODES;
    const kept = sessions.slice(0, MAX_SESSIONS).map(session => {
      const nodes = [...session.nodes.values()];
      if (nodes.length > budget) truncated = true;
      const shown = nodes.slice(0, budget);
      budget -= shown.length;
      return {session, nodes: shown};
    });
    const pids = [pid, ...kept.flatMap(item => item.nodes.flatMap(nodePids))];
    const measured = await measure([...new Set(pids)]);
    const at = now();
    const sessionList = kept.map(({session, nodes}) => {
      const nodeList = nodes.map(node => nodeStatus(node, session, measured)).sort((a, b) =>
        (a.kind === b.kind ? 0 : a.kind === 'switch' ? -1 : 1) || String(a.name || '').localeCompare(String(b.name || '')));
      const created = Date.parse(session.createdAt);
      return {sessionId: session.id, owner: text(session.owner), createdAt: Number.isFinite(created) ? new Date(created).toISOString() : null,
        ageSeconds: Number.isFinite(created) ? Math.max(0, Math.round((at - created) / 1000)) : null, nodes: nodeList, totals: totalsOf(nodeList)};
    });
    const self = measured.get(pid);
    return {
      runner: {pid, uptimeSeconds: Math.round(uptime()), rssBytes: self?.rssBytes ?? null, cpuPercent: roundCpu(self?.cpuPercent)},
      sessions: sessionList, totals: totalsOf(sessionList.flatMap(item => item.nodes)), truncated, sampledAt: new Date(at).toISOString()
    };
  }

  function nodeStatus(node, session, measured) {
    const pids = nodePids(node);
    const values = pids.map(item => measured.get(item)).filter(Boolean);
    let rssBytes = sumKnown(values.map(item => item.rssBytes));
    let cpuPercent = sumKnown(values.map(item => item.cpuPercent));
    if (node.kind === 'host' && node.engine === 'vbox' && node.machine) {
      const sample = session.resourceSamples?.get(node.id);
      const result = sample?.machine === node.machine ? sample.result : null;
      rssBytes = Number.isFinite(result?.ramBytes) ? result.ramBytes : null;
      cpuPercent = Number.isFinite(result?.cpuPercent) ? result.cpuPercent : null;
    }
    const host = node.kind === 'host';
    return {id: node.id, name: text(node.hostname), kind: host ? 'host' : 'switch', system: host ? text(node.selectedImage?.id) : null,
      engine: host ? text(node.engine) : 'vde', running: !!node.machine, pid: pids[0] ?? null, rssBytes: node.machine ? rssBytes : null,
      memoryMb: host ? configuredMemoryMb(node) : null, cpuPercent: node.machine ? roundCpu(cpuPercent) : null};
  }

  return {status};
}

module.exports = {createRunnerStatus, SAMPLE_GAP_MS};
