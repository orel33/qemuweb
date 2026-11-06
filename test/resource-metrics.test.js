const assert = require('node:assert/strict');
const test = require('node:test');

const {parseHostCpu, parseProcessCpu, parseProcessRss, processCpuPercent, parseVBoxMetrics} = require('../resource-metrics');

test('Linux process counters yield host CPU percentage and resident bytes', () => {
  const fields = Array(50).fill('0');
  fields[0] = 'S';
  fields[11] = '200';
  fields[12] = '50';
  fields[19] = '77';
  const process = parseProcessCpu(`123 (qemu system) ${fields.join(' ')}`);
  const host = parseHostCpu('cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50\ncpu1 50\n');

  assert.deepEqual(process, {ticks: 250, started: '77'});
  assert.deepEqual(host, {totalTicks: 1000, cores: 2});
  assert.equal(processCpuPercent({ticks: 100, started: '77', hostTicks: 500}, process, host), 60);
  assert.equal(parseProcessRss('Name:\tqemu\nVmRSS:\t1024 kB\n'), 1048576);
});

test('CPU sampling waits for two matching process samples and rejects PID reuse', () => {
  const current = {ticks: 200, started: '99'};
  const host = {totalTicks: 1000, cores: 4};
  assert.equal(processCpuPercent(null, current, host), null);
  assert.equal(processCpuPercent({ticks: 100, started: '98', hostTicks: 500}, current, host), null);
  assert.equal(parseProcessRss('Name:\tqemu\n'), null);
});

test('VirtualBox metrics use process CPU and resident RAM, with missing data unavailable', () => {
  const output = 'Object Metric Values\n------------ -------------------- ----------\n'
    + 'qemuweb-test CPU/Load/User 12.50%\n'
    + 'qemuweb-test CPU/Load/Kernel 2.25%\n'
    + 'qemuweb-test RAM/Usage/Used 204800 kB\n';
  assert.deepEqual(parseVBoxMetrics(output), {cpuPercent: 14.8, ramBytes: 209715200});
  assert.deepEqual(parseVBoxMetrics('Object Metric Values\n'), {cpuPercent: null, ramBytes: null});
});
