'use strict';

// The shape of runner.status (ADM04), shared by the runner that builds it (runner/runner-status.js)
// and the control plane that checks it before an administrator sees it (server/runner-status.js):
//   {runner: {pid, uptimeSeconds, rssBytes, cpuPercent},
//    sessions: [{sessionId, owner, createdAt, ageSeconds, totals,
//                nodes: [{id, name, kind, system, engine, running, pid, rssBytes, memoryMb, cpuPercent}]}],
//    totals, truncated, sampledAt}
// totals: {hosts, runningHosts, switches, runningSwitches, rssBytes, memoryMb, cpuPercent}.
// CPU is in percent of one logical CPU; memoryMb is the memory configured for a host; null is unknown.
const MAX_SESSIONS = 256;
const MAX_NODES = 1024;
const MAX_TEXT = 64;

const roundCpu = value => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);
const sum = values => values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);

// Totals of a list of nodes: hosts and switches (and how many run), the memory in use and the memory
// given to the running hosts, the CPU of the running nodes (null when none is known).
function totalsOf(nodes) {
  const up = nodes.filter(node => node.running);
  const cpu = up.map(node => node.cpuPercent);
  return {hosts: nodes.filter(node => node.kind === 'host').length, runningHosts: up.filter(node => node.kind === 'host').length,
    switches: nodes.filter(node => node.kind === 'switch').length, runningSwitches: up.filter(node => node.kind === 'switch').length,
    rssBytes: sum(up.map(node => node.rssBytes)), memoryMb: sum(up.map(node => node.memoryMb)),
    cpuPercent: cpu.some(Number.isFinite) ? roundCpu(sum(cpu)) : null};
}

module.exports = {MAX_SESSIONS, MAX_NODES, MAX_TEXT, roundCpu, totalsOf};
