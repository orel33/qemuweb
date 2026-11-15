'use strict';

// Periodic CPU and memory sampling of running hosts (QEMU through /proc, VirtualBox through VBoxManage metrics).
const fs = require('fs');
const {execFile} = require('child_process');
const {promisify} = require('util');
const {parseHostCpu, parseProcessCpu, parseProcessRss, processCpuPercent, parseVBoxMetrics} = require('./metrics');

function createResources(ctx) {
  const execFileAsync = promisify(execFile);
  let samplingResources = false;

  function resourceResult(cpuPercent, ramBytes) {
    const available = [cpuPercent, ramBytes].filter(Number.isFinite).length;
    return {status: available === 2 ? 'available' : available ? 'partial' : 'unavailable', cpuPercent, ramBytes};
  }

  async function vboxMetricCommand(args) {
    const {stdout} = await execFileAsync(ctx.commands.VBOXMANAGE, ['metrics', ...args], {encoding: 'utf8', timeout: 2500, maxBuffer: 131072});
    return stdout;
  }

  async function sampleResources() {
    if (samplingResources) return;
    samplingResources = true;
    try {
      const running = [...ctx.session.nodes.values()].filter(node => node.kind === 'host' && node.machine);
      const qemuRunning = running.some(node => node.engine?.startsWith('qemu'));
      const hostCpu = qemuRunning ? parseHostCpu(await fs.promises.readFile('/proc/stat', 'utf8').catch(() => '')) : null;
      await Promise.all(running.map(async node => {
        const machine = node.machine;
        let result;
        if (node.engine?.startsWith('qemu')) {
          const pid = machine.pid;
          const [stat, status] = Number.isInteger(pid) ? await Promise.all([
            fs.promises.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''),
            fs.promises.readFile(`/proc/${pid}/status`, 'utf8').catch(() => '')
          ]) : ['', ''];
          const processCpu = parseProcessCpu(stat);
          const previous = ctx.session.previousProcessSamples.get(node.id);
          const cpuPercent = previous?.machine === machine ? processCpuPercent(previous, processCpu, hostCpu) : null;
          const ramBytes = parseProcessRss(status);
          if (processCpu && hostCpu) ctx.session.previousProcessSamples.set(node.id, {...processCpu, hostTicks: hostCpu.totalTicks, machine});
          result = resourceResult(cpuPercent, ramBytes);
        } else if (node.engine === 'vbox') {
          try {
            if (ctx.session.vboxMetricSetup.get(node.id) !== machine) {
              await vboxMetricCommand(['setup', '--period', '2', '--samples', '1', node.vmName, 'CPU/Load,RAM/Usage']);
              if (node.machine !== machine) return;
              ctx.session.vboxMetricSetup.set(node.id, machine);
            }
            const values = parseVBoxMetrics(await vboxMetricCommand([
              'query', node.vmName, 'CPU/Load/User,CPU/Load/Kernel,RAM/Usage/Used'
            ]));
            result = resourceResult(values.cpuPercent, values.ramBytes);
          } catch (_) { result = resourceResult(null, null); }
        }
        if (result && node.machine === machine) ctx.session.resourceSamples.set(node.id, {machine, result});
      }));
      const runningIds = new Set(running.map(node => node.id));
      for (const id of ctx.session.resourceSamples.keys()) if (!runningIds.has(id)) ctx.session.resourceSamples.delete(id);
      for (const id of ctx.session.previousProcessSamples.keys()) if (!runningIds.has(id)) ctx.session.previousProcessSamples.delete(id);
      for (const id of ctx.session.vboxMetricSetup.keys()) if (!runningIds.has(id)) ctx.session.vboxMetricSetup.delete(id);
    } finally { samplingResources = false; }
  }

  // Latest samples per host, as served by GET /api/metrics.
  function metricsSnapshot() {
    return Object.fromEntries([...ctx.session.nodes.values()].filter(node => node.kind === 'host').map(node => {
      if (!node.machine) return [node.id, {status: 'stopped', cpuPercent: null, ramBytes: null}];
      const sample = ctx.session.resourceSamples.get(node.id);
      return [node.id, sample?.machine === node.machine
        ? sample.result : {status: 'warming', cpuPercent: null, ramBytes: null}];
    }));
  }

  return {sampleResources, metricsSnapshot};
}

module.exports = {createResources};
