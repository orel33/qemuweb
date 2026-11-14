'use strict';

const os = require('os');

// CPU is host process time: 100% is one fully occupied logical CPU.
function parseHostCpu(stat) {
  const lines = stat.split('\n');
  const total = /^cpu[ \t]+([\d \t]+)/.exec(lines[0] || '');
  if (!total) return null;
  const ticks = total[1].trim().split(/\s+/).map(Number);
  const cores = lines.filter(line => /^cpu\d+\s/.test(line)).length;
  if (!cores || ticks.some(value => !Number.isFinite(value))) return null;
  // guest and guest_nice are already included in user and nice.
  return {totalTicks: ticks.slice(0, 8).reduce((sum, value) => sum + value, 0), cores};
}

function getHostCpuTicks() {
  const cpus = os.cpus();
  if (!cpus || !cpus.length) return null;
  let totalTicks = 0;
  for (const cpu of cpus) {
    const {user, nice, sys, idle, irq} = cpu.times;
    totalTicks += (user + nice + sys + idle + irq);
  }
  return {totalTicks, cores: cpus.length};
}

function parsePsOutput(stdout) {
  const parts = stdout.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const cpu = parseFloat(parts[0]);
  const rssKb = parseInt(parts[1], 10);
  if (!Number.isFinite(cpu) || !Number.isFinite(rssKb)) return null;
  return {
    cpuPercent: Math.round(cpu * 10) / 10,
    ramBytes: rssKb * 1024
  };
}

function parseProcessCpu(stat) {
  // The command field is in parentheses and can contain spaces or ')'.
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const user = Number(fields[11]); // utime, field 14
  const kernel = Number(fields[12]); // stime, field 15
  const started = fields[19]; // starttime, field 22; guards against PID reuse
  if (!Number.isFinite(user) || !Number.isFinite(kernel) || !/^\d+$/.test(started || '')) return null;
  return {ticks: user + kernel, started};
}

function parseProcessRss(status) {
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  return match ? Number(match[1]) * 1024 : null;
}

function processCpuPercent(previous, current, host) {
  if (!previous || !current || !host || previous.started !== current.started) return null;
  const processTicks = current.ticks - previous.ticks;
  const totalTicks = host.totalTicks - previous.hostTicks;
  if (processTicks < 0 || totalTicks <= 0) return null;
  return Math.round(processTicks / totalTicks * host.cores * 1000) / 10;
}

function parseVBoxMetrics(output) {
  const values = {};
  for (const line of output.split('\n')) {
    const match = /^\s*\S+\s+(CPU\/Load\/(?:User|Kernel)|RAM\/Usage\/Used)\s+([\d.]+)\s*(%|kB)(?:\s|$)/.exec(line);
    if (!match) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) values[match[1]] = {value, unit: match[3]};
  }
  const user = values['CPU/Load/User'];
  const kernel = values['CPU/Load/Kernel'];
  const ram = values['RAM/Usage/Used'];
  return {
    cpuPercent: user?.unit === '%' && kernel?.unit === '%' ? Math.round((user.value + kernel.value) * 10) / 10 : null,
    ramBytes: ram?.unit === 'kB' ? ram.value * 1024 : null
  };
}

module.exports = {parseHostCpu, parseProcessCpu, parseProcessRss, processCpuPercent, parseVBoxMetrics, getHostCpuTicks, parsePsOutput};
