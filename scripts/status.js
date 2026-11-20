'use strict';

// Process tree of QemuWeb servers: each server, each runner (a process of its own, started by
// scripts/start.sh, scripts/runner.sh or a unit; "waiting for a server" when none runs on its port) and
// the QEMU, vde_switch and vdeterm processes below it and its VirtualBox VMs (VBoxHeadless, found by
// the VM name, see scripts/status-vbox.js), grouped by session and labelled with the
// account, the node name and its system. Read-only: it only looks at /proc, ps, runtime/ and, for VirtualBox, `VBoxManage showvminfo`.
//   scripts/status.sh                  servers recorded in this project's runtime/server-<port>.pid, else those started elsewhere
//   scripts/status.sh --all            every QemuWeb server of the current user, in any directory
//   scripts/status.sh --pid PID        one server by PID (also --server-pid)
//   scripts/status.sh --watch|-w [SECS]   refresh every SECS seconds (default 2) until Ctrl+C
//   scripts/status.sh --details        also list the processes of each switch (vde_switch, vdeterm); d toggles it with --watch
//   scripts/status.sh --no-color       plain text (also when NO_COLOR is set or stdout is not a terminal)
// It looks only at the default runtime/ of this project (a server started with another --runtime is found by --all).
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const {parseVBoxHeadless, vboxProcessesOf, runnerSessionsDir, hostMemoryMb, hostTag, readVirtualBoxMemory} = require('./status-vbox');

const ROOT = path.resolve(__dirname, '..');
const SESSION_PATH = /(\/[^\s,]*?\/sessions)\/([0-9a-f]{16})(?:\/([hs]-[0-9a-f]{16}))?/;

function parseArguments(argv) {
  const options = {all: false, details: false, pid: null, watch: 0, color: process.stdout.isTTY && !process.env.NO_COLOR};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') options.all = true;
    else if (arg === '--no-color') options.color = false;
    else if (arg === '--details' || arg === '-d') options.details = true;
    else if ((arg === '--pid' || arg === '--server-pid') && /^\d+$/.test(argv[i + 1] || '')) options.pid = Number(argv[++i]);
    else if (arg === '--watch' || arg === '-w') options.watch = /^\d+(\.\d+)?$/.test(argv[i + 1] || '') ? Number(argv[++i]) : 2;
    else if (arg === '-h' || arg === '--help') {
      const lines = fs.readFileSync(__filename, 'utf8').split("\n").slice(2, 14);
      console.log(lines.map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(0);
    } else { console.error(`Usage: scripts/status.sh [--all | --pid PID] [--details] [--watch|-w [SECONDS]] [--no-color]`); process.exit(2); }
  }
  return options;
}

// Every process of the machine, from a single ps call.
function processTable() {
  const output = execFileSync('ps', ['-eo', 'pid=,ppid=,pgid=,uid=,etimes=,rss=,pcpu=,args='], {encoding: 'utf8', maxBuffer: 64 << 20});
  const table = new Map();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, pgid, uid, seconds, rss, cpu, args] = match;
    table.set(Number(pid), {pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), uid: Number(uid), seconds: Number(seconds),
      rssKb: Number(rss), cpu: Number(cpu), args, children: [], vbox: parseVBoxHeadless(args)});
  }
  for (const entry of table.values()) table.get(entry.ppid)?.children.push(entry);
  return table;
}

const readLink = target => { try { return fs.readlinkSync(target); } catch (_) { return ''; } };
const isNode = entry => /(^|\/)node$/.test(entry.args.split(' ')[0]);
// The server and the runner are recognised the same way: `node server/main.js` and
// `node runner/main.js`, by an absolute path or a relative one (./scripts/runner.sh, start.sh).
const isServer = entry => isNode(entry) && /(^| )(\S*\/)?server\/main\.js( |$)/.test(entry.args);
const isRunner = entry => isNode(entry) && /(^| )(\S*\/)?runner\/main\.js( |$)/.test(entry.args);

// The project directory of a server or a runner: the parent of the folder of its absolute
// server/main.js or runner/main.js, or its working directory when the path is relative.
function projectRoot(entry) {
  const script = entry.args.split(' ').find(word => /(^|\/)(server|runner)\/main\.js$/.test(word));
  if (script && script.startsWith('/')) return path.dirname(path.dirname(script));
  return readLink(`/proc/${entry.pid}/cwd`);
}

