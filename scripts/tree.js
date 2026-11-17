'use strict';

// Process tree of QemuWeb servers: each server, its local runner (when the version has one) and
// the QEMU, vde_switch and vdeterm processes below it, grouped by session and labelled with the
// account, the node name and its system. Read-only: it only looks at /proc, ps and runtime/.
//   scripts/tree.sh                  servers recorded in this project's runtime/server-<port>.pid
//   scripts/tree.sh --all            every QemuWeb server of the current user, in any directory
//   scripts/tree.sh --pid PID        one server by PID (also --server-pid)
//   scripts/tree.sh --watch [SECS]   refresh every SECS seconds (default 2) until Ctrl+C
//   scripts/tree.sh --no-color       plain text (also when NO_COLOR is set or stdout is not a terminal)
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SESSION_PATH = /(\/[^\s,]*?\/sessions)\/([0-9a-f]{16})(?:\/([hs]-[0-9a-f]{16}))?/;

function parseArguments(argv) {
  const options = {all: false, pid: null, watch: 0, color: process.stdout.isTTY && !process.env.NO_COLOR};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') options.all = true;
    else if (arg === '--no-color') options.color = false;
    else if ((arg === '--pid' || arg === '--server-pid') && /^\d+$/.test(argv[i + 1] || '')) options.pid = Number(argv[++i]);
    else if (arg === '--watch') options.watch = /^\d+(\.\d+)?$/.test(argv[i + 1] || '') ? Number(argv[++i]) : 2;
    else if (arg === '-h' || arg === '--help') {
      const lines = fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 10);
      console.log(lines.map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(0);
    } else { console.error(`Usage: scripts/tree.sh [--all | --pid PID] [--watch [SECONDS]] [--no-color]`); process.exit(2); }
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
      rssKb: Number(rss), cpu: Number(cpu), args, children: []});
  }
  for (const entry of table.values()) table.get(entry.ppid)?.children.push(entry);
  return table;
}

const readLink = target => { try { return fs.readlinkSync(target); } catch (_) { return ''; } };
const isNode = entry => /(^|\/)node$/.test(entry.args.split(' ')[0]);
const isServer = entry => isNode(entry) && /(^| )(\S*\/)?server\.js( |$)/.test(entry.args);
const isRunner = entry => isNode(entry) && / \S*\/runner\/main\.js( |$)/.test(entry.args);

// The root directory of a server: its working directory, or the folder of an absolute server.js.
function serverRoot(entry) {
  const script = entry.args.split(' ').find(word => /(^|\/)server\.js$/.test(word));
  if (script && script.startsWith('/')) return path.dirname(script);
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
  if (options.pid) {
    const entry = table.get(options.pid);
    if (!entry || !isServer(entry)) { console.error(`PID ${options.pid} is not a QemuWeb server.`); process.exit(1); }
    const root = serverRoot(entry);
    add(entry, root, recordedPort(root, entry.pid));
  } else if (options.all) {
    for (const entry of table.values()) {
      if (entry.uid !== process.getuid() || !isServer(entry)) continue;
      const root = serverRoot(entry);
      if (root && fs.existsSync(path.join(root, 'lib', 'session-manager.js'))) add(entry, root, recordedPort(root, entry.pid));
    }
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
  }
  return [...found.values()].sort((a, b) => a.entry.pid - b.entry.pid);
}

const descendants = entry => entry.children.flatMap(child => [child, ...descendants(child)]);

// Colours and cell formatting.
function styles(enabled) {
  const wrap = code => text => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {bold: wrap('1'), dim: wrap('2'), server: wrap('1;36'), runner: wrap('1;32'), user: wrap('1;33'),
    vm: wrap('0'), net: wrap('35'), warn: wrap('31')};
}
const duration = seconds => {
  const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  const clock = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return d ? `${d}d ${clock}` : clock;
};
const megabytes = kb => `${Math.round(kb / 1024)} MB`;

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
  const match = SESSION_PATH.exec(entry.args) || SESSION_PATH.exec(readLink(`/proc/${entry.pid}/cwd`));
  return match ? {sessionsDir: match[1], sessionId: match[2], nodeId: match[3] || null} : null;
}

