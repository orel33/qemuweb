'use strict';

// Console and session summary commands. Each command receives {session, runner} and the
// request arguments. Console input has no command: it arrives as 'input' messages
// (runner/service.js input()).

const commands = {
  // The node-snapshot content (state, logs, serial buffer) sent when a browser selects a
  // console. nodeId is a console ID (common/console-id.js): a node ID, or '<node ID>:1' for ttyS1.
  'console.attach': ({runner}, {nodeId}) => runner.attachConsole(nodeId),

  // Switch terminal size; ignored for a host or a stopped switch.
  'console.resize': ({session, runner}, {nodeId, cols, rows}) => {
    const node = session.nodes.get(nodeId);
    if (!node || node.kind !== 'switch' || !node.switchTerminal) return {ok: false};
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) return {ok: false};
    runner.resizeSwitchTerminal(node, cols, rows);
    return {ok: true};
  },

  // Clears the buffer of a console (console ID), keeping the current prompt line.
  'console.clear': ({runner}, {nodeId, line, column}) => {
    const target = runner.resolveConsole(nodeId);
    if (!target) return {ok: false};
    const text = typeof line === 'string' ? line.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 1024) : '';
    const at = Number.isInteger(column) ? Math.max(0, Math.min(column, 1024)) : text.length;
    runner.clearConsole(target.node, text, at, target.channel);
    return {ok: true};
  },

  // The node IDs of the session (view states are validated against them).
  'nodes.ids': ({session}) => [...session.nodes.keys()],

  // Counts for the supervision page /admin.
  'session.summary': ({session, runner}) => {
    const nodes = [...session.nodes.values()];
    const hosts = nodes.filter(node => node.kind === 'host');
    const runningHosts = hosts.filter(node => node.machine);
    const runningSwitches = nodes.filter(node => node.kind === 'switch' && node.machine);
    const metrics = runner.metricsSnapshot();
    const cpu = runningHosts.map(node => metrics[node.id]?.cpuPercent).filter(Number.isFinite);
    return {
      nodes: nodes.length, hosts: hosts.length, switches: nodes.length - hosts.length,
      runningHosts: runningHosts.length, runningSwitches: runningSwitches.length,
      reservedRamMb: runningHosts.reduce((sum, node) => sum + (node.launchSettings?.memory || 0), 0),
      cpuPercent: cpu.length ? Math.round(cpu.reduce((sum, value) => sum + value, 0) * 10) / 10 : null,
      active: runningHosts.length + runningSwitches.length > 0
    };
  }
};

module.exports = {commands};