// Servers to show, as {entry, root, port}.
function findServers(table, options) {
  const found = new Map();
  const add = (entry, root, port) => { if (entry && !found.has(entry.pid)) found.set(entry.pid, {entry, root, port}); };
  const recordedPort = (root, pid) => {
    try {
      for (const name of fs.readdirSync(path.join(root, 'runtime'))) {
        const match = /^server-(\d+)\.pid$/.exec(name);
        if (match && Number(fs.readFileSync(path.join(root, 'runtime', name), 'utf8')) === pid) return Number(match[1]);
      }
    } catch (_) { /* No record. */ }
    return null;
  };
  const scanAll = () => {
    for (const entry of table.values()) {
      if (entry.uid !== process.getuid() || !isServer(entry)) continue;
      const root = projectRoot(entry);
      if (root && fs.existsSync(path.join(root, 'server', 'session-manager.js'))) add(entry, root, recordedPort(root, entry.pid));
    }
  };
  if (options.pid) {
    const entry = table.get(options.pid);
    if (!entry || !isServer(entry)) { console.error(`PID ${options.pid} is not a QemuWeb server.`); process.exit(1); }
    const root = projectRoot(entry);
    add(entry, root, recordedPort(root, entry.pid));
  } else if (options.all) {
    scanAll();
  } else {
    let names = [];
    try { names = fs.readdirSync(path.join(ROOT, 'runtime')); } catch (_) { /* No runtime directory. */ }
    for (const name of names) {
      const match = /^server-(\d+)\.pid$/.exec(name);
      if (!match) continue;
      const pid = Number(fs.readFileSync(path.join(ROOT, 'runtime', name), 'utf8'));
      const entry = table.get(pid);
      if (entry && isServer(entry) && readLink(`/proc/${pid}/cwd`) === ROOT) add(entry, ROOT, Number(match[1]));
    }
    // Nothing recorded for this project: show the servers started from other directories.
    if (!found.size) { scanAll(); options.fellBack = found.size > 0; }
  }
  return [...found.values()].sort((a, b) => a.entry.pid - b.entry.pid);
}

const descendants = entry => entry.children.flatMap(child => [child, ...descendants(child)]);
// The machine processes below a runner: QEMU, VirtualBox, vde_switch and vdeterm. Its other
// children (the sed that start.sh puts on its output, zombies) are not machines.
const isMachineProcess = entry => !/<defunct>/.test(entry.args) && /^(qemu-system|VBoxHeadless$|vde_switch$|vdeterm$)/.test(path.basename(entry.args.split(' ')[0]));
// A VirtualBox VM is detached from the runner (it belongs to the VirtualBox daemon): it is found
// by its name, which carries the runner's pid (scripts/status-vbox.js), not by the process tree.
const showVmInfo = uuid => execFileSync('VBoxManage', ['showvminfo', uuid, '--machinereadable'], {encoding: 'utf8', timeout: 3000});
function machineProcesses(table, runner) {
  const vms = vboxProcessesOf(table.values(), runner.pid);
  for (const vm of vms) {
    vm.vbox.sessionsDir = runnerSessionsDir(runner.args, projectRoot(runner));
    vm.vbox.memoryMb = readVirtualBoxMemory(vm.vbox.uuid, showVmInfo);
  }
  return [...new Set([...descendants(runner).filter(isMachineProcess), ...vms.filter(vm => !/<defunct>/.test(vm.args))])];
}

// Colours and cell formatting.
function styles(enabled) {
  const wrap = code => text => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {bold: wrap('1'), dim: wrap('2'), server: wrap('1;36'), runner: wrap('1;32'), user: wrap('1;33'), userText: wrap('33'),
    vm: wrap('0'), net: wrap('35'), warn: wrap('31')};
}
const duration = seconds => {
  const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  const clock = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return d ? `${d}d ${clock}` : clock;
};
const megabytes = kb => `${Math.round(kb / 1024)} MB`;
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// CPU use in percent of one core, measured between two samples of /proc/<pid>/stat. A one-shot
// run takes two samples one second apart; --watch compares each frame with the previous one.
let clockTicks = 100;
try { clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], {encoding: 'utf8'})) || 100; } catch (_) { /* Linux default. */ }
let previousSample = null;

