'use strict';

// runner.status (ADM04): the runner's own process view (runner/runner-status.js) with fake /proc data,
// its bounds, the shared measurement, the control plane's check of an answer (server/runner-status.js)
// and that the command reads only /proc files of the pids it holds.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {createRunnerStatus, SAMPLE_GAP_MS} = require('../../runner/runner-status');
const {sanitizeRunnerStatus} = require('../../server/runner-status');
const {MAX_SESSIONS, MAX_NODES, MAX_TEXT, totalsOf} = require('../../common/runner-status');

const {Session} = require('../../server/session');
const {newEntityId} = require('../../common/node-id');

// IDs from the project's own generators: the tests do not depend on their length.
const newSessionId = () => new Session({}).id;
const SESSION = newSessionId();
const nodeIds = new Map();
const nodeId = (kind, n) => {
  const key = `${kind}-${n}`;
  if (!nodeIds.has(key)) nodeIds.set(key, newEntityId(kind));
  return nodeIds.get(key);
};
// /proc/<pid>/stat: fields after the command; utime is the 14th field, stime the 15th, starttime the 22nd.
const statLine = (pid, ticks, started = 100) => `${pid} (qemu-system-x86) S ${Array.from({length: 49}, (_, i) => (i === 10 ? ticks : i === 11 ? 0 : i === 18 ? started : 1)).join(' ')}`;

// A fake /proc whose CPU counters advance by `step` ticks per sample: host 400 ticks (4 cores), each pid `perPid[pid]`.
function fakeProc(perPid, rssKb = {}) {
  const ticks = {host: 0, ...Object.fromEntries(Object.keys(perPid).map(pid => [pid, 0]))};
  const reads = [];
  const sample = () => {
    ticks.host += 400;
    for (const pid of Object.keys(perPid)) ticks[pid] += perPid[pid];
  };
  const readFile = file => {
    reads.push(file);
    if (file === '/proc/stat') {
      sample();
      return `cpu  ${ticks.host} 0 0 0 0 0 0 0 0 0\ncpu0 1\ncpu1 1\ncpu2 1\ncpu3 1\n`;
    }
    const match = /^\/proc\/(\d+)\/(stat|status)$/.exec(file);
    if (!match || !(match[1] in perPid)) return '';
    return match[2] === 'stat' ? statLine(match[1], ticks[match[1]]) : `Name:\tx\nVmRSS:\t   ${rssKb[match[1]] || 1024} kB\n`;
  };
  return {readFile, reads};
}

function session({id = SESSION, owner = 'alice', nodes = [], createdAt = '2026-11-26T10:00:00.000Z', samples = new Map()} = {}) {
  return {id, owner, createdAt, nodes: new Map(nodes.map(node => [node.id, node])), resourceSamples: samples};
}

const qemuHost = (n, pid, extra = {}) => ({id: nodeId('host', n), kind: 'host', hostname: `pc${n}`, engine: 'qemu', selectedImage: {id: 'debian'},
  machine: {pid}, activeConfig: {settings: {memory: 512}}, launchSettings: {memory: 1024}, ...extra});