function describe(entry, style) {
  const base = path.basename(entry.args.split(' ')[0]);
  const memory = /(?:^| )-m (\d+)(?: |$)/.exec(entry.args);
  const where = locate(entry);
  const info = where ? nodeInfo(where.sessionsDir, where.sessionId, where.nodeId) : {};
  const kind = base.startsWith('qemu-system') ? 'qemu' : base;
  const label = info.name ? `${style.bold(info.name)}${info.system ? style.dim(` · ${info.system}`) : ''}` : style.dim(where?.nodeId || '');
  // A QEMU process shows the memory in use over the memory given to its machine (-m).
  const detail = kind === 'qemu' && memory ? `${megabytes(entry.rssKb)} / ${memory[1]} MB` : megabytes(entry.rssKb);
  const paint = kind === 'qemu' ? style.vm : style.net;
  return {where, text: `${paint(kind.padEnd(10))} ${label}  ${style.dim(`pid ${entry.pid}`)}  ${style.dim(detail)}`};
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

function serverReport({entry, root, port}, table, style) {
  const lines = [`${style.server('Server')} ${style.bold(`pid ${entry.pid}`)}${port ? ` · port ${port}` : ''} · up ${duration(entry.seconds)} · ${style.dim(root)}`];
  const below = descendants(entry);
  const runner = below.find(isRunner);
  const machines = (runner ? descendants(runner) : below).filter(item => !isRunner(item));
  const sessionsDir = machines.map(item => locate(item)?.sessionsDir).find(Boolean) || path.join(root, 'runtime', 'sessions');
  const logins = owners(sessionsDir);
  // Group the machines by session, in a stable order.
  const bySession = new Map();
  for (const item of machines) {
    const {where, text} = describe(item, style);
    const key = where?.sessionId || '';
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push({text, item, rank: /qemu-system/.test(item.args) ? 1 : 0});
  }
  const sessions = [...bySession.entries()].map(([id, list]) => ({
    text: id ? `${style.user(logins.get(id) || '?')} ${style.dim(`session ${id.slice(0, 8)}`)}` : style.dim('other processes'),
    children: list.sort((a, b) => a.rank - b.rank || a.item.pid - b.item.pid).map(({text}) => ({text}))
  }));
  if (runner) {
    const runnerText = `${style.runner('Runner')} ${style.bold(`pid ${runner.pid}`)} · pgid ${runner.pgid} · up ${duration(runner.seconds)} · ${megabytes(runner.rssKb)}` +
      ` · ${machines.filter(item => /qemu-system/.test(item.args)).length} QEMU, ${machines.filter(item => /vde_switch/.test(item.args)).length} switches`;
    lines.push(...render([{text: runnerText, children: sessions}]));
  } else {
    lines.push(...render(sessions));
    if (!sessions.length) lines.push(style.dim('   (no machine running)'));
  }
  return lines;
}

function report(options) {
  const table = processTable();
  const style = styles(options.color);
  const servers = findServers(table, options);
  const lines = [`${style.bold('QemuWeb processes')} of ${process.env.USER || process.getuid()} at ${new Date().toTimeString().slice(0, 8)}`];
  for (const server of servers) lines.push('', ...serverReport(server, table, style));
  // A runner whose server is gone keeps nothing running by itself, but its machines may.
  const known = new Set(servers.map(server => server.entry.pid));
  for (const entry of table.values()) {
    if (entry.uid === process.getuid() && isRunner(entry) && !known.has(entry.ppid)) {
      const parent = table.get(entry.ppid);
      if (parent && isServer(parent)) continue;
      lines.push('', `${style.warn('Orphan runner')} pid ${entry.pid} (no server above it): ${descendants(entry).length} processes below`,
        ...render(descendants(entry).map(item => ({text: describe(item, style).text}))));
    }
  }
  if (!servers.length) {
    lines.push('', options.pid ? 'No such server.' : options.all
      ? 'No QemuWeb server is running.'
      : `No QemuWeb server is recorded in ${path.join(ROOT, 'runtime')}. Use --all to look for servers in other directories.`);
  }
  return lines.join('\n');
}

const options = parseArguments(process.argv.slice(2));
if (options.watch) {
  const draw = () => process.stdout.write(`\x1b[H\x1b[2J${report(options)}\n\n${styles(options.color).dim(`Refreshing every ${options.watch}s, Ctrl+C to quit.`)}\n`);
  draw();
  setInterval(draw, options.watch * 1000);
  process.on('SIGINT', () => process.exit(0));
} else console.log(report(options));