function sampleTicks(pids) {
  const ticks = new Map();
  for (const pid of pids) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      ticks.set(pid, Number(fields[11]) + Number(fields[12])); // utime + stime
    } catch (_) { /* The process is gone. */ }
  }
  return {time: Date.now(), ticks};
}

function measureCpu(table, servers) {
  const pids = new Set();
  for (const {entry} of servers) pids.add(entry.pid);
  for (const entry of table.values()) {
    if (entry.uid === process.getuid() && isRunner(entry)) {
      for (const item of [entry, ...descendants(entry), ...vboxProcessesOf(table.values(), entry.pid)]) pids.add(item.pid);
    }
  }
  let now = sampleTicks(pids);
  if (!previousSample) {
    previousSample = now;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    now = sampleTicks(pids);
  }
  const seconds = (now.time - previousSample.time) / 1000;
  for (const pid of pids) {
    const before = previousSample.ticks.get(pid), after = now.ticks.get(pid);
    if (seconds > 0 && before !== undefined && after !== undefined) table.get(pid).cpu = (after - before) / clockTicks / seconds * 100;
    else delete table.get(pid).cpu;
  }
  previousSample = now;
}

const percent = cpu => (cpu === undefined ? null : `${cpu < 10 ? cpu.toFixed(1) : Math.round(cpu)}% CPU`);

// "N hosts, M switches" for a list of processes.
const machineCount = items => `${plural(items.filter(item => item.vbox || /qemu-system/.test(item.args)).length, 'host')}, ` +
  plural(items.filter(item => /(^|\/)vde_switch /.test(item.args)).length, 'switch', 'switches');

// Memory in use over memory given to the machines (QEMU and VirtualBox) of a list of processes.
function memoryTotals(items) {
  const given = items.reduce((sum, item) => sum + (hostMemoryMb(item) || 0), 0);
  return `${megabytes(items.reduce((sum, item) => sum + item.rssKb, 0))} / ${given} MB`;
}

// Seconds since the session was created, from its meta.json.
function sessionAge(sessionsDir, sessionId) {
  try {
    const created = Date.parse(JSON.parse(fs.readFileSync(path.join(sessionsDir, sessionId, 'meta.json'), 'utf8')).createdAt);
    return Number.isFinite(created) ? Math.max(0, Math.round((Date.now() - created) / 1000)) : null;
  } catch (_) { return null; }
}

// Name and system of a node from its host.json or switch.json, when readable.
function nodeInfo(sessionsDir, sessionId, nodeId) {
  if (!sessionsDir || !nodeId) return {};
  const file = path.join(sessionsDir, sessionId, nodeId, nodeId.startsWith('h-') ? 'host.json' : 'switch.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {name: data.name || data.hostname, system: data.system};
  } catch (_) { return {}; }
}

// Login of the owner of each session, from runtime/users/<login> -> ../sessions/<id>.
function owners(sessionsDir) {
  const map = new Map();
  if (!sessionsDir) return map;
  const users = path.join(path.dirname(sessionsDir), 'users');
  try {
    for (const login of fs.readdirSync(users)) {
      const id = path.basename(readLink(path.join(users, login)));
      if (/^[0-9a-f]{16}$/.test(id)) map.set(id, login);
    }
  } catch (_) { /* No users directory. */ }
  return map;
}

// Where a process belongs: {sessionId, nodeId, sessionsDir}, found in its arguments or working directory.
function locate(entry) {
  if (entry.vbox) return {sessionsDir: entry.vbox.sessionsDir, sessionId: entry.vbox.sessionId, nodeId: entry.vbox.nodeId};
  const match = SESSION_PATH.exec(entry.args) || SESSION_PATH.exec(readLink(`/proc/${entry.pid}/cwd`));
  return match ? {sessionsDir: match[1], sessionId: match[2], nodeId: match[3] || null} : null;
}