test('runner.status: the runner process, each session with its nodes, and the totals, from the pids it holds', async () => {
  const {readFile, reads} = fakeProc({10: 4, 20: 100, 30: 2, 31: 1}, {10: 50000, 20: 300000, 30: 2000, 31: 1000});
  const waits = [];
  const vmMachine = {kind: 'vbox'};
  const sw = {id: nodeId('switch', 1), kind: 'switch', hostname: 'sw', machine: {pid: 30}, switchTerminal: {pid: 31}};
  const vbox = {id: nodeId('host', 3), kind: 'host', hostname: 'vm', engine: 'vbox', selectedImage: {id: 'alpine'}, machine: vmMachine, launchSettings: {memory: 256}};
  const stopped = {id: nodeId('host', 4), kind: 'host', hostname: 'off', engine: 'qemu', selectedImage: {id: 'debian'}, machine: null, launchSettings: {memory: 128}};
  const samples = new Map([[vbox.id, {machine: vmMachine, result: {cpuPercent: 7.5, ramBytes: 200 * 2 ** 20}}]]);
  const sessions = [session({nodes: [qemuHost(2, 20), sw, vbox, stopped], samples})];
  const status = createRunnerStatus({readFile, pid: 10, now: () => Date.parse('2026-11-26T10:01:00.000Z'), uptime: () => 90.4,
    wait: async ms => { waits.push(ms); }});
  const result = await status.status(sessions);
  assert.deepEqual(waits, [SAMPLE_GAP_MS], 'a first call takes two samples, with an asynchronous wait between them');
  assert.deepEqual(result.runner, {pid: 10, uptimeSeconds: 90, rssBytes: 50000 * 1024, cpuPercent: 4});
  const [entry] = result.sessions;
  assert.deepEqual([entry.sessionId, entry.owner, entry.createdAt, entry.ageSeconds], [SESSION, 'alice', '2026-11-26T10:00:00.000Z', 60]);
  assert.deepEqual(entry.nodes.map(node => node.name), ['sw', 'off', 'pc2', 'vm'], 'switches first, then by name');
  const byName = Object.fromEntries(entry.nodes.map(node => [node.name, node]));
  assert.deepEqual(byName.sw, {id: sw.id, name: 'sw', kind: 'switch', system: null, engine: 'vde', running: true, pid: 30, rssBytes: 3000 * 1024, memoryMb: null, cpuPercent: 3});
  assert.deepEqual(byName.pc2, {id: nodeId('host', 2), name: 'pc2', kind: 'host', system: 'debian', engine: 'qemu', running: true, pid: 20, rssBytes: 300000 * 1024, memoryMb: 512, cpuPercent: 100},
    'the memory the host runs with, not its next launch settings');
  assert.deepEqual([byName.vm.pid, byName.vm.rssBytes, byName.vm.cpuPercent, byName.vm.memoryMb], [null, 200 * 2 ** 20, 7.5, 256], 'VirtualBox: the runner\'s samples, no pid');
  assert.deepEqual([byName.off.running, byName.off.pid, byName.off.rssBytes, byName.off.cpuPercent, byName.off.memoryMb], [false, null, null, null, 128]);
  assert.deepEqual(entry.totals, {hosts: 3, runningHosts: 2, switches: 1, runningSwitches: 1, rssBytes: (303000 * 1024) + 200 * 2 ** 20, memoryMb: 768, cpuPercent: 110.5});
  assert.deepEqual(result.totals, entry.totals);
  assert.equal(result.truncated, false);
  // Only /proc/stat and the stat and status files of the pids it holds: no cmdline, environ, cwd or other process.
  assert.ok(reads.every(file => /^\/proc\/(stat|(10|20|30|31)\/(stat|status))$/.test(file)), reads.join(' '));
  const text = JSON.stringify(result);
  for (const word of ['cmdline', 'environ', '/tmp', 'runtime', 'args']) assert.ok(!text.includes(word), word);

  waits.length = 0;
  await status.status(sessions);
  assert.deepEqual(waits, [], 'the next call compares with the previous sample, without waiting');
});

test('runner.status: calls made at once share one measurement; no session gives an empty list', async () => {
  const {readFile, reads} = fakeProc({10: 1});
  let release;
  const status = createRunnerStatus({readFile, pid: 10, wait: () => new Promise(resolve => { release = resolve; })});
  const first = status.status([]);
  const second = status.status([]);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b, 'the same measurement');
  assert.equal(reads.filter(file => file === '/proc/stat').length, 2, 'sampled once (two samples)');
  assert.deepEqual([a.sessions, a.totals.hosts, a.totals.cpuPercent], [[], 0, null]);
});

test('runner.status is bounded: sessions, nodes in all, text length', async () => {
  const {readFile} = fakeProc({10: 1});
  const status = createRunnerStatus({readFile, pid: 10, wait: async () => {}});
  const many = Array.from({length: MAX_SESSIONS + 3}, (_, i) => session({id: newSessionId(), nodes: []}));
  let result = await status.status(many);
  assert.deepEqual([result.sessions.length, result.truncated], [MAX_SESSIONS, true]);
  const big = Array.from({length: MAX_NODES + 5}, (_, i) => ({id: nodeId('host', i), kind: 'host', hostname: 'x'.repeat(500), engine: 'qemu', machine: null}));
  result = await status.status([session({nodes: big.slice(0, 600)}), session({id: newSessionId(), nodes: big.slice(600)})]);
  assert.equal(result.sessions.reduce((total, item) => total + item.nodes.length, 0), MAX_NODES);
  assert.equal(result.truncated, true);
  assert.equal(result.sessions[0].nodes[0].name.length, MAX_TEXT);
});