// One process, as a line of the details view or of an orphan runner.
function processText(entry, style) {
  const base = path.basename(entry.args.split(' ')[0]);
  const kind = base.startsWith('qemu-system') ? 'qemu' : base;
  return `${style.net(kind.padEnd(12))} ${style.dim(`pid ${entry.pid} · ${megabytes(entry.rssKb)}`)}`;
}

// The processes of one node (a switch or a host), as a line plus, with --details, its processes.
// A host is a single QEMU process (its threads are not processes), a switch is a vde_switch
// with its vdeterm management terminal.
function nodeItem(processes, style, details) {
  const where = locate(processes[0]);
  const info = where ? nodeInfo(where.sessionsDir, where.sessionId, where.nodeId) : {};
  const qemu = processes.find(item => item.vbox || /(^|\/)qemu-system/.test(item.args.split(' ')[0]));
  const vde = processes.find(item => /(^|\/)vde_switch$/.test(item.args.split(' ')[0]));
  const label = info.name ? `${style.bold(info.name)}${info.system ? style.dim(` · ${info.system}`) : ''}` : style.dim(where?.nodeId || '?');
  if (qemu) {
    const memory = hostMemoryMb(qemu);
    const used = megabytes(qemu.rssKb);
    const rest = [`pid ${qemu.pid}`, memory ? `${used} / ${memory} MB` : used, percent(qemu.cpu)].filter(Boolean).join(' · ');
    const others = processes.filter(item => item !== qemu);
    return {rank: 1, name: info.name || '', text: `${style.vm(hostTag(qemu).padEnd(12))} ${label} · ${style.dim(rest)}`,
      children: others.map(item => ({text: processText(item, style)}))};
  }
  const main = vde || processes[0];
  const total = megabytes(processes.reduce((sum, item) => sum + item.rssKb, 0));
  const text = `${style.net('switch (vde)'.padEnd(12))} ${label} · ${style.dim(`pid ${main.pid} · ${total}`)}`;
  return {rank: 0, name: info.name || '', text, children: details ? processes.map(item => ({text: processText(item, style)})) : []};
}

// Lines of a tree: items are {text, children}.
function render(items, prefix = '') {
  const lines = [];
  items.forEach((item, index) => {
    const last = index === items.length - 1;
    lines.push(`${prefix}${last ? '└─ ' : '├─ '}${item.text}`);
    lines.push(...render(item.children || [], `${prefix}${last ? '   ' : '│  '}`));
  });
  return lines;
}

// "Session 88686978 (toto) · 4 hosts, 1 switch · 1456 MB / 4096 MB · 12% CPU · up 00:36:27".
function sessionLine(id, login, items, sessionsDir, style) {
  const age = sessionAge(sessionsDir, id);
  const cpu = items.some(item => item.cpu !== undefined) ? items.reduce((sum, item) => sum + (item.cpu || 0), 0) : undefined;
  const parts = [machineCount(items), memoryTotals(items), percent(cpu), age === null ? null : `up ${duration(age)}`].filter(Boolean);
  return `${style.user(`Session ${id.slice(0, 8)} (${login || '?'})`)}${style.userText(` · ${parts.join(' · ')}`)}`;
}

// The sessions of a set of machine processes, as tree items: grouped by session, then by node
// (a switch or a host), switches first.
function sessionItems(machines, defaultSessionsDir, style, details) {
  const sessionsDir = machines.map(item => locate(item)?.sessionsDir).find(Boolean) || defaultSessionsDir;
  const logins = owners(sessionsDir);
  const bySession = new Map();
  for (const item of machines) {
    const where = locate(item);
    const session = where?.sessionId || '';
    if (!bySession.has(session)) bySession.set(session, new Map());
    const node = where?.nodeId || `pid-${item.pid}`;
    const nodes = bySession.get(session);
    if (!nodes.has(node)) nodes.set(node, []);
    nodes.get(node).push(item);
  }
  return [...bySession.entries()].map(([id, nodes]) => ({
    text: id ? sessionLine(id, logins.get(id), [...nodes.values()].flat(), sessionsDir, style) : style.dim('other processes'),
    children: [...nodes.values()].map(list => nodeItem(list, style, details))
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
  }));
}

function runnerLine(runner, machines, style, label = 'Runner') {
  const parts = [`pgid ${runner.pgid}`, `up ${duration(runner.seconds)}`, megabytes(runner.rssKb), percent(runner.cpu), machineCount(machines)].filter(Boolean);
  return `${style.runner(label)} ${style.bold(`pid ${runner.pid}`)} · ${parts.join(' · ')}`;
}

function serverReport({entry, root, port}, style) {
  const serverParts = [port ? `port ${port}` : null, `up ${duration(entry.seconds)}`, percent(entry.cpu)].filter(Boolean);
  const lines = [`${style.server('Server')} ${style.bold(`pid ${entry.pid}`)} · ${serverParts.join(' · ')} · ${style.dim(root)}`];
  return lines;
}

// The server port a runner dials: --port PORT, or runner-N.sock in --connect.
function runnerPort(entry) {
  const match = / --port (\d+)( |$)/.exec(entry.args) || /runner-(\d+)\.sock/.exec(entry.args);
  return match ? Number(match[1]) : null;
}

// The project directory of the server a runner dials: the one holding the --connect socket
// (runtime/runner-<port>.sock), else the runner's own project (--port).
function runnerServerRoot(entry) {
  const socket = /(\S*runner-\d+\.sock)/.exec(entry.args)?.[1];
  return socket ? path.dirname(path.dirname(socket)) : projectRoot(entry);
}

// A runner is a process of its own, never a child of the server. It keeps its sessions while the
// server is away, so it is not an orphan: it waits for a server.
function standaloneRunnerReport(table, entry, servers, style, details) {
  const port = runnerPort(entry);
  const dialled = runnerServerRoot(entry);
  const connected = port !== null && servers.some(server => server.port === port && server.root === dialled);
  const machines = machineProcesses(table, entry);
  const label = connected ? 'Runner' : 'Runner (waiting for a server)';
  return [`${runnerLine(entry, machines, style, label)}${port ? style.dim(` · port ${port}`) : ''}`,
    ...render(sessionItems(machines, path.join(ROOT, 'runtime', 'sessions'), style, details))];
}

function report(options) {
  const table = processTable();
  const style = styles(options.color);
  const servers = findServers(table, options);
  measureCpu(table, servers);
  const lines = [`${style.bold('QemuWeb processes')} of ${process.env.USER || process.getuid()} at ${new Date().toTimeString().slice(0, 8)}`];
  if (options.fellBack) lines.push('', style.dim(`No server is recorded in ${path.join(ROOT, 'runtime')}: showing the QemuWeb servers of this user started elsewhere.`));
  const runners = [...table.values()].filter(entry => entry.uid === process.getuid() && isRunner(entry));
  for (const server of servers) {
    lines.push('', ...serverReport(server, style));
    if (server.port && !runners.some(entry => runnerPort(entry) === server.port && runnerServerRoot(entry) === server.root)) {
      lines.push(style.dim('   no runner connected: start one with ./scripts/runner.sh'));
    }
  }
  for (const entry of runners) {
    // Without --all, only the runners of this project and of the servers shown.
    const dialled = runnerServerRoot(entry);
    if (!options.all && dialled !== ROOT && !servers.some(server => server.root === dialled)) continue;
    lines.push('', ...standaloneRunnerReport(table, entry, servers, style, options.details));
  }
  if (!servers.length && !lines.some(line => line.includes('Runner ('))) {
    lines.push('', options.pid ? 'No such server.' : options.all
      ? 'No QemuWeb server is running.'
      : `No QemuWeb server is recorded in ${path.join(ROOT, 'runtime')}. Use --all to look for servers in other directories.`);
  }
  return lines.join('\n');
}

const options = parseArguments(process.argv.slice(2));
if (options.watch) {
  const draw = () => process.stdout.write(`\x1b[H\x1b[2J${report(options)}\n\n${styles(options.color).dim(`Refreshing every ${options.watch}s. d: ${options.details ? 'hide' : 'show'} details, q or Ctrl+C: quit.`)}\n`);
  draw();
  setInterval(draw, options.watch * 1000);
  process.on('SIGINT', () => process.exit(0));
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', key => {
      const text = key.toString();
      if (text === 'q' || text === '\u0003') process.exit(0);
      if (text === 'd') { options.details = !options.details; draw(); }
    });
  }
} else console.log(report(options));