test('the control plane keeps only valid, bounded fields of a runner\'s answer and recomputes the totals', () => {
  const node = {id: nodeId('host', 1), name: 'pc\u0007<b>', kind: 'switch', system: 'debian', engine: 'qemu', running: true, pid: 42, rssBytes: 1024,
    memoryMb: 512, cpuPercent: 12.345, cmdline: '/usr/bin/qemu -secret'};
  const raw = {runner: {pid: 7, uptimeSeconds: 12, rssBytes: -5, cpuPercent: 'x', env: {HOME: '/root'}}, extra: 'x', sampledAt: 'not a date',
    sessions: [{sessionId: SESSION, owner: 'bad owner!', createdAt: '2026-11-26T10:00:00Z', ageSeconds: 3, nodes: [node, {id: '../x'}, null], totals: {hosts: 999}},
      {sessionId: '../../etc', nodes: []}, 'junk'], totals: {hosts: 999}};
  const clean = sanitizeRunnerStatus(raw);
  assert.deepEqual(clean.runner, {pid: 7, uptimeSeconds: 12, rssBytes: null, cpuPercent: null});
  assert.equal(clean.sessions.length, 1);
  assert.deepEqual(clean.sessions[0].nodes, [{id: node.id, name: 'pc<b>', kind: 'host', system: 'debian', engine: 'qemu', running: true, pid: 42, rssBytes: 1024, memoryMb: 512, cpuPercent: 12.3}],
    'the kind comes from the ID; unknown fields dropped; control characters removed');
  assert.deepEqual([clean.sessions[0].owner, clean.sessions[0].createdAt, clean.sampledAt], [null, '2026-11-26T10:00:00.000Z', null]);
  assert.deepEqual(clean.totals, totalsOf(clean.sessions[0].nodes));
  assert.equal(clean.totals.hosts, 1);
  assert.ok(!JSON.stringify(clean).includes('secret') && !JSON.stringify(clean).includes('/root'));
  assert.deepEqual(sanitizeRunnerStatus(null), {runner: {pid: null, uptimeSeconds: null, rssBytes: null, cpuPercent: null}, sessions: [],
    totals: totalsOf([]), truncated: false, sampledAt: null});
  const flood = {sessions: Array.from({length: MAX_SESSIONS + 1}, () => ({sessionId: newSessionId(),
    nodes: Array.from({length: 10}, (_, j) => ({id: nodeId('host', j)}))}))};
  const bounded = sanitizeRunnerStatus(flood);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.sessions.length <= MAX_SESSIONS && bounded.sessions.reduce((total, item) => total + item.nodes.length, 0) <= MAX_NODES);
});

test('the runner answers runner.status without a session, and its module reads no command line, environment or other process', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', '..', 'runner', 'service.js'), 'utf8');
  assert.match(service, /command === 'runner\.status'\) return runnerStatus\.status\(/);
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'runner', 'runner-status.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const word of ['cmdline', 'environ', 'readdir', 'execFile', 'spawn', 'Atomics', 'process.env']) assert.ok(!source.includes(word), word);
});

// The pure parts of public/admin-runner-status.js, read from a vm context (the file has no import; `export` dropped).
function loadPanel() {
  const vm = require('node:vm');
  const {publicDir} = require('./web-ui-source');
  const source = fs.readFileSync(path.join(publicDir, 'admin-runner-status.js'), 'utf8').replace(/^export /gm, '');
  const names = ['duration', 'megabytes', 'percent', 'runnerOptions', 'chooseRunner', 'emptyState', 'memoryText', 'machineText', 'runnerText', 'sessionText', 'totalsText', 'nodeCells'];
  const context = vm.runInNewContext(`${source}\n({${names.join(', ')}})`);
  return Object.fromEntries(names.map(name => [name, (...args) => JSON.parse(JSON.stringify(context[name](...args)) ?? 'null')]));
}

test('the Runner status section: select, empty states and the text of each line', () => {
  const ui = loadPanel();
  const runners = [{id: 'local', name: 'local', state: 'offline'}, {id: 'r-0a1b2c3d', name: 'far', state: 'online'}, {id: 'r-1a1b2c3d', name: 'new', state: 'starting'}];
  assert.deepEqual(ui.runnerOptions(runners), [{value: 'local', disabled: true, label: 'local (local) · offline'},
    {value: 'r-0a1b2c3d', disabled: false, label: 'far (r-0a1b2c3d)'}, {value: 'r-1a1b2c3d', disabled: true, label: 'new (r-1a1b2c3d) · starting'}]);
  assert.equal(ui.chooseRunner(runners, ''), 'r-0a1b2c3d', 'the first online runner');
  assert.equal(ui.chooseRunner(runners, 'local'), 'local', 'the selection is kept while the runner is listed');
  assert.equal(ui.chooseRunner(runners, 'r-gone'), 'r-0a1b2c3d');
  assert.equal(ui.chooseRunner([], 'local'), '');
  assert.equal(ui.emptyState(undefined, null), 'No runner');
  assert.equal(ui.emptyState(runners[0], null), 'Runner offline');
  assert.equal(ui.emptyState(runners[2], null), 'Runner offline', 'not ready counts as offline');
  assert.equal(ui.emptyState(runners[1], {sessions: []}), 'No session');
  assert.equal(ui.emptyState(runners[1], {sessions: [{}]}), null);
  assert.deepEqual([ui.duration(3725), ui.duration(2 * 86400 + 5), ui.duration(null)], ['01:02:05', '2d 00:00:05', '—']);
  assert.deepEqual([ui.percent(3.14159), ui.percent(42.6), ui.percent(null)], ['3.1% CPU', '43% CPU', '— CPU']);
  assert.equal(ui.runnerText({pid: 4242, uptimeSeconds: 61, rssBytes: 80 * 2 ** 20, cpuPercent: 0.4}), 'pid 4242 · up 00:01:01 · 80 MB · 0.4% CPU');
  const totals = {hosts: 3, runningHosts: 2, switches: 1, runningSwitches: 1, rssBytes: 300 * 2 ** 20, memoryMb: 768, cpuPercent: 12};
  const id = newSessionId();
  assert.equal(ui.sessionText({sessionId: id, owner: 'alice', ageSeconds: 60, totals}), `Session ${id} · alice · up 00:01:00 · 2 / 3 hosts, 1 / 1 switch · 300 MB / 768 MB · 12% CPU`);
  assert.equal(ui.totalsText({...totals, switches: 2, memoryMb: 0, cpuPercent: null}), 'Total · 2 / 3 hosts, 1 / 2 switches · 300 MB · — CPU');
  const host = {id: nodeId('host', 9), name: 'pc1', kind: 'host', system: 'debian', engine: 'qemu', running: true, pid: 20, rssBytes: 100 * 2 ** 20, memoryMb: 512, cpuPercent: 5.25};
  assert.deepEqual(ui.nodeCells(host), ['pc1', 'host', 'debian', 'QEMU', '20', '100 MB / 512 MB', '5.3%']);
  assert.deepEqual(ui.nodeCells({...host, engine: 'vbox', pid: null}), ['pc1', 'host', 'debian', 'VirtualBox', '—', '100 MB / 512 MB', '5.3%']);
  assert.deepEqual(ui.nodeCells({...host, running: false, pid: null, rssBytes: null, cpuPercent: null}), ['pc1', 'host', 'debian', 'QEMU', 'stopped', '— / 512 MB', '—']);
  assert.deepEqual(ui.nodeCells({id: nodeId('switch', 9), name: null, kind: 'switch', system: null, engine: 'vde', running: true, pid: 30, rssBytes: 2 ** 20, memoryMb: null, cpuPercent: 0}),
    [nodeId('switch', 9), 'switch', '—', 'VDE', '30', '1 MB', '0.0%']);
});

test('the Runner status section is below the runners table, refreshed by the Runners panel only, one runner at a time', () => {
  const {publicDir} = require('./web-ui-source');
  const html = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');
  const panel = html.match(/<section id="panel-runners"[\s\S]*?<\/section>/)[0];
  assert.ok(panel.indexOf('id="runners-body"') < panel.indexOf('id="runner-status-title">Runner status<'), 'below the runners table');
  for (const id of ['runner-status-select', 'runner-status-process', 'runner-status-empty', 'runner-status-body', 'runner-status-totals']) assert.match(panel, new RegExp(`id="${id}"`), id);
  const status = fs.readFileSync(path.join(publicDir, 'admin-runner-status.js'), 'utf8');
  assert.doesNotMatch(status, /setInterval|setTimeout|innerHTML/, 'no timer of its own; runner text through textContent');
  assert.match(status, /api\(`\/runners\/\$\{encodeURIComponent\(runner\.id\)\}\/status`\)/);
  assert.match(fs.readFileSync(path.join(publicDir, 'admin-runners.js'), 'utf8'), /await updateStatus\(data\.runners\);/);
  assert.match(fs.readFileSync(path.join(publicDir, 'admin.js'), 'utf8'), /createRunnersPanel\(\{api, cell, confirm: confirmDialog, updateStatus: updateRunnerStatus,/);
});
