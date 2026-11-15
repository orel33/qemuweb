'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const {StringDecoder} = require('string_decoder');
const path = require('path');
const crypto = require('crypto');
const {spawn, execFileSync, execFile} = require('child_process');
const {promisify} = require('util');
const express = require('express');
const {Server: SocketIoServer} = require('socket.io');
const pty = require('node-pty');
const {resolveCommands} = require('./runner/preflight');
const {parseHostCpu, parseProcessCpu, parseProcessRss, processCpuPercent, parseVBoxMetrics} = require('./runner/metrics');
const {parseTopology, formatTopology} = require('./lib/topology');
const {writeArchive, readArchive} = require('./lib/session-archive');
const {readCatalog, selectedProfile, profileHash, sparseOverrides, validateOverrides} = require('./common/system-config');
const {LABEL: GUEST_ISO_LABEL, validateBootFiles, validateStartupTemplate, normalizeScript, readStartupFiles, writeStartupScript, writeStartupFiles, createGuestIso} = require('./guest-media');
const packageInfo = require('./package.json');

const root = __dirname;
let commands;
console.log(`QemuWeb ${packageInfo.version}\n`);
try { commands = resolveCommands(root); }
catch (error) { console.error(error.message); process.exit(1); }
const availableEngines = commands.VBOXMANAGE ? ['qemu', 'vbox'] : ['qemu'];
const runtime = path.join(root, 'runtime');
const sessionsRoot = path.join(runtime, 'sessions');
const currentSessionLink = path.join(runtime, 'current');
const ephemeralServer = process.env.QEMUWEB_TEST_SERVER === '1';
const configPath = path.join(root, 'config.json');
const qemuProfileFields = ['machine', 'cpuKvm', 'display', 'diskInterface', 'networkModel', 'bootDisk', 'nic'];
const qemuFields = [...qemuProfileFields, 'extraOptions', 'memory', 'smp', 'rtcBase'];
const launchSettingFields = {
  memory: {label: 'Memory', type: 'number', unit: 'MB', min: 64, max: 32768, step: 64},
  cpus: {label: 'Processors', type: 'number', min: 1, max: 64, step: 1},
  clock: {label: 'Hardware clock', type: 'select', options: ['utc', 'localtime']}
};
const port = Number(process.env.PORT || 3002);
const serverPidFile = path.join(runtime, `server-${port}.pid`);
const serverSessionFile = path.join(runtime, `server-${port}.session`);
const app = express();
const server = http.createServer(app);
const io = new SocketIoServer(server);
const execFileAsync = promisify(execFile);
let samplingResources = false;

// All state belonging to one workspace: its engine, its nodes (hosts and switches),
// and its runtime directory. The server owns a single instance for now.
class Session {
  constructor({sessionsDir, id = crypto.randomBytes(8).toString('hex'), engine = 'qemu'}) {
    this.id = id;
    this.runtimeDir = path.join(sessionsDir, id);
    this.engine = engine;
    this.nodes = new Map();
    this.archiveBusy = false;
    this.resourceSamples = new Map();
    this.previousProcessSamples = new Map();
    this.vboxMetricSetup = new Map();
  }

  get metadataFile() { return path.join(this.runtimeDir, 'session.json'); }
}

const session = new Session({sessionsDir: sessionsRoot});
fs.mkdirSync(sessionsRoot, {recursive: true});
readCatalog(configPath);
try { fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK); }
catch (_) { console.warn('QEMU/KVM unavailable: /dev/kvm is missing or inaccessible.'); }

function pointCurrentSession(id) {
  const temporary = path.join(runtime, `.current-${session.id}`);
  try {
    fs.symlinkSync(path.join('sessions', id), temporary, 'dir');
    fs.renameSync(temporary, currentSessionLink);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    console.warn(`Cannot update runtime/current: ${error.message}`);
  }
}

function linkCurrentSession() {
  if (!ephemeralServer) pointCurrentSession(session.id);
}

function liveServerSessions() {
  const live = new Map();
  for (const name of fs.readdirSync(runtime)) {
    const match = /^server-(\d+)\.session$/.exec(name);
    if (!match) continue;
    try {
      const [id, kind] = fs.readFileSync(path.join(runtime, name), 'utf8').trimEnd().split('\n');
      if (!/^[0-9a-f]{16}$/.test(id) || !['regular', 'test'].includes(kind)) continue;
      const pid = Number(fs.readFileSync(path.join(runtime, `server-${match[1]}.pid`), 'utf8').trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      process.kill(pid, 0);
      live.set(id, {pid, ephemeral: kind === 'test'});
    } catch (_) { /* Ignore stale or incomplete server records. */ }
  }
  return live;
}

function removeCurrentSessionLink() {
  if (ephemeralServer) return;
  try {
    if (fs.readlinkSync(currentSessionLink) !== path.join('sessions', session.id)) return;
    const live = liveServerSessions();
    const fallback = fs.readdirSync(sessionsRoot).filter(name => /^[0-9a-f]{16}$/.test(name) && name !== session.id && live.has(name) && !live.get(name).ephemeral)
      .map(name => {
        try {
          return {name, started: fs.statSync(path.join(sessionsRoot, name)).birthtimeMs};
        } catch (_) { return null; }
      }).filter(Boolean).sort((a, b) => b.started - a.started)[0];
    if (fallback) pointCurrentSession(fallback.name);
    else fs.unlinkSync(currentSessionLink);
  } catch (error) { if (error.code !== 'ENOENT') console.warn(`Cannot remove runtime/current: ${error.message}`); }
}

function removeEmptyRuntimeSession() {
  if (session.nodes.size) return;
  try {
    for (const name of ['hosts', 'switches']) {
      try { fs.rmdirSync(path.join(session.runtimeDir, name)); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
    }
    if (fs.readdirSync(session.runtimeDir).some(name => name !== 'session.json')) return;
    const saved = JSON.parse(fs.readFileSync(session.metadataFile, 'utf8'));
    if (!Array.isArray(saved.hosts) || saved.hosts.length || !Array.isArray(saved.switches) || saved.switches.length) return;
    fs.unlinkSync(session.metadataFile);
    fs.rmdirSync(session.runtimeDir);
  } catch (_) { /* Keep incomplete sessions for inspection or later recovery. */ }
}

function pruneEmptyRuntimeSessions() {
  const liveSessions = liveServerSessions();
  let removed = 0;
  for (const name of fs.readdirSync(sessionsRoot)) {
    if (!/^[0-9a-f]{16}$/.test(name)) continue;
    const directory = path.join(sessionsRoot, name);
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs < 30000) continue;
      if (fs.readdirSync(directory).join() !== 'session.json') continue;
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'session.json'), 'utf8'));
      if (metadata.schemaVersion !== 4) continue;
      if (!Array.isArray(metadata.hosts) || metadata.hosts.length || !Array.isArray(metadata.switches) || metadata.switches.length) continue;
      if (liveSessions.has(name)) continue;
      fs.unlinkSync(path.join(directory, 'session.json'));
      fs.rmdirSync(directory);
      removed++;
    } catch (_) { /* Preserve unexpected runtime contents. */ }
  }
  if (removed) console.log(`Removed ${removed} empty runtime session${removed === 1 ? '' : 's'}.`);
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, {force: true}); } catch (_) {}
    throw error;
  }
}

function saveSessionMetadata(engine = session.engine) {
  writeJsonAtomic(session.metadataFile, sessionMetadata(engine));
}

function sessionMetadata(engine = session.engine) {
  const ids = kind => [...session.nodes.values()]
    .filter(node => node.kind === kind && node.hostname && (kind === 'switch' || node.selectedImage))
    .map(node => node.id).sort();
  return {schemaVersion: 4, engine, hosts: ids('host'), switches: ids('switch'), baseImages: {}};
}

function entityKind(id, expectedKind) {
  if (typeof id !== 'string' || !/^[hs]-[0-9a-f]{16}$/.test(id)) throw new Error('Invalid host or switch ID; expected h- or s- followed by 16 lowercase hex characters.');
  const kind = id[0] === 'h' ? 'host' : 'switch';
  if (expectedKind && kind !== expectedKind) throw new Error(`Expected a ${expectedKind === 'host' ? 'host' : 'switch'} ID.`);
  return kind;
}

function newEntityId(kind) {
  return `${kind === 'switch' ? 's' : 'h'}-${crypto.randomBytes(8).toString('hex')}`;
}

function requireSessionEngine(engine) {
  if (!availableEngines.includes(engine)) throw new Error(`${engine === 'vbox' ? 'VirtualBox' : 'QEMU'} is unavailable on this server.`);
  if (engine !== session.engine) throw new Error(`Engine ${engine} differs from this session's ${session.engine} engine. Change General Settings before adding hosts.`);
}

function resourceResult(cpuPercent, ramBytes) {
  const available = [cpuPercent, ramBytes].filter(Number.isFinite).length;
  return {status: available === 2 ? 'available' : available ? 'partial' : 'unavailable', cpuPercent, ramBytes};
}

async function vboxMetricCommand(args) {
  const {stdout} = await execFileAsync(commands.VBOXMANAGE, ['metrics', ...args], {encoding: 'utf8', timeout: 2500, maxBuffer: 131072});
  return stdout;
}

async function sampleResources() {
  if (samplingResources) return;
  samplingResources = true;
  try {
    const running = [...session.nodes.values()].filter(node => node.kind === 'host' && node.machine);
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
        const previous = session.previousProcessSamples.get(node.id);
        const cpuPercent = previous?.machine === machine ? processCpuPercent(previous, processCpu, hostCpu) : null;
        const ramBytes = parseProcessRss(status);
        if (processCpu && hostCpu) session.previousProcessSamples.set(node.id, {...processCpu, hostTicks: hostCpu.totalTicks, machine});
        result = resourceResult(cpuPercent, ramBytes);
      } else if (node.engine === 'vbox') {
        try {
          if (session.vboxMetricSetup.get(node.id) !== machine) {
            await vboxMetricCommand(['setup', '--period', '2', '--samples', '1', node.vmName, 'CPU/Load,RAM/Usage']);
            if (node.machine !== machine) return;
            session.vboxMetricSetup.set(node.id, machine);
          }
          const values = parseVBoxMetrics(await vboxMetricCommand([
            'query', node.vmName, 'CPU/Load/User,CPU/Load/Kernel,RAM/Usage/Used'
          ]));
          result = resourceResult(values.cpuPercent, values.ramBytes);
        } catch (_) { result = resourceResult(null, null); }
      }
      if (result && node.machine === machine) session.resourceSamples.set(node.id, {machine, result});
    }));
    const runningIds = new Set(running.map(node => node.id));
    for (const id of session.resourceSamples.keys()) if (!runningIds.has(id)) session.resourceSamples.delete(id);
    for (const id of session.previousProcessSamples.keys()) if (!runningIds.has(id)) session.previousProcessSamples.delete(id);
    for (const id of session.vboxMetricSetup.keys()) if (!runningIds.has(id)) session.vboxMetricSetup.delete(id);
  } finally { samplingResources = false; }
}

const resourceTimer = setInterval(() => sampleResources().catch(error => console.error('Resource sampling:', error)), 2000);
resourceTimer.unref();

function shellQuote(value) {
  const text = String(value);
  return /^[a-zA-Z0-9_./:=,+-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

function defaultStartupScript(interfaces) {
  return '#!/bin/sh\nhostname @HOSTNAME@\n' +
    (interfaces.length ? 'ifconfig @IFNAME0@ 192.168.0.@SWPORT0@/24\n' : '');
}

function sessionPaths(id, kind = 'host') {
  entityKind(id, kind);
  const runtimeDir = path.join(session.runtimeDir, id);
  const paths = {
    runtimeDir,
    vmName: `qemuweb-${process.pid}-${id}`,
    socketPath: path.join(runtimeDir, 'serial.sock'),
    monitorPath: path.join(runtimeDir, 'mon.sock'),
    socketDir: kind === 'switch' ? path.join(runtimeDir, 'vde') : null,
    mgmtPath: kind === 'switch' ? path.join(runtimeDir, 'mgmt.sock') : null
  };
  if ([paths.socketPath, paths.monitorPath, paths.mgmtPath].some(name => name && Buffer.byteLength(name) > 107)) {
    throw new Error('Runtime socket path is too long; move the project to a shorter directory.');
  }
  return paths;
}

function hostnameAliasPath(node, name) {
  const encoded = encodeURIComponent(name);
  const safeName = encoded === '.' || encoded === '..' ? encoded.replaceAll('.', '%2E') : encoded;
  const component = Buffer.byteLength(safeName) <= 120
    ? safeName : `${safeName.slice(0, 96)}-${path.basename(node.runtimeDir)}`;
  return path.join(session.runtimeDir, node.kind === 'switch' ? 'switches' : 'hosts', component);
}

function setNodeHostname(node, name) {
  const alias = hostnameAliasPath(node, name);
  if (alias !== node.hostnameAliasPath) {
    fs.mkdirSync(path.dirname(alias), {recursive: true});
    const target = path.relative(path.dirname(alias), node.runtimeDir);
    try { fs.symlinkSync(target, alias, 'dir'); }
    catch (error) {
      if (error.code !== 'EEXIST' || fs.readlinkSync(alias) !== target) throw error;
    }
    removeHostnameAlias(node);
    node.hostnameAliasPath = alias;
  }
  node.hostname = name;
}

function removeHostnameAlias(node) {
  const alias = node.hostnameAliasPath;
  if (!alias) return;
  try { fs.unlinkSync(alias); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  node.hostnameAliasPath = null;
  try { fs.rmdirSync(path.dirname(alias)); } catch (_) {}
}

function getNode(id, create = false, expectedKind = null, existingDir = false) {
  const kind = entityKind(id, expectedKind);
  if (!session.nodes.has(id) && create) {
    const paths = sessionPaths(id, kind);
    if (fs.existsSync(paths.runtimeDir) !== existingDir) throw new Error('Runtime directory state does not match this ID.');
    if (!existingDir) {
      fs.mkdirSync(paths.runtimeDir);
      if (kind === 'host') fs.mkdirSync(path.join(paths.runtimeDir, 'startup'));
    }
    session.nodes.set(id, {
      id,
      kind,
      ...paths,
      machine: null,
      serial: null,
      engine: null,
      qemuAcceleration: null,
      qemuOptions: null,
      launchSettings: null,
      selectedImage: null,
      hostname: null,
      hostnameAliasPath: null,
      everStarted: false,
      stopping: false,
      action: null,
      runLog: [],
      serialBuffer: '',
      serialFilterPending: '',
      serialFilterPassThrough: false,
      generation: 0,
      runDisk: null,
      guestMedia: {script: '#!/bin/sh\n', resources: []},
      guestIso: null,
      guestIsoAttached: false,
      guestIsoOutdated: false,
      guestIsoSource: null,
      activeGuestIso: null,
      guestIsoFiles: new Set(),
      networkInterfaces: [],
      activeConfig: null,
      switchTerminal: null
    });
  }
  return session.nodes.get(id);
}

function stateMessage(node) {
  if (!node.machine) return node.lastMessage || 'Stopped';
  if (node.kind === 'switch') return `VDE switch · ${node.hostname}`;
  if (node.engine.startsWith('qemu')) return `QEMU/${node.qemuAcceleration.toUpperCase()} · ${node.selectedImage.label}`;
  return `VirtualBox · ${node.selectedImage.label}`;
}

function publishState(node, message = stateMessage(node)) {
  node.lastMessage = message;
  const state = {nodeId: node.id, running: !!node.machine, hasLaunched: node.everStarted, pendingRestart: pendingRestart(node), message};
  io.to(node.id).emit('state', state);
  io.emit('nodes-changed', state);
}

function appendLog(node, message) {
  const line = String(message).replace(/\s+$/, '');
  if (!line) return;
  node.runLog.push(line);
  if (node.runLog.length > 1000) node.runLog.shift();
  io.to(node.id).emit('log', {nodeId: node.id, line});
}

function plainSerialLine(line) {
  return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}

function standaloneTerminalControl(text) {
  return /^(?:\r|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[78])+$/.test(text);
}

function possibleGuestHookLine(line) {
  const plain = plainSerialLine(line);
  if (plain.length > 160) return false;
  if (plain.startsWith('\x1b')) return true; // Wait for a split ANSI sequence.
  // OpenRC writes its service label immediately before the hook's first line.
  const openRcPrefix = ' * QemuWeb guest startup ...';
  if (openRcPrefix.startsWith(plain) || plain.startsWith(openRcPrefix)) return true;
  const timestamp = /^\[\s*[\d.]*\]\s*(.*)$/.exec(plain);
  if (timestamp) return 'qemuweb-guest-start'.startsWith(timestamp[1]) || timestamp[1].startsWith('qemuweb-guest-start');
  if (/^\[\s*[\d.]*$/.test(plain)) return true;
  return ['qemuweb-guest-start', 'QEMUWEB_START_'].some(prefix => prefix.startsWith(plain) || plain.startsWith(prefix));
}

function filterGuestHookSerial(node, text) {
  let visible = '';
  for (const char of text) {
    if (node.serialFilterPassThrough) {
      visible += char;
      if (char === '\n') node.serialFilterPassThrough = false;
      continue;
    }
    node.serialFilterPending += char;
    if (char === '\n') {
      if (!/(?:qemuweb-guest-start\[\d+\]:\s*)?QEMUWEB_START_(?:BEGIN|EXIT)\b/.test(plainSerialLine(node.serialFilterPending))) {
        visible += node.serialFilterPending;
      }
      node.serialFilterPending = '';
    } else if (standaloneTerminalControl(node.serialFilterPending)) {
      // Pass CR and complete terminal controls without waiting for a newline.
      visible += node.serialFilterPending;
      node.serialFilterPending = '';
    } else if (!possibleGuestHookLine(node.serialFilterPending)) {
      visible += node.serialFilterPending;
      node.serialFilterPending = '';
      node.serialFilterPassThrough = true;
    }
  }
  return visible;
}

function execLogged(node, command, args, options = {stdio: 'pipe'}) {
  appendLog(node, `$ ${[command, ...args].map(shellQuote).join(' ')}`);
  return execFileSync(command, args, options);
}

app.use(express.json({limit: '6mb'}));
app.use('/api', (req, res, next) => {
  if (session.archiveBusy && !['GET', 'HEAD'].includes(req.method)) return res.status(409).json({error: 'Session archive operation in progress.'});
  next();
});
app.use('/vendor', express.static(path.join(root, 'node_modules/@xterm/xterm')));
app.use('/vendor-addon-fit', express.static(path.join(root, 'node_modules/@xterm/addon-fit')));
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(root, 'public')));

function imageById(id) {
  const catalog = readConfig();
  if (!catalog.systems[id] || id === 'default') return null;
  const qemu = selectedProfile(catalog, id, 'qemu');
  const vbox = selectedProfile(catalog, id, 'vbox');
  const active = selectedProfile(catalog, id, session.engine);
  return {id, label: active.label, startupDiskEnabled: active.startupDiskEnabled,
    images: {raw: qemu.image, vdi: vbox.image},
    virtualbox: {osType: 'Linux_64', networkModel: vbox.networkModel === 'virtio' ? 'virtio' : '82540EM',
      firmware: vbox.firmware, diskBus: vbox.diskInterface,
      diskController: 'IntelAhci', cdromBus: vbox.cdromInterface,
      cdromController: 'PIIX4'}};
}

function allocateName(prefix) {
  const used = new Set([...session.nodes.values()].map(node => node.hostname).filter(Boolean));
  for (let n = 1; n <= 99; n++) {
    const name = `${prefix}${n}`;
    if (!used.has(name)) return name;
  }
  throw new Error(`All 99 ${prefix === 'h' ? 'host' : 'switch'} names have been used.`);
}

function validateQemuOptions(options, partial = false) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid QEMU settings.');
  for (const key of Object.keys(options)) {
    if (!qemuFields.includes(key)) throw new Error(`Unknown QEMU setting: ${key}.`);
  }
  if (!partial && qemuFields.some(key => !Object.hasOwn(options, key))) throw new Error('Incomplete QEMU settings.');
  for (const [key, value] of Object.entries(options)) {
    if (key === 'extraOptions') {
      if (!Array.isArray(value) || value.some(arg => typeof arg !== 'string' || !arg || /[\x00-\x1f\x7f]/.test(arg))) throw new Error('Invalid QEMU extra options.');
      continue;
    }
    if (key === 'memory') {
      if (!Number.isInteger(value) || value < 64 || value > 32768) throw new Error('QEMU memory must be between 64 and 32768 MB.');
      continue;
    }
    if (key === 'smp') {
      if (!Number.isInteger(value) || value < 1 || value > 64) throw new Error('QEMU processors must be between 1 and 64.');
      continue;
    }
    if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error(`Invalid value for ${key}.`);
    }
  }
  if (options.rtcBase && !['utc', 'localtime'].includes(options.rtcBase)) throw new Error('QEMU RTC base must be utc or localtime.');
  if (options.diskInterface && !['virtio', 'ide'].includes(options.diskInterface)) throw new Error('QEMU disk bus must be virtio or ide.');
  if (options.networkModel && !['virtio-net-pci', 'e1000'].includes(options.networkModel)) throw new Error('QEMU network model must be virtio-net-pci or e1000.');
  for (const key of ['bootDisk']) {
    if (options[key] && !/^[a-dn]{1,5}$/.test(options[key])) throw new Error(`Invalid QEMU boot order: ${key}.`);
  }
  return options;
}

function validateLaunchSettings(settings, partial = false) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid launch settings.');
  const allowed = ['memory', 'cpus', 'clock'];
  for (const key of Object.keys(settings)) if (!allowed.includes(key)) throw new Error(`Unknown launch setting: ${key}.`);
  if (!partial && allowed.some(key => !Object.hasOwn(settings, key))) throw new Error('Incomplete launch settings.');
  if (settings.memory !== undefined && (!Number.isInteger(settings.memory) || settings.memory < 64 || settings.memory > 32768)) throw new Error('Memory must be between 64 and 32768 MB.');
  if (settings.cpus !== undefined && (!Number.isInteger(settings.cpus) || settings.cpus < 1 || settings.cpus > 64)) throw new Error('Processors must be between 1 and 64.');
  if (settings.clock !== undefined && !['utc', 'localtime'].includes(settings.clock)) throw new Error('Hardware clock must be utc or localtime.');
  return settings;
}

function readConfig() {
  return readCatalog(configPath);
}

function qemuOptionsFor(imageId, overrides = {}) {
  const p = selectedProfile(readConfig(), imageId, 'qemu');
  const settings = validateLaunchSettings({memory: p.memory, cpus: p.cpus, clock: p.clock, ...overrides});
  const extra = Object.fromEntries([0, 2, 4].map(index => [p.extraOptions[index], p.extraOptions[index + 1]]));
  return validateQemuOptions({machine: extra['-machine'], cpuKvm: extra['-cpu'], display: p.mode === 'text' ? 'none' : null,
    diskInterface: p.diskInterface, networkModel: p.networkModel === 'virtio' ? 'virtio-net-pci' : 'e1000',
    bootDisk: 'c', nic: extra['-nic'], extraOptions: [...p.extraOptions],
    memory: settings.memory, smp: settings.cpus, rtcBase: settings.clock});
}

function launchSettingsFor(imageId, overrides = {}) {
  const p = selectedProfile(readConfig(), imageId, session.engine);
  return validateLaunchSettings({memory: p.memory, cpus: p.cpus, clock: p.clock, ...overrides});
}

app.get('/api/general-settings', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({sessionId: session.id, engine: session.engine, availableEngines});
});

app.put('/api/general-settings', (req, res) => {
  try {
    const engine = req.body?.engine;
    if (!['qemu', 'vbox'].includes(engine) || Object.keys(req.body || {}).some(key => key !== 'engine')) throw new Error('Invalid session engine.');
    if (!availableEngines.includes(engine)) throw new Error('VirtualBox is unavailable on this server.');
    if (engine !== session.engine) {
      if ([...session.nodes.values()].some(node => node.kind === 'host')) {
        return res.status(409).json({error: 'Delete existing hosts before changing the session engine.'});
      }
      saveSessionMetadata(engine);
      session.engine = engine;
      io.emit('general-settings-changed', {sessionId: session.id, engine});
    }
    res.json({sessionId: session.id, engine: session.engine});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.get('/api/systems', (_req, res) => {
  try {
    const config = readConfig();
    res.json(Object.keys(config.systems).filter(id => id !== 'default').map(id => {
      const p = selectedProfile(config, id, session.engine);
      return {id, label: p.label,
        images: {raw: config.systems[id].qemu.image, vdi: config.systems[id].vbox.image},
        memory: p.memory, cpus: p.cpus, clock: p.clock,
        startupDiskEnabled: p.startupDiskEnabled,
        vboxNetworkModel: p.networkModel === 'virtio' ? 'virtio' : '82540EM',
        hasDifferentialDisk: true};
    }));
  } catch (error) { res.status(500).json({error: error.message}); }
});

app.get('/api/guest-cdrom-capability', (_req, res) => res.json({autoBuild: true, previewIso: true}));

app.get('/api/nodes', (_req, res) => {
  res.json([...session.nodes.values()].map(node => ({
    id: node.id,
    kind: node.kind,
    running: !!node.machine,
    hasLaunched: node.everStarted,
    engine: node.engine,
    imageId: node.selectedImage && node.selectedImage.id,
    settings: node.launchSettings,
    hostname: node.hostname,
    networkInterfaces: node.networkInterfaces,
    pendingRestart: pendingRestart(node),
    hasDifferentialDisk: !!node.runDisk && fs.existsSync(node.runDisk),
    message: stateMessage(node)
  })));
});

const MAX_SESSION_ARCHIVE = 0xffffffff;
// Base images are large and rarely change: cache their digest by file identity.
const sha256Cache = new Map();
function fileSha256(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`Base image is not a regular file: ${file}`);
  const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const cached = sha256Cache.get(file);
  if (cached?.key === key) return {size: stat.size, sha256: cached.sha256};
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    let offset = 0;
    while (offset < stat.size) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
      if (!count) throw new Error(`Base image changed while reading: ${file}`);
      hash.update(chunk.subarray(0, count)); offset += count;
    }
  } finally { fs.closeSync(fd); }
  const sha256 = hash.digest('hex');
  sha256Cache.set(file, {key, sha256});
  return {size: stat.size, sha256};
}
function archiveSources(includeDisks, allowRunning = false) {
  if (typeof includeDisks !== 'boolean') throw new Error('Invalid working disk option.');
  if (includeDisks && session.engine === 'vbox') throw new Error('VirtualBox working disk archives are not supported.');
  const runningHosts = [...session.nodes.values()].filter(item => item.kind === 'host' && item.machine);
  if (includeDisks && [...session.nodes.values()].some(item => item.kind === 'host' && item.action)) {
    throw new Error('Wait for the current host action to finish before saving working disks.');
  }
  if (includeDisks && !allowRunning && runningHosts.length) {
    throw new Error('Stop every host before saving working disks.');
  }
  const all = [...session.nodes.values()];
  const sources = [{name: 'session.json', file: session.metadataFile}], systems = new Set();
  const switches = all.filter(item => item.kind === 'switch').map(item => {
    sources.push({name: `${item.id}/switch.json`, file: tempFile(item, 'switch.json')});
    return {id: item.id, name: item.hostname};
  });
  const hosts = all.filter(item => item.kind === 'host').map(item => {
    sources.push({name: `${item.id}/host.json`, file: tempFile(item, 'host.json')});
    const media = readStartupFiles(startupDirectory(item));
    const startup = path.join(item.runtimeDir, 'startup');
    if (fs.existsSync(path.join(startup, 'start.sh'))) sources.push({name: `${item.id}/startup/start.sh`, file: path.join(startup, 'start.sh')});
    for (const resource of media.resources) sources.push({name: `${item.id}/startup/${resource.path}`, file: path.join(startup, resource.path)});
    const disk = includeDisks && !!item.runDisk && fs.existsSync(item.runDisk);
    if (disk) {
      if (!item.engine.startsWith('qemu')) throw new Error('VirtualBox working disk archives are not supported.');
      sources.push({name: `${item.id}/disk.qcow2`, file: item.runDisk});
    }
    systems.add(item.selectedImage.id);
    return {...hostConfiguration(item), disk};
  });
  let logicalBytes = 0, allocatedBytes = 0, estimatedBytes = 8192;
  for (const item of sources) {
    const stat = fs.lstatSync(item.file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular archive file: ${item.name}`);
    if (item.name.endsWith('/disk.qcow2') && stat.size > 64 * 1024 * 1024 * 1024) throw new Error('QCOW2 logical size exceeds 64 GiB limit.');
    logicalBytes += stat.size;
    allocatedBytes += stat.blocks * 512;
    estimatedBytes += item.name.endsWith('/disk.qcow2')
      ? Math.ceil(stat.blocks * 512 * 1.05 + stat.size / 800)
      : stat.size;
    estimatedBytes += 200 + Buffer.byteLength(item.name);
  }
  if (logicalBytes > 256 * 1024 * 1024 * 1024) throw new Error('Session archive logical size exceeds 256 GiB limit.');
  return {sources, hosts, switches, systems, logicalBytes, allocatedBytes, estimatedBytes, runningHosts: runningHosts.length};
}
function validateArchiveSession(snapshot, stage, {discardStaleDisks = false} = {}) {
  const warnings = [];
  if (!['qemu', 'vbox'].includes(snapshot.engine) ||
      !Array.isArray(snapshot.hosts) || !Array.isArray(snapshot.switches) ||
      !snapshot.baseImages || typeof snapshot.baseImages !== 'object' || Array.isArray(snapshot.baseImages)) {
    throw new Error('Invalid archived session.');
  }
  if (!availableEngines.includes(snapshot.engine)) throw new Error('The archived session requires VirtualBox, which is unavailable on this server.');
  const ids = new Set(), names = new Set(), switches = new Set(), macs = new Set(), ports = new Set();
  const expectedFiles = new Set(['session.json']);
  for (const sw of snapshot.switches) {
    if (!sw || typeof sw !== 'object') throw new Error('Invalid switch entry.');
    entityKind(sw.id, 'switch');
    if (ids.has(sw.id) || typeof sw.name !== 'string' || !sw.name.trim() || sw.name.length > 64 || /[\x00-\x1f\x7f]/.test(sw.name) || names.has(sw.name.toLowerCase())) throw new Error('Invalid or duplicate switch identity.');
    ids.add(sw.id); switches.add(sw.id); names.add(sw.name.toLowerCase());
    expectedFiles.add(`${sw.id}/switch.json`);
  }
  const systems = new Set();
  for (const host of snapshot.hosts) {
    if (!host || typeof host !== 'object') throw new Error('Invalid host entry.');
    if (Object.keys(host).some(key => !['schemaVersion', 'id', 'name', 'system', 'engine', 'profileHash', 'config', 'network', 'disk'].includes(key)) ||
        !host.network || Object.keys(host.network).some(key => key !== 'interfaces')) throw new Error('Unknown host configuration keyword.');
    entityKind(host.id, 'host');
    if (ids.has(host.id) || typeof host.name !== 'string' || !host.name.trim() || host.name.length > 64 || /[\x00-\x1f\x7f]/.test(host.name) || names.has(host.name.toLowerCase())) throw new Error('Invalid or duplicate host identity.');
    ids.add(host.id); names.add(host.name.toLowerCase());
    expectedFiles.add(`${host.id}/host.json`);
    if (host.schemaVersion !== 3 || host.engine !== snapshot.engine || !imageById(host.system)) throw new Error(`Unknown system or engine for ${host.name}.`);
    systems.add(host.system);
    const profile = selectedProfile(readConfig(), host.system, host.engine);
    if (host.profileHash !== profileHash(profile)) throw new Error(`System profile changed for ${host.name}; restore its original config.json or recreate the host.`);
    validateOverrides(host.config);
    if (Object.keys(host.config).some(key => host.config[key] === profile[key])) throw new Error(`Redundant host override for ${host.name}.`);
    validateLaunchSettings({memory: host.config.memory ?? profile.memory,
      cpus: host.config.cpus ?? profile.cpus, clock: host.config.clock ?? profile.clock});
    if (typeof (host.config.startupDiskEnabled ?? profile.startupDiskEnabled) !== 'boolean' || typeof host.disk !== 'boolean' ||
        !host.network || !Array.isArray(host.network.interfaces) || host.network.interfaces.length > 4 ||
        (host.disk && !snapshot.engine.startsWith('qemu'))) throw new Error(`Invalid host configuration: ${host.name}.`);
    for (const nic of host.network.interfaces) {
      if (!nic || typeof nic !== 'object' || Array.isArray(nic) ||
          Object.keys(nic).some(key => !['switchId', 'port', 'mac'].includes(key)) ||
          !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(nic.mac) || macs.has(nic.mac)) throw new Error('Invalid or duplicate MAC address.');
      macs.add(nic.mac);
      if (nic.switchId === null) { if (nic.port !== null) throw new Error('Disconnected Ethernet must have no port.'); }
      else {
        if (!switches.has(nic.switchId) || !Number.isInteger(nic.port) || nic.port < 1 || nic.port > 32) throw new Error('Invalid Ethernet switch or port.');
        const key = `${nic.switchId}:${nic.port}`;
        if (ports.has(key)) throw new Error('Duplicate Ethernet switch port.');
        ports.add(key);
      }
    }
    const startup = path.join(stage, host.id, 'startup');
    fs.mkdirSync(startup, {recursive: true});
    const media = readStartupFiles(startup);
    if (host.config.startupDiskEnabled ?? profile.startupDiskEnabled) validateStartupTemplate(media.script, host.network.interfaces, true);
    if (host.disk) expectedFiles.add(`${host.id}/disk.qcow2`);
  }
  if (Object.keys(snapshot.baseImages).length !== systems.size) throw new Error('Base image inventory mismatch.');
  for (const id of systems) {
    const expected = snapshot.baseImages[id], image = imageById(id);
    if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
        Object.keys(expected).some(key => !['format', 'size', 'sha256'].includes(key)) ||
        !Number.isSafeInteger(expected.size) || !/^[0-9a-f]{64}$/.test(expected.sha256)) throw new Error(`Invalid base image identity: ${id}.`);
    if (expected.format !== (snapshot.engine === 'vbox' ? 'vdi' : 'raw')) throw new Error(`Base image format incompatible: ${id}.`);
    const actual = fileSha256(imagePath(image.images[expected.format]));
    if (expected.size === actual.size && expected.sha256 === actual.sha256) continue;
    // A working disk only stores differences from its base image, so it is never
    // reused on a changed base image. Hosts without a working disk start fresh.
    const stale = snapshot.hosts.filter(host => host.system === id && host.disk);
    if (stale.length && !discardStaleDisks) {
      throw new Error(`Base image ${id} changed since this session was saved; working disks of ${stale.map(host => host.name).join(', ')} cannot be reused. Enable "Discard working disks whose base image changed" to load the session without them.`);
    }
    for (const host of stale) {
      host.disk = false;
      fs.rmSync(path.join(stage, host.id, 'disk.qcow2'), {force: true});
    }
    warnings.push({system: id, hosts: snapshot.hosts.filter(host => host.system === id).map(host => host.id),
      message: stale.length
        ? `Base image ${id} changed since this session was saved; working disks of ${stale.map(host => host.name).join(', ')} were discarded and these hosts will start from the current image.`
        : `Base image ${id} changed since this session was saved; its hosts will start from the current image.`});
  }
  for (const file of snapshot.files) {
    const match = /^(h-[0-9a-f]{16})\/startup\/(.+)$/.exec(file);
    if (match && ids.has(match[1])) { expectedFiles.add(file); continue; }
    if (!expectedFiles.has(file)) throw new Error(`Unexpected session archive file: ${file}`);
  }
  if (snapshot.files.length !== expectedFiles.size || snapshot.files.some(file => !expectedFiles.has(file))) throw new Error('Missing session archive files.');
  for (const host of snapshot.hosts.filter(item => item.disk)) {
    const disk = path.join(stage, host.id, 'disk.qcow2');
    const info = JSON.parse(execFileSync(commands.QEMU_IMG, ['info', '--output=json', disk], {encoding: 'utf8', maxBuffer: 1024 * 1024}));
    const image = imageById(host.system);
    if (info.format !== 'qcow2' || info.encrypted || info['data-file'] || info['format-specific']?.data?.['data-file'] || info['format-specific']?.data?.['data-file-raw'] || info['backing-filename-format'] !== 'raw' ||
        !info['backing-filename'] || info['virtual-size'] !== snapshot.baseImages[host.system].size) throw new Error(`Incompatible QCOW2 overlay for ${host.name}.`);
    execFileSync(commands.QEMU_IMG, ['rebase', '-u', '-f', 'qcow2', '-F', 'raw', '-b', imagePath(image.images.raw), disk], {maxBuffer: 1024 * 1024});
    execFileSync(commands.QEMU_IMG, ['check', '-f', 'qcow2', disk], {maxBuffer: 1024 * 1024});
  }
  return warnings;
}
function installArchive(snapshot, stage) {
  if (session.nodes.size) throw new Error('Load requires an empty session.');
  const oldEngine = session.engine, moved = [], created = [];
  const entries = [...snapshot.switches, ...snapshot.hosts];
  for (const entry of entries) if (fs.existsSync(path.join(session.runtimeDir, entry.id))) throw new Error(`Runtime directory already exists: ${entry.id}.`);
  try {
    for (const entry of entries) {
      const source = path.join(stage, entry.id);
      fs.mkdirSync(source, {recursive: true});
      const target = path.join(session.runtimeDir, entry.id);
      fs.renameSync(source, target); moved.push({source, target});
    }
    session.engine = snapshot.engine;
    for (const entry of snapshot.switches) {
      const item = getNode(entry.id, true, 'switch', true); created.push(item);
      setNodeHostname(item, entry.name); item.lastMessage = 'VDE switch stopped';
      persistSwitchConfiguration(item);
    }
    for (const entry of snapshot.hosts) {
      const item = getNode(entry.id, true, 'host', true); created.push(item);
      item.selectedImage = imageById(entry.system); item.engine = snapshot.engine;
      item.profileHash = entry.profileHash;
      const profile = selectedProfile(readConfig(), entry.system, entry.engine);
      item.launchSettings = validateLaunchSettings({memory: entry.config.memory ?? profile.memory,
        cpus: entry.config.cpus ?? profile.cpus, clock: entry.config.clock ?? profile.clock});
      item.networkInterfaces = entry.network.interfaces;
      item.guestIsoAttached = entry.config.startupDiskEnabled ?? profile.startupDiskEnabled;
      item.guestMedia = readStartupFiles(startupDirectory(item));
      item.runDisk = entry.disk ? tempFile(item, 'disk.qcow2') : null;
      item.everStarted = entry.disk;
      item.qemuOptions = entry.disk ? qemuOptionsFor(entry.system, item.launchSettings) : null;
      setNodeHostname(item, entry.name); item.lastMessage = entry.disk ? 'Host stopped; current disk kept' : 'Host stopped; ready to start';
      persistHostConfiguration(item);
    }
    fs.copyFileSync(path.join(stage, 'session.json'), session.metadataFile);
  } catch (error) {
    for (const item of created.reverse()) { try { removeHostnameAlias(item); } catch (_) {} session.nodes.delete(item.id); }
    for (const {source, target} of moved.reverse()) { try { fs.renameSync(target, source); } catch (_) {} }
    session.engine = oldEngine;
    try { saveSessionMetadata(oldEngine); } catch (_) {}
    throw error;
  }
  io.emit('general-settings-changed', {sessionId: session.id, engine: session.engine});
  io.emit('nodes-changed', {nodeId: null});
}
app.get('/api/session-archive/estimate', (req, res) => {
  try {
    const includeDisks = req.query.includeDisks === 'true';
    const {hosts, switches, logicalBytes, allocatedBytes, estimatedBytes: bytes, runningHosts} = archiveSources(includeDisks, includeDisks);
    res.set('Cache-Control', 'no-store');
    res.json({bytes, logicalBytes, allocatedBytes, hosts: hosts.length, switches: switches.length, includeDisks, runningHosts,
      hasWorkingDisks: hosts.some(item => item.disk), format: 'qemuweb-session-v4.zip'});
  } catch (error) { res.status(400).json({error: error.message}); }
});
app.post('/api/session-archive/export', async (req, res) => {
  session.archiveBusy = true;
  const archive = path.join(session.runtimeDir, `.session-export-${crypto.randomBytes(8).toString('hex')}.zip`);
  try {
    const includeDisks = req.body?.includeDisks;
    const prepared = archiveSources(includeDisks, includeDisks);
    const baseImages = {};
    for (const id of prepared.systems) {
      const format = session.engine === 'vbox' ? 'vdi' : 'raw';
      baseImages[id] = {format, ...fileSha256(imagePath(imageById(id).images[format]))};
    }
    if (includeDisks) {
      for (const host of session.nodes.values()) if (host.kind === 'host' && host.machine) {
        try { await stop(host, {forceOnTimeout: false}); }
        catch (error) { throw new Error(`Cannot power off ${host.hostname}: ${error.message}. Hosts already stopped remain stopped.`); }
      }
      for (const sw of session.nodes.values()) if (sw.kind === 'switch' && sw.machine) {
        try { await stopSwitch(sw); }
        catch (error) { throw new Error(`Cannot stop ${sw.hostname}: ${error.message}. Instances already stopped remain stopped.`); }
      }
    }
    const {sources} = includeDisks ? archiveSources(includeDisks) : prepared;
    writeJsonAtomic(session.metadataFile, {...sessionMetadata(), baseImages});
    await writeArchive(archive, sources);
    res.set('Cache-Control', 'no-store');
    // The temporary archive is dot-prefixed; sendFile ignores dotfiles by default.
    res.download(archive, 'qemuweb-session-v4.zip', {dotfiles: 'allow'}, error => {
      session.archiveBusy = false;
      fs.rmSync(archive, {force: true});
      if (error && !res.headersSent) res.status(500).json({error: error.message});
    });
  } catch (error) { session.archiveBusy = false; fs.rmSync(archive, {force: true}); res.status(400).json({error: error.code === 'ENOSPC' ? 'Insufficient disk space to save session archive.' : error.message}); }
});
// Lets the load dialog warn before upload: returns the systems whose current base
// image differs from the one recorded in an archive's session.json.
app.post('/api/session-archive/check', (req, res) => {
  try {
    const {engine, baseImages} = req.body || {};
    if (!['qemu', 'vbox'].includes(engine) || !baseImages || typeof baseImages !== 'object' || Array.isArray(baseImages)) throw new Error('Invalid archived session.');
    const format = engine === 'vbox' ? 'vdi' : 'raw', changed = [];
    for (const [id, expected] of Object.entries(baseImages)) {
      const image = imageById(id);
      if (!image || !expected || expected.format !== format) { changed.push(id); continue; }
      const actual = fileSha256(imagePath(image.images[format]));
      if (actual.size !== expected.size || actual.sha256 !== expected.sha256) changed.push(id);
    }
    res.set('Cache-Control', 'no-store');
    res.json({changed});
  } catch (error) { res.status(400).json({error: error.message}); }
});
app.post('/api/session-archive/import', async (req, res) => {
  session.archiveBusy = true;
  const upload = path.join(session.runtimeDir, `.session-upload-${crypto.randomBytes(8).toString('hex')}.zip`);
  let stage;
  try {
    const autoStart = req.query.autoStart === 'true';
    if (req.query.autoStart !== undefined && !['true', 'false'].includes(req.query.autoStart)) throw new Error('Invalid automatic start option.');
    const discardStaleDisks = req.query.discardStaleDisks === 'true';
    if (req.query.discardStaleDisks !== undefined && !['true', 'false'].includes(req.query.discardStaleDisks)) throw new Error('Invalid working disk option.');
    stage = fs.mkdtempSync(path.join(session.runtimeDir, '.session-import-'));
    if (session.nodes.size) throw new Error('Load requires an empty session.');
    if (req.headers['content-type'] !== 'application/zip') throw new Error('Choose a QemuWeb ZIP archive.');
    const available = fs.statfsSync(session.runtimeDir);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > 0 && declared + 64 * 1024 * 1024 > available.bavail * available.bsize) throw new Error('Insufficient disk space for session archive upload.');
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(upload, {flags: 'wx', mode: 0o600});
      let size = 0;
      req.on('data', chunk => { size += chunk.length; if (size > MAX_SESSION_ARCHIVE) req.destroy(new Error('Session archive exceeds ZIP total size limit (4 GiB).')); });
      req.on('error', reject); out.on('error', reject); out.on('finish', resolve); req.pipe(out);
    });
    if (session.nodes.size) throw new Error('Load requires an empty session.');
    const files = await readArchive(upload, stage);
    const snapshot = archivedSessionFiles(stage, files);
    const warnings = validateArchiveSession(snapshot, stage, {discardStaleDisks});
    installArchive(snapshot, stage);
    const startErrors = [];
    if (autoStart) {
      for (const entry of [...snapshot.switches, ...snapshot.hosts]) {
        const node = session.nodes.get(entry.id);
        try {
          if (node.kind === 'switch') await startSwitch(node);
          else start(node.id, node.engine, node.selectedImage.id, {
            interfaces: node.networkInterfaces.map(nic => nic.switchId)
          });
        } catch (error) {
          const message = `Start failed: ${error.message}`;
          startErrors.push(`${node.hostname}: ${error.message}`);
          publishState(node, message);
        }
      }
    }
    // Log after automatic starts, which reset the run log of fresh hosts.
    for (const warning of warnings) {
      for (const id of warning.hosts) { const node = session.nodes.get(id); if (node) appendLog(node, `# Warning: ${warning.message}`); }
    }
    res.json({ok: true, hosts: snapshot.hosts.length, switches: snapshot.switches.length, startErrors,
      warnings: warnings.map(warning => warning.message)});
  } catch (error) { res.status(error.message === 'Load requires an empty session.' ? 409 : 400).json({error: error.code === 'ENOSPC' ? 'Insufficient disk space to load session archive.' : error.message}); }
  finally { session.archiveBusy = false; fs.rmSync(upload, {force: true}); if (stage) fs.rmSync(stage, {recursive: true, force: true}); }
});

app.get('/api/metrics', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(Object.fromEntries([...session.nodes.values()].filter(node => node.kind === 'host').map(node => {
    if (!node.machine) return [node.id, {status: 'stopped', cpuPercent: null, ramBytes: null}];
    const sample = session.resourceSamples.get(node.id);
    return [node.id, sample?.machine === node.machine
      ? sample.result : {status: 'warming', cpuPercent: null, ramBytes: null}];
  })));
});

function connectSerial(node, attempt = 0, generation = node.generation) {
  if (!node.machine || node.stopping || generation !== node.generation || attempt > 100) return;
  const connection = net.createConnection(node.socketPath);
  connection.once('connect', () => {
    // Serial socket chunks can split a UTF-8 character across reads.
    const decoder = new StringDecoder('utf8');
    const emitSerial = text => {
      if (!text) return;
      node.serialBuffer = (node.serialBuffer + text).slice(-262144);
      io.to(node.id).emit('serial', {nodeId: node.id, data: text});
    };
    const publishSerial = text => emitSerial(filterGuestHookSerial(node, text));
    node.serial = connection;
    publishState(node);
    connection.on('data', data => publishSerial(decoder.write(data)));
    connection.on('close', () => {
      publishSerial(decoder.end());
      emitSerial(node.serialFilterPending);
      node.serialFilterPending = '';
      node.serialFilterPassThrough = false;
      if (node.serial === connection) node.serial = null;
      if (!node.stopping && node.action !== 'reboot' && node.machine) publishState(node, 'Serial console disconnected');
    });
    connection.on('error', error => console.error('serial:', error.message));
  });
  connection.once('error', () => setTimeout(() => connectSerial(node, attempt + 1, generation), 250));
}

function tempFile(node, name) {
  return path.join(node.runtimeDir, name);
}

function guestIsoStatus(node) {
  const attachedNow = !!node.machine && !!node.activeGuestIso;
  return {
    created: !!node.guestIso && fs.existsSync(node.guestIso),
    attached: node.guestIsoAttached,
    attachedNow,
    currentIso: attachedNow && node.activeGuestIso === node.guestIso,
    outdated: node.guestIsoOutdated || (!!node.guestIsoSource &&
      JSON.stringify(readStartupFiles(startupDirectory(node))) !== JSON.stringify(node.guestIsoSource))
  };
}

function startupDirectory(node) {
  return tempFile(node, 'startup');
}

function buildGuestIso(node, destination = tempFile(node, `startup-${crypto.randomUUID()}.iso`)) {
  const next = destination;
  createGuestIso({directory: startupDirectory(node), destination: next, genisoimage: commands.GENISOIMAGE,
    hostname: node.hostname, interfaces: node.networkInterfaces,
    onCommand: (command, args) => appendLog(node, `$ ${[command, ...args].map(shellQuote).join(' ')}`)});
  const previous = node.guestIso;
  node.guestMedia = readStartupFiles(startupDirectory(node));
  node.guestIsoSource = node.guestMedia;
  node.guestIso = next;
  node.guestIsoOutdated = false;
  node.guestIsoFiles.add(next);
  if (previous && previous !== node.activeGuestIso) {
    fs.rmSync(previous, {force: true});
    node.guestIsoFiles.delete(previous);
  }
  appendLog(node, `# Guest setup ISO created: ${next} (label QWEBSTART; read-only)`);
  return guestIsoStatus(node);
}

function cleanupGuestIsoFiles(node) {
  for (const file of node.guestIsoFiles) fs.rmSync(file, {force: true});
  node.guestIsoFiles.clear();
  node.guestIso = null;
  node.guestIsoSource = null;
  node.activeGuestIso = null;
}

function persistSwitchConfiguration(node) {
  writeJsonAtomic(tempFile(node, 'switch.json'), {schemaVersion: 2, id: node.id, name: node.hostname, kind: 'vde'});
}

function activeConfiguration(node) {
  return {
    settings: {...node.launchSettings},
    networkInterfaces: node.networkInterfaces.map(nic => ({...nic})),
    guestMedia: readStartupFiles(startupDirectory(node)),
    startupDiskEnabled: node.guestIsoAttached
  };
}

function pendingRestart(node) {
  if (node?.kind !== 'host' || !node.machine || !node.activeConfig) return false;
  const active = node.activeConfig;
  return ['memory', 'cpus', 'clock'].some(key => node.launchSettings[key] !== active.settings[key]) ||
    JSON.stringify(node.networkInterfaces) !== JSON.stringify(active.networkInterfaces) ||
    JSON.stringify(readStartupFiles(startupDirectory(node))) !== JSON.stringify(active.guestMedia) ||
    node.guestIsoAttached !== active.startupDiskEnabled;
}

function hostConfiguration(node, settings = node.launchSettings, interfaces = node.networkInterfaces,
  startupDiskEnabled = node.guestIsoAttached, name = node.hostname) {
  const profile = selectedProfile(readConfig(), node.selectedImage.id, node.engine);
  const hash = profileHash(profile);
  if (node.profileHash && node.profileHash !== hash) {
    throw new Error(`System profile changed for ${name}; restore its original config.json or recreate the host.`);
  }
  node.profileHash = hash;
  return {
    schemaVersion: 3,
    id: node.id,
    name,
    system: node.selectedImage.id,
    engine: node.engine,
    profileHash: hash,
    config: sparseOverrides(profile, {...settings, startupDiskEnabled}),
    network: {interfaces}
  };
}

function archivedSessionFiles(stage, paths) {
  const metadata = JSON.parse(fs.readFileSync(path.join(stage, 'session.json'), 'utf8'));
  if (metadata.schemaVersion !== 4 || !['qemu', 'vbox'].includes(metadata.engine) ||
      Object.keys(metadata).some(key => !['schemaVersion', 'engine', 'hosts', 'switches', 'baseImages'].includes(key)) ||
      !Array.isArray(metadata.hosts) || !Array.isArray(metadata.switches) ||
      !metadata.baseImages || typeof metadata.baseImages !== 'object' || Array.isArray(metadata.baseImages)) {
    throw new Error('Invalid session.json in archive.');
  }
  const ids = [...metadata.hosts, ...metadata.switches];
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate node entity ID.');
  const readEntity = (id, kind) => {
    entityKind(id, kind);
    const file = path.join(stage, id, kind === 'host' ? 'host.json' : 'switch.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.id !== id || data.schemaVersion !== (kind === 'host' ? 3 : 2)) throw new Error(`Invalid configuration for ${id}.`);
    if (kind === 'switch' && (data.kind !== 'vde' ||
        Object.keys(data).some(key => !['schemaVersion', 'id', 'name', 'kind'].includes(key)))) {
      throw new Error(`Invalid switch configuration for ${id}.`);
    }
    return data;
  };
  const hosts = metadata.hosts.map(id => {
    const data = readEntity(id, 'host');
    return {...data, disk: paths.includes(`${id}/disk.qcow2`)};
  });
  const switches = metadata.switches.map(id => readEntity(id, 'switch'));
  return {engine: metadata.engine, hosts, switches, baseImages: metadata.baseImages, files: paths};
}

function persistHostConfiguration(node) {
  writeJsonAtomic(tempFile(node, 'host.json'), hostConfiguration(node));
}

function hostConfigurationResponse(node) {
  return {...hostConfiguration(node), systemId: node.selectedImage.id, settings: node.launchSettings,
    networkInterfaces: node.networkInterfaces, startupDiskEnabled: node.guestIsoAttached,
    guestMedia: readStartupFiles(startupDirectory(node)), interfaces: node.networkInterfaces.map(nic => nic.switchId),
    running: !!node.machine, hasLaunched: node.everStarted, pendingRestart: pendingRestart(node),
    guestCdrom: guestIsoStatus(node)};
}

function imagePath(file) { return path.resolve(root, file); }

function qemuArgs(node, image, overlay) {
  const settings = node.qemuOptions;
  const common = [
    ...settings.extraOptions, '-accel', node.qemuAcceleration,
    '-display', settings.display, '-m', String(settings.memory), '-smp', String(settings.smp),
    '-rtc', `base=${settings.rtcBase}`, '-monitor', `unix:${node.monitorPath},server=on,wait=off`,
    '-serial', `unix:${node.socketPath},server=on,wait=off`
  ];
  // QEMU PC boot notation: c = first hard disk.
  const args = [...common, '-drive', `file=${overlay},if=${settings.diskInterface},format=qcow2,media=disk`, '-boot', `order=${settings.bootDisk}`];
  if (node.guestIsoAttached && node.guestIso) args.push('-drive', `file=${node.guestIso},if=ide,index=2,media=cdrom,readonly=on,format=raw`);
  // The profile's -nic none disables QEMU's implicit user-network NIC.
  for (const [index, nic] of node.networkInterfaces.entries()) {
    if (nic.switchId === null) {
      args.push('-device', `${settings.networkModel},mac=${nic.mac}`);
      continue;
    }
    const sw = session.nodes.get(nic.switchId);
    const id = `lan${index}`;
    args.push('-netdev', `vde,id=${id},sock=${sw.socketDir},port=${nic.port}`,
      '-device', `${settings.networkModel},netdev=${id},mac=${nic.mac}`);
  }
  return args;
}

function validateNetworkInterfaces(value, engine, requireRunning = true) {
  if (value === undefined) value = [null];
  if (!Array.isArray(value) || value.length > 4) throw new Error('At most four Ethernet interfaces are supported.');
  return value.map((switchId, index) => {
    if (switchId === null) return null;
    const sw = getNode(switchId);
    if (!sw || sw.kind !== 'switch' || (requireRunning && !sw.machine)) throw new Error(`Ethernet ${index}: start its VDE switch first.`);
    return sw;
  });
}

function assignNetworkInterfaces(node, switches) {
  const previous = node.networkInterfaces || [];
  const planned = [];
  const otherInterfaces = [...session.nodes.values()].flatMap(other => [
    ...(other.id === node.id ? [] : other.networkInterfaces || []),
    ...(other.activeConfig?.networkInterfaces || [])
  ]);
  const usedMacs = new Set(otherInterfaces.map(nic => nic.mac));
  for (const [index, sw] of switches.entries()) {
    const switchId = sw?.id ?? null;
    const retained = previous[index];
    if (retained && retained.switchId === switchId) {
      planned.push(retained);
      usedMacs.add(retained.mac);
      continue;
    }
    let mac;
    for (let salt = 0; ; salt++) {
      const digest = crypto.createHash('sha256').update(`${node.id}:${index}${salt ? `:${salt}` : ''}`).digest();
      mac = `02:${[...digest.subarray(0, 5)].map(byte => byte.toString(16).padStart(2, '0')).join(':')}`;
      if (!usedMacs.has(mac)) break;
    }
    usedMacs.add(mac);
    if (sw === null) {
      planned.push({switchId: null, port: null, mac});
      continue;
    }
    const usedPorts = new Set([...otherInterfaces, ...planned]
      .filter(nic => nic.switchId === switchId).map(nic => nic.port));
    const port = Array.from({length: 32}, (_, n) => n + 1).find(n => !usedPorts.has(n));
    if (!port) throw new Error(`No free port on ${sw.hostname}.`);
    planned.push({switchId, port, mac});
  }
  return planned;
}

function linkedHosts(switchId) {
  return [...session.nodes.values()].filter(node => node.kind === 'host' &&
    [...node.networkInterfaces, ...(node.machine ? node.activeConfig?.networkInterfaces || [] : [])]
      .some(nic => nic.switchId === switchId));
}

function stopSwitchTerminal(node) {
  const terminal = node.switchTerminal;
  node.switchTerminal = null;
  if (terminal) {
    try { terminal.kill('SIGTERM'); } catch (_) {}
  }
}

function startSwitchTerminal(node) {
  stopSwitchTerminal(node);
  node.serialBuffer = '';
  io.to(node.id).emit('serial-reset', {nodeId: node.id, serial: ''});
  const socketName = path.basename(node.mgmtPath);
  appendLog(node, `$ ${[commands.VDETERM, socketName].map(shellQuote).join(' ')}  # cwd=${shellQuote(node.runtimeDir)}`);
  const terminal = pty.spawn(commands.VDETERM, [socketName], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: node.runtimeDir,
    env: {...process.env, TERM: 'xterm-256color'}
  });
  node.switchTerminal = terminal;
  terminal.onData(data => {
    node.serialBuffer = (node.serialBuffer + data).slice(-262144);
    io.to(node.id).emit('serial', {nodeId: node.id, data});
  });
  terminal.onExit(({exitCode}) => {
    if (node.switchTerminal !== terminal) return;
    node.switchTerminal = null;
    if (!node.stopping && node.machine) publishState(node, `VDE terminal stopped (${exitCode})`);
  });
}

async function startSwitch(node) {
  if (node.kind !== 'switch' || node.machine) throw new Error('Switch is already running.');
  fs.mkdirSync(node.socketDir, {recursive: true});
  try { fs.unlinkSync(node.mgmtPath); } catch (_) {}
  const args = ['-s', node.socketDir, '-M', node.mgmtPath];
  appendLog(node, `$ ${[commands.VDE_SWITCH, ...args].map(shellQuote).join(' ')}`);
  const child = spawn(commands.VDE_SWITCH, args, {stdio: ['pipe', 'pipe', 'pipe']});
  node.machine = child;
  node.stopping = false;
  child.stdout.on('data', data => appendLog(node, data.toString()));
  child.stderr.on('data', data => appendLog(node, data.toString()));
  child.once('error', error => {
    stopSwitchTerminal(node);
    node.lastMessage = `VDE error: ${error.message}`;
    if (node.machine === child) node.machine = null;
    publishState(node, node.lastMessage);
  });
  child.once('exit', code => {
    stopSwitchTerminal(node);
    if (node.machine === child) node.machine = null;
    try { fs.unlinkSync(node.mgmtPath); } catch (_) {}
    fs.rmSync(node.socketDir, {recursive: true, force: true});
    if (!node.stopping) publishState(node, `VDE stopped (${code})`);
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (fs.existsSync(node.mgmtPath)) {
      try { startSwitchTerminal(node); }
      catch (error) {
        child.kill('SIGTERM');
        node.machine = null;
        try { fs.unlinkSync(node.mgmtPath); } catch (_) {}
        fs.rmSync(node.socketDir, {recursive: true, force: true});
        throw new Error(`Cannot start VDE terminal: ${error.message}`);
      }
      node.everStarted = true;
      publishState(node);
      return;
    }
    if (!node.machine) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (node.machine) { node.machine.kill('SIGTERM'); node.machine = null; }
  throw new Error(node.lastMessage || 'VDE management socket did not appear.');
}

async function stopSwitch(node, force = false) {
  if (!force && linkedHosts(node.id).some(host => host.machine)) throw new Error('Stop connected hosts before stopping this switch.');
  const child = node.machine;
  node.stopping = true;
  stopSwitchTerminal(node);
  if (child) {
    child.kill('SIGTERM');
    try { await waitForQemuExit(child, 3000); }
    catch (_) { child.kill('SIGKILL'); try { await waitForQemuExit(child, 3000); } catch (_) {} }
  }
  node.machine = null;
  try { fs.unlinkSync(node.mgmtPath); } catch (_) {}
  fs.rmSync(node.socketDir, {recursive: true, force: true});
  node.stopping = false;
  publishState(node, 'VDE switch stopped');
}

function qemuAcceleration(engine, checkAvailability = true) {
  if (engine !== 'qemu') throw new Error('Unknown QEMU acceleration mode.');
  if (!checkAvailability) return 'kvm';
  const virtualBoxRunning = [...session.nodes.values()].some(other => other.machine && other.engine === 'vbox');
  if (virtualBoxRunning) throw new Error('QEMU/KVM cannot start while a VirtualBox host is running. Stop that host first.');
  try { fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK); }
  catch (_) { throw new Error('QEMU/KVM is unavailable: /dev/kvm is missing or not accessible. Enable KVM or select VirtualBox if it is installed.'); }
  return 'kvm';
}

function qemuOverlayArgs(image, overlay) {
  return ['create', '-f', 'qcow2', '-F', 'raw', '-b', imagePath(image.images.raw), overlay];
}

function spawnQemu(node, image, reuseDisk = false) {
  const overlay = reuseDisk ? node.runDisk : tempFile(node, 'disk.qcow2');
  if (!overlay || !fs.existsSync(overlay)) {
    if (reuseDisk) throw new Error('The current host disk was not found.');
    execLogged(node, commands.QEMU_IMG, qemuOverlayArgs(image, overlay), {stdio: 'pipe'});
  }
  image.runFiles = [overlay];
  node.runDisk = overlay;
  const args = qemuArgs(node, image, overlay);
  appendLog(node, `$ ${[commands.QEMU_SYSTEM_X86_64, ...args].map(shellQuote).join(' ')}`);
  const child = spawn(commands.QEMU_SYSTEM_X86_64, args, {stdio: ['ignore', 'pipe', 'pipe']});
  node.machine = child;
  child.stdout.on('data', data => { console.log('qemu:', data.toString().trim()); appendLog(node, data.toString()); });
  child.stderr.on('data', data => { console.log('qemu:', data.toString().trim()); appendLog(node, data.toString()); });
  child.once('error', error => {
    if (node.machine === child) {
      node.machine = null;
      node.activeConfig = null;
      node.everStarted = !!node.runDisk;
      try { fs.unlinkSync(node.socketPath); } catch (_) {}
      try { fs.unlinkSync(node.monitorPath); } catch (_) {}
      publishState(node, `QEMU error: ${error.message}`);
    }
  });
  child.once('exit', code => {
    try { fs.unlinkSync(node.socketPath); } catch (_) {}
    try { fs.unlinkSync(node.monitorPath); } catch (_) {}
    if (node.machine === child) { node.machine = null; node.activeConfig = null; }
    if (node.stopping || node.action === 'reboot' || node.action === 'reset' || node.action === 'destroy') return;
    publishState(node, `QEMU stopped (${code})`);
  });
}

function cleanupRunFiles(node, image) {
  for (const file of image.runFiles || []) { try { fs.unlinkSync(file); } catch (_) {} }
  image.runFiles = [];
  node.runDisk = null;
}

function vbox(node, args) {
  return execLogged(node, commands.VBOXMANAGE, args, {stdio: 'pipe'});
}

function virtualBoxNetworkArgs(node, image) {
  const args = [];
  for (let index = 0; index < 4; index++) {
    const number = index + 1;
    const nic = node.networkInterfaces[index];
    if (!nic) { args.push(`--nic${number}`, 'none'); continue; }
    args.push(`--nic${number}`, nic.switchId === null ? 'null' : 'generic',
      `--nictype${number}`, image.virtualbox.networkModel,
      `--macaddress${number}`, nic.mac.replaceAll(':', '').toUpperCase(),
      `--cableconnected${number}`, 'on');
    if (nic.switchId !== null) {
      const sw = session.nodes.get(nic.switchId);
      if (!sw || sw.kind !== 'switch') throw new Error(`Unknown VDE switch for Ethernet ${index}.`);
      args.push(`--nicgenericdrv${number}`, 'VDE',
        `--nicproperty${number}`, `network=${sw.socketDir}[${nic.port}]`);
    }
  }
  return args;
}

function virtualBoxCommands(node, image) {
  const vmDir = tempFile(node, 'vbox-vm');
  const disk = tempFile(node, 'disk.vdi');
  return [
    ['createvm', '--name', node.vmName, '--basefolder', vmDir, '--ostype', image.virtualbox.osType, '--register'],
    ['modifyvm', node.vmName, '--memory', String(node.launchSettings.memory), '--cpus', String(node.launchSettings.cpus), '--rtcuseutc', node.launchSettings.clock === 'utc' ? 'on' : 'off', '--firmware', image.virtualbox.firmware, ...virtualBoxNetworkArgs(node, image), '--uart1', '0x3F8', '4', '--uartmode1', 'server', node.socketPath],
    ['createmedium', 'disk', '--filename', disk, '--diffparent', imagePath(image.images.vdi), '--format', 'VDI'],
    ['storagectl', node.vmName, '--name', 'SATA', '--add', image.virtualbox.diskBus, '--controller', image.virtualbox.diskController],
    ['storageattach', node.vmName, '--storagectl', 'SATA', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', disk],
    ['storagectl', node.vmName, '--name', 'Guest setup', '--add', image.virtualbox.cdromBus, '--controller', image.virtualbox.cdromController],
    ...(node.guestIsoAttached ? [['storageattach', node.vmName, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', node.guestIso]] : []),
    ['modifyvm', node.vmName, '--boot1', 'disk', '--boot2', 'dvd', '--boot3', 'none', '--boot4', 'none'],
    ['startvm', node.vmName, '--type', 'headless']
  ];
}

app.get('/api/nodes/:nodeId/options', (req, res) => {
  try {
    if (Object.keys(req.query).some(key => !['system', 'engine', 'interfaces', 'settings', 'startupDiskEnabled'].includes(key))) {
      throw new Error('Unknown host preview option.');
    }
    if (req.query.startupDiskEnabled !== undefined && !['true', 'false'].includes(req.query.startupDiskEnabled)) {
      throw new Error('startupDiskEnabled must be true or false.');
    }
    const id = req.params.nodeId;
    entityKind(id, 'host');
    const existing = getNode(id);
    const launched = !!(existing && existing.everStarted && existing.selectedImage);
    const image = launched ? existing.selectedImage : imageById(req.query.system);
    const engine = launched ? existing.engine : req.query.engine;
    requireSessionEngine(engine);
    if (!image || !['qemu', 'vbox'].includes(engine)) throw new Error('Unknown system or engine.');
    const requestedInterfaces = req.query.interfaces !== undefined ? JSON.parse(req.query.interfaces)
      : existing?.networkInterfaces.map(nic => nic.switchId);
    const switches = validateNetworkInterfaces(requestedInterfaces, engine, false);
    const savedInterfaces = existing?.networkInterfaces.map(nic => nic.switchId);
    const previewInterfaces = existing && JSON.stringify(requestedInterfaces) === JSON.stringify(savedInterfaces)
      ? existing.networkInterfaces : assignNetworkInterfaces(existing || {id}, switches);
    const node = launched ? existing : {
      id, ...sessionPaths(id),
      generation: existing?.generation || 0,
      engine, qemuAcceleration: engine.startsWith('qemu') ? qemuAcceleration(engine, false) : null,
      launchSettings: launchSettingsFor(image.id, req.query.settings ? JSON.parse(req.query.settings) : {}),
      qemuOptions: null,
      networkInterfaces: previewInterfaces
    };
    const attachGuestCdrom = req.query.startupDiskEnabled === undefined
      ? (existing?.guestIsoAttached ?? image.startupDiskEnabled) : req.query.startupDiskEnabled === 'true';
    if (!launched) node.guestIso = existing?.guestIso || null;
    const isQemu = engine.startsWith('qemu');
    const draftSettings = req.query.settings ? JSON.parse(req.query.settings) : {};
    const userSettings = launched
      ? validateLaunchSettings({...node.launchSettings, ...draftSettings})
      : launchSettingsFor(image.id, draftSettings);
    const options = isQemu
      ? launched ? {...node.qemuOptions, memory: userSettings.memory, smp: userSettings.cpus, rtcBase: userSettings.clock} : qemuOptionsFor(image.id, userSettings)
      : null;
    if (!launched && isQemu) node.qemuOptions = options;
    const nextGuestIso = tempFile(node, `startup-${node.generation + 1}.iso`);
    const previewNode = {...node, launchSettings: userSettings, networkInterfaces: previewInterfaces, qemuOptions: options,
      guestIsoAttached: attachGuestCdrom,
      guestIso: attachGuestCdrom ? nextGuestIso : null};
    const overlay = launched && node.runDisk ? node.runDisk : tempFile(node, 'disk.qcow2');
    const profile = selectedProfile(readConfig(), image.id, engine);
    const fixed = {
      type: profile.type, arch: profile.arch, mode: profile.mode,
      firmware: profile.firmware, acceleration: profile.acceleration, boot: profile.boot,
      diskInterface: profile.diskInterface, networkModel: profile.networkModel,
      cdromInterface: profile.cdromInterface, extraOptions: profile.extraOptions || []
    };
    const isoCommands = attachGuestCdrom
      ? [[commands.GENISOIMAGE, '-quiet', '-R', '-J', '-V', GUEST_ISO_LABEL, '-o', nextGuestIso, tempFile(node, '.iso-stage')]]
      : [];
    const vboxDetachCommand = launched && !isQemu && node.activeGuestIso
      ? [[commands.VBOXMANAGE, 'storageattach', node.vmName, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', 'none']]
      : [];
    const vboxAttachCommand = launched && !isQemu && attachGuestCdrom
      ? [[commands.VBOXMANAGE, 'storageattach', node.vmName, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', previewNode.guestIso]]
      : [];
    const launchCommands = isQemu
      ? [...(launched ? [] : [[commands.QEMU_IMG, ...qemuOverlayArgs(image, overlay)]]), [commands.QEMU_SYSTEM_X86_64, ...qemuArgs(previewNode, image, overlay)]]
      : launched
        ? [...vboxDetachCommand, [commands.VBOXMANAGE, 'modifyvm', node.vmName, '--memory', String(userSettings.memory), '--cpus', String(userSettings.cpus), '--rtcuseutc', userSettings.clock === 'utc' ? 'on' : 'off', ...virtualBoxNetworkArgs(previewNode, image)], ...vboxAttachCommand, [commands.VBOXMANAGE, 'startvm', node.vmName, '--type', 'headless']]
        : virtualBoxCommands(previewNode, image).map(args => [commands.VBOXMANAGE, ...args]);
    const socketLabel = filePath => path.join('runtime', path.relative(runtime, filePath));
    const storage = isQemu
      ? [
          {label: 'Base image (RAW)', path: path.relative(root, imagePath(image.images.raw))},
          {label: 'Working disk (QCOW2 overlay)', path: path.relative(root, overlay)}
        ]
      : [
          {label: 'Base image (VDI)', path: path.relative(root, imagePath(image.images.vdi))},
          {label: 'Working disk (VDI differential)', path: path.relative(root, node.runDisk || tempFile(node, 'disk.vdi'))}
        ];
    storage.push({label: 'Startup disk (cd-rom)', path: attachGuestCdrom ? socketLabel(nextGuestIso) : node.guestIso ? socketLabel(node.guestIso) : 'Not created'});
    res.json({launched, engine, settings: userSettings, fields: launchSettingFields, fixed, storage, interfaces: previewInterfaces.map((nic, index) => ({index: index + 1, switch: nic.switchId === null ? 'Disconnected' : `${session.nodes.get(nic.switchId)?.hostname || nic.switchId} · port ${nic.port}`, port: nic.port, mac: nic.mac})), console: {guest: 'ttyS0 · 115200 baud', socket: socketLabel(node.socketPath)}, monitor: isQemu ? socketLabel(node.monitorPath) : null, commands: [...isoCommands, ...launchCommands].map(args => args.map(shellQuote).join(' '))});
  } catch (error) { res.status(400).json({error: error.message}); }
});

function spawnVirtualBox(node, image) {
  const vmDir = tempFile(node, 'vbox-vm');
  fs.mkdirSync(vmDir, {recursive: true});
  try {
    const disk = tempFile(node, 'disk.vdi');
    image.runFiles = [disk];
    node.runDisk = disk;
    for (const args of virtualBoxCommands(node, image)) vbox(node, args);
    node.machine = {kind: 'vbox', vmDir};
  } catch (error) {
    try { vbox(node, ['controlvm', node.vmName, 'poweroff']); } catch (_) {}
    try { vbox(node, ['unregistervm', node.vmName]); } catch (_) {}
    for (const file of image.runFiles || []) { try { vbox(node, ['closemedium', 'disk', file, '--delete']); } catch (_) {} }
    cleanupRunFiles(node, image);
    fs.rmSync(vmDir, {recursive: true, force: true});
    throw error;
  }
}

function start(nodeId, selectedEngine, imageId, options = {}) {
  const node = getNode(nodeId);
  if (!node) throw new Error('Unknown host configuration.');
  if (node.kind !== 'host') throw new Error('This tab is a VDE switch.');
  if (node.action && !options.reset && !(options.resume && node.action === 'reboot')) throw new Error('An action is already in progress for this host.');
  if (node.machine) throw new Error('This host is already running.');
  const resume = node.everStarted && !options.reset;
  if (resume && (selectedEngine !== node.engine || imageId !== node.selectedImage?.id)) throw new Error('Resume must use the original system and engine.');
  if (resume && (!node.runDisk || !fs.existsSync(node.runDisk))) throw new Error('The current host disk was not found.');
  if (!['qemu', 'vbox'].includes(selectedEngine)) throw new Error('Unknown engine.');
  requireSessionEngine(selectedEngine);
  const acceleration = selectedEngine.startsWith('qemu') ? qemuAcceleration(selectedEngine) : null;
  if (selectedEngine === 'vbox') {
    const qemuWithKvm = [...session.nodes.values()].some(other => other.kind === 'host' && other.machine && other.engine.startsWith('qemu') && other.qemuAcceleration === 'kvm');
    if (qemuWithKvm) throw new Error('VirtualBox cannot start while a QEMU/KVM host is running. Stop that host first.');
  }
  const image = resume ? node.selectedImage : imageById(imageId);
  if (!image) throw new Error('Unknown system in config.json.');
  if (node.profileHash && node.profileHash !== profileHash(selectedProfile(readConfig(), image.id, selectedEngine))) {
    throw new Error(`System profile changed for ${node.hostname}; restore its original config.json or recreate the host.`);
  }
  if (!fs.existsSync(imagePath(image.images.raw))) throw new Error(`RAW image for ${image.label} is missing; run bash scripts/prepare.sh.`);
  if (selectedEngine === 'vbox' && !fs.existsSync(imagePath(image.images.vdi))) throw new Error(`VirtualBox base for ${image.label} is missing; run bash scripts/prepare.sh.`);
  node.guestMedia = readStartupFiles(startupDirectory(node));
  if (options.startupDiskEnabled !== undefined) {
    if (typeof options.startupDiskEnabled !== 'boolean') throw new Error('Invalid startup CD-ROM option.');
    node.guestIsoAttached = options.startupDiskEnabled;
  }
  const launchSettings = resume
    ? validateLaunchSettings({...node.launchSettings, ...(options.settings || {})})
    : launchSettingsFor(image.id, options.settings || {});
  const qemuOptions = selectedEngine.startsWith('qemu')
    ? resume ? {...node.qemuOptions, memory: launchSettings.memory, smp: launchSettings.cpus, rtcBase: launchSettings.clock} : qemuOptionsFor(image.id, launchSettings)
    : null;
  if (resume || options.reset) {
    for (const nic of node.networkInterfaces) validateNetworkInterfaces([nic.switchId], selectedEngine);
  } else {
    const switches = validateNetworkInterfaces(options.interfaces, selectedEngine);
    const saved = node.networkInterfaces.map(nic => nic.switchId);
    node.networkInterfaces = JSON.stringify(options.interfaces) === JSON.stringify(saved)
      ? node.networkInterfaces : assignNetworkInterfaces(node, switches);
  }
  const displayName = node.hostname || allocateName('h');
  if (fs.existsSync(node.socketPath)) fs.unlinkSync(node.socketPath);
  node.stopping = false;
  node.generation += 1;
  if (!options.reset && !resume) node.runLog = [];
  node.serialBuffer = '';
  node.serialFilterPending = '';
  node.serialFilterPassThrough = false;
  node.lastMessage = 'Starting…';
  if (!options.reset && !resume) io.to(node.id).emit('logs-reset', {nodeId: node.id});
  io.to(node.id).emit('serial-reset', {nodeId: node.id});
  appendLog(node, `${options.reset ? '# Reset from base image' : resume ? '# Resuming from current disk' : '# Starting'} · ${selectedEngine} · ${image.label}`);
  node.engine = selectedEngine;
  node.qemuAcceleration = acceleration;
  node.selectedImage = image;
  setNodeHostname(node, displayName);
  node.qemuOptions = qemuOptions;
  node.launchSettings = launchSettings;
  if (node.guestIsoAttached) buildGuestIso(node, tempFile(node, `startup-${node.generation}.iso`));
  if (selectedEngine === 'vbox' && resume) {
    if (!['poweroff', 'aborted'].includes(virtualBoxState(node))) throw new Error('VirtualBox must be powered off before replacing guest startup media.');
    if (node.activeGuestIso) vbox(node, ['storageattach', node.vmName, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', 'none']);
  }
  if (node.guestIsoAttached) appendLog(node, `# Guest setup ISO attached: ${node.guestIso} (read-only)`);
  if (selectedEngine.startsWith('qemu')) spawnQemu(node, image, resume);
  else if (resume) {
    vbox(node, ['modifyvm', node.vmName, '--memory', String(launchSettings.memory), '--cpus', String(launchSettings.cpus), '--rtcuseutc', launchSettings.clock === 'utc' ? 'on' : 'off', ...virtualBoxNetworkArgs(node, image)]);
    if (node.guestIsoAttached) vbox(node, ['storageattach', node.vmName, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', node.guestIso]);
    vbox(node, ['startvm', node.vmName, '--type', 'headless']);
    node.machine = {kind: 'vbox', vmDir: tempFile(node, 'vbox-vm')};
  } else spawnVirtualBox(node, image);
  node.activeGuestIso = node.guestIsoAttached ? node.guestIso : null;
  for (const file of node.guestIsoFiles) if (file !== node.guestIso && file !== node.activeGuestIso) { fs.rmSync(file, {force: true}); node.guestIsoFiles.delete(file); }
  node.everStarted = true;
  node.activeConfig = activeConfiguration(node);
  publishState(node, selectedEngine === 'qemu' ? `QEMU/${node.qemuAcceleration.toUpperCase()} · ${image.label} starting…` : `VirtualBox · ${image.label} starting…`);
  connectSerial(node);
  return node;
}

function sendMonitorCommand(node, command) {
  return new Promise((resolve, reject) => {
    const monitor = net.createConnection(node.monitorPath);
    let output = '';
    let sent = false;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('QEMU command timed out.')), 5000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      monitor.destroy();
      if (error) reject(error);
      else {
        const reply = output.slice(output.indexOf('\n') + 1).replace(/(?:^|[\r\n])\(qemu\) ?$/, '').trim();
        resolve(reply);
      }
    }
    monitor.on('data', data => {
      output += data.toString('utf8');
      if (output.length > 65536) return finish(new Error('Monitor response is too long.'));
      if (!sent && output.includes('(qemu)')) {
        sent = true;
        output = '';
        monitor.write(`${command}\n`, error => { if (error) finish(error); });
      } else if (sent && output.includes('\n') && /(?:^|[\r\n])\(qemu\) ?$/.test(output.slice(output.indexOf('\n') + 1))) finish();
    });
    monitor.once('error', finish);
    monitor.once('close', () => { if (!settled) finish(new Error('QEMU monitor connection closed.')); });
  });
}

function waitForQemuExit(child, timeoutMs = 30000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('The host did not respond to the graceful shutdown request.')), timeoutMs);
    function finish(error) {
      clearTimeout(timeout);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    }
    function onExit() { finish(); }
    function onError(error) { finish(error); }
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function virtualBoxState(node) {
  const output = execFileSync(commands.VBOXMANAGE, ['showvminfo', node.vmName, '--machinereadable'], {encoding: 'utf8'});
  const match = output.match(/^VMState="([^"]+)"/m);
  return match ? match[1] : 'unknown';
}

async function waitForVirtualBoxPowerOff(node, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = virtualBoxState(node);
    if (state === 'poweroff' || state === 'aborted' || state === 'saved') return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('The host did not respond to the graceful shutdown request.');
}

function validateRestartPrerequisites(node) {
  requireSessionEngine(node.engine);
  if (node.engine.startsWith('qemu')) qemuAcceleration(node.engine);
  else if ([...session.nodes.values()].some(other => other.id !== node.id && other.machine && other.engine === 'qemu' && other.qemuAcceleration === 'kvm')) {
    throw new Error('VirtualBox cannot start while a QEMU/KVM host is running. Stop that host first.');
  }
  const image = node.selectedImage;
  if (!fs.existsSync(imagePath(image.images.raw))) throw new Error(`RAW image for ${image.label} is missing; run bash scripts/prepare.sh.`);
  if (node.engine === 'vbox' && !fs.existsSync(imagePath(image.images.vdi))) throw new Error(`VirtualBox base for ${image.label} is missing; run bash scripts/prepare.sh.`);
  for (const nic of node.networkInterfaces) validateNetworkInterfaces([nic.switchId], node.engine);
}

async function reboot(node, startup = {}) {
  if (node?.kind === 'switch') throw new Error('Reboot applies only to hosts.');
  if (!node || !node.everStarted) throw new Error('This host has not started yet.');
  if (!node.machine) throw new Error('The host is stopped; use Play to resume from its current disk.');
  if (node.action) throw new Error('An action is already in progress for this host.');
  if (!node.runDisk || !fs.existsSync(node.runDisk)) throw new Error('The current host disk was not found.');
  validateRestartPrerequisites(node);
  node.action = 'reboot';
  try {
    publishState(node, 'Graceful shutdown before reboot…');
    await stop(node, {publish: false});
    if (node.action !== 'reboot' || !session.nodes.has(node.id)) throw new Error('The node was deleted during reboot.');
    publishState(node, 'Restarting from the current disk…');
    start(node.id, node.engine, node.selectedImage.id, {resume: true, ...startup});
  } catch (error) {
    publishState(node, error.message);
    throw error;
  } finally {
    node.action = null;
    if (node.machine) publishState(node);
  }
}

async function reset(node, settings, startup = {}) {
  if (node?.kind === 'switch') throw new Error('Reset applies only to hosts.');
  if (!node || !node.everStarted || !node.selectedImage) throw new Error('This host has not started yet.');
  if (node.action) throw new Error('An action is already in progress for this host.');
  validateRestartPrerequisites(node);
  const engine = node.engine;
  const imageId = node.selectedImage.id;
  const launchSettings = settings ? validateLaunchSettings({...node.launchSettings, ...settings}) : node.launchSettings;
  node.action = 'reset';
  try {
    publishState(node, 'Resetting from the base image…');
    if (node.machine) await stop(node, {publish: false});
    if (node.action !== 'reset' || !session.nodes.has(node.id)) throw new Error('The node was deleted during reset.');
    discardNodeDisk(node);
    node.everStarted = false;
    start(node.id, engine, imageId, {reset: true, settings: launchSettings, ...startup});
  } catch (error) {
    node.everStarted = !!node.runDisk;
    publishState(node, error.message);
    throw error;
  } finally {
    node.action = null;
    if (node.machine) publishState(node);
  }
}

function discardNodeDisk(node) {
  const image = node.selectedImage;
  if (node.engine === 'vbox') {
    vbox(node, ['unregistervm', node.vmName]);
    for (const file of image.runFiles || []) {
      try { vbox(node, ['closemedium', 'disk', file, '--delete']); }
      catch (error) { appendLog(node, `# VirtualBox medium already unregistered: ${error.message}`); }
    }
    fs.rmSync(tempFile(node, 'vbox-vm'), {recursive: true, force: true});
  }
  cleanupRunFiles(node, image);
  node.activeGuestIso = null;
  for (const file of node.guestIsoFiles) if (file !== node.guestIso) { fs.rmSync(file, {force: true}); node.guestIsoFiles.delete(file); }
}

async function stop(node, options = {}) {
  if (!node || !node.machine) return;
  const ownAction = !node.action;
  if (ownAction) node.action = 'stop';
  node.stopping = true;
  const current = node.machine;
  try {
    if (current.kind === 'vbox') {
      try {
        vbox(node, ['controlvm', node.vmName, 'acpipowerbutton']);
        await waitForVirtualBoxPowerOff(node, 10000);
      } catch (error) {
        const state = virtualBoxState(node);
        if (!['poweroff', 'aborted', 'saved'].includes(state)) {
          if (options.forceOnTimeout === false) throw new Error(`Host did not power off gracefully: ${error.message}`);
          appendLog(node, `# Graceful VirtualBox shutdown failed: ${error.message}; forcing power off`);
          vbox(node, ['controlvm', node.vmName, 'poweroff']);
        }
      }
    } else {
      try {
        appendLog(node, '$ QEMU monitor: system_powerdown');
        await sendMonitorCommand(node, 'system_powerdown');
        await waitForQemuExit(current, 10000);
      } catch (error) {
        if (options.forceOnTimeout === false) throw new Error(`Host did not power off gracefully: ${error.message}`);
        appendLog(node, `# Graceful QEMU shutdown failed: ${error.message}; sending SIGTERM`);
        current.kill('SIGTERM');
        try { await waitForQemuExit(current, 2000); }
        catch (_) {
          appendLog(node, '$ signal sent to qemu-system-x86_64: SIGKILL');
          current.kill('SIGKILL');
          await waitForQemuExit(current, 5000);
        }
      }
    }
    if (node.serial) { node.serial.destroy(); node.serial = null; }
    if (node.machine === current) node.machine = null;
    node.activeConfig = null;
    try { fs.unlinkSync(node.socketPath); } catch (_) {}
    try { fs.unlinkSync(node.monitorPath); } catch (_) {}
    if (options.publish !== false && node.action !== 'destroy') publishState(node, 'Host stopped; current disk kept');
  } finally {
    node.stopping = false;
    if (ownAction && node.action === 'stop') node.action = null;
  }
}

async function destroyNode(node) {
  if (!node) return;
  if (node.kind === 'switch') {
    if (linkedHosts(node.id).length) throw new Error('Remove connected host tabs before deleting this switch.');
    await stopSwitch(node, true);
    removeHostnameAlias(node);
    session.nodes.delete(node.id);
    fs.rmSync(node.runtimeDir, {recursive: true, force: true});
    saveSessionMetadata();
    return;
  }
  node.action = 'destroy';
  node.stopping = true;
  node.generation += 1;
  if (node.serial) { node.serial.destroy(); node.serial = null; }
  const current = node.machine;
  const image = node.selectedImage || {};
  node.machine = null;
  node.activeConfig = null;
  if (node.engine === 'vbox' && node.everStarted && node.selectedImage) {
    if (current) { try { vbox(node, ['controlvm', node.vmName, 'poweroff']); } catch (_) {} }
    try { vbox(node, ['unregistervm', node.vmName]); } catch (_) {}
    for (const file of image.runFiles || []) {
      try { vbox(node, ['closemedium', 'disk', file, '--delete']); } catch (_) {}
    }
    fs.rmSync(tempFile(node, 'vbox-vm'), {recursive: true, force: true});
  } else if (current) {
    appendLog(node, '$ force kill qemu-system-x86_64: SIGKILL');
    current.kill('SIGKILL');
    try { await waitForQemuExit(current, 5000); } catch (_) {}
  }
  cleanupRunFiles(node, image);
  try { fs.unlinkSync(node.socketPath); } catch (_) {}
  try { fs.unlinkSync(node.monitorPath); } catch (_) {}
  cleanupGuestIsoFiles(node);
  node.runLog = [];
  node.serialBuffer = '';
  node.selectedImage = null;
  node.qemuOptions = null;
  node.everStarted = false;
  removeHostnameAlias(node);
  session.nodes.delete(node.id);
  fs.rmSync(node.runtimeDir, {recursive: true, force: true});
  saveSessionMetadata();
}

async function exitAllNodes() {
  const removed = [];
  try {
    for (const kind of ['host', 'switch']) {
      for (const node of [...session.nodes.values()].filter(item => item.kind === kind)) {
        await destroyNode(node);
        removed.push(node.id);
      }
    }
    return removed;
  } finally {
    if (removed.length) io.emit('nodes-removed', {ids: removed});
  }
}

app.post('/api/nodes/:nodeId/start', async (req, res) => {
  try {
    const configured = getNode(req.params.nodeId);
    if (configured?.kind === 'switch') {
      await startSwitch(configured);
      return res.json({ok: true});
    }
    if (!configured || configured.kind !== 'host' || !configured.selectedImage) throw new Error('Unknown host configuration.');
    if (req.body?.engine !== configured.engine || req.body.imageId !== configured.selectedImage.id) throw new Error('Host system and engine differ from the saved configuration.');
    start(configured.id, configured.engine, configured.selectedImage.id, {
      interfaces: configured.networkInterfaces.map(nic => nic.switchId), settings: configured.launchSettings,
      startupDiskEnabled: configured.guestIsoAttached
    });
    res.json({ok: true, nodeId: configured.id, name: configured.hostname});
  } catch (error) {
    const message = error.stderr ? error.stderr.toString().trim() : error.message;
    console.error(message);
    try {
      const node = getNode(req.params.nodeId);
      if (node && node.kind === 'host') publishState(node, message);
    } catch (_) {}
    res.status(getNode(req.params.nodeId)?.kind === 'switch' ? 400 : 500).json({error: message});
  }
});

function validateTopologyRequest(body) {
  const {text, engine = session.engine} = body || {};
  if (!['qemu', 'vbox'].includes(engine)) throw new Error('Unknown engine.');
  requireSessionEngine(engine);
  const topology = parseTopology(text, Object.keys(readConfig().systems).filter(id => id !== 'default'));
  return {topology, engine};
}

app.post('/api/topology/preview', (req, res) => {
  try {
    const {topology} = validateTopologyRequest(req.body);
    res.json({hosts: topology.hosts.length, switches: topology.switches.length});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.post('/api/topology', async (req, res) => {
  const created = [];
  try {
    const {topology, engine} = validateTopologyRequest(req.body);
    const {autostart = false, closePrevious = false} = req.body || {};
    if (typeof autostart !== 'boolean' || typeof closePrevious !== 'boolean') throw new Error('Invalid topology options.');
    const used = new Set(closePrevious ? [] : [...session.nodes.values()].map(node => node.hostname?.toLowerCase()));
    for (const entry of [...topology.switches, ...topology.hosts]) if (used.has(entry.name.toLowerCase())) throw new Error(`Name already exists: ${entry.name}.`);
    if (closePrevious) await exitAllNodes();
    const switchIds = new Map();
    for (const sw of topology.switches) {
      const id = newEntityId('switch');
      const node = getNode(id, true, 'switch'); created.push(id);
      setNodeHostname(node, sw.name); node.lastMessage = 'VDE switch ready to start';
      persistSwitchConfiguration(node);
      switchIds.set(sw.name, id);
    }
    for (const host of topology.hosts) {
      const id = newEntityId('host');
      const interfaces = assignNetworkInterfaces({id}, validateNetworkInterfaces(host.switches.map(name => switchIds.get(name)), engine, false));
      const node = getNode(id, true, 'host'); created.push(id);
      setNodeHostname(node, host.name); node.selectedImage = imageById(host.system); node.engine = engine;
      node.networkInterfaces = interfaces; node.launchSettings = launchSettingsFor(host.system);
      node.guestIsoAttached = node.selectedImage.startupDiskEnabled;
      writeStartupScript(startupDirectory(node), defaultStartupScript(interfaces));
      node.guestMedia = readStartupFiles(startupDirectory(node));
      node.lastMessage = 'Host ready to start';
      persistHostConfiguration(node);
    }
    saveSessionMetadata();
    const errors = [];
    if (autostart) {
      for (const id of created) {
        const node = session.nodes.get(id);
        try {
          if (node.kind === 'switch') await startSwitch(node);
          else start(id, engine, node.selectedImage.id, {interfaces: node.networkInterfaces.map(nic => nic.switchId)});
        } catch (error) {
          node.lastMessage = `Start failed: ${error.message}`;
          errors.push(`${node.hostname}: ${error.message}`);
          publishState(node, node.lastMessage);
        }
      }
    }
    if (created.length) io.emit('nodes-changed', {nodeId: null});
    res.json({created: created.length, errors});
  } catch (error) {
    for (const id of created.reverse()) {
      const node = session.nodes.get(id);
      if (node) {
        try { await destroyNode(node); }
        catch (cleanupError) { console.error('Topology rollback:', cleanupError); }
      }
    }
    res.status(400).json({error: error.message});
  }
});

app.get('/api/topology', (_req, res) => {
  try {
    const all = [...session.nodes.values()];
    const switches = all.filter(node => node.kind === 'switch').map(node => ({name: node.hostname}));
    const hosts = all.filter(node => node.kind === 'host').map(node => ({
      name: node.hostname, system: node.selectedImage?.id,
      switches: node.networkInterfaces.map(nic => {
        const sw = nic.switchId && session.nodes.get(nic.switchId);
        if (!sw || sw.kind !== 'switch') throw new Error(`Host ${node.hostname} has a disconnected interface; .topo cannot represent it.`);
        return sw.hostname;
      })
    }));
    const text = formatTopology({switches, hosts});
    parseTopology(text, Object.keys(readConfig().systems).filter(id => id !== 'default'));
    res.type('text/plain').send(text);
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.post('/api/hosts', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.keys(req.body).some(key => !['id', 'name', 'imageId', 'engine', 'interfaces', 'settings', 'guestMedia', 'startupDiskEnabled'].includes(key))) {
      throw new Error('Unknown host creation option.');
    }
    const {id, name, imageId, engine = session.engine, interfaces, settings, guestMedia, startupDiskEnabled} = req.body || {};
    entityKind(id, 'host');
    if (session.nodes.has(id)) throw new Error('Host ID already exists.');
    const image = imageById(imageId || Object.keys(readConfig().systems).find(id => id !== 'default'));
    if (!image) throw new Error('Unknown system in config.json.');
    if (!['qemu', 'vbox'].includes(engine)) throw new Error('Unknown engine.');
    requireSessionEngine(engine);
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(name))) throw new Error('Invalid host name (1 to 64 characters).');
    const hostname = name === undefined ? allocateName('h') : name.trim();
    if ([...session.nodes.values()].some(other => other.hostname === hostname)) throw new Error('Host name already exists.');
    const networkInterfaces = assignNetworkInterfaces({id}, validateNetworkInterfaces(interfaces, engine, false));
    const launchSettings = launchSettingsFor(image.id, settings || {});
    const validatedMedia = guestMedia === undefined ? {script: defaultStartupScript(networkInterfaces), resources: []} : validateBootFiles(guestMedia);
    if (startupDiskEnabled !== undefined && typeof startupDiskEnabled !== 'boolean') throw new Error('Invalid startup disk option.');
    const buildStartupDisk = startupDiskEnabled ?? image.startupDiskEnabled;
    if (buildStartupDisk) {
      validateStartupTemplate(validatedMedia.script, networkInterfaces, true);
    }
    const node = getNode(id, true, 'host');
    node.selectedImage = image;
    node.engine = engine;
    node.networkInterfaces = networkInterfaces;
    node.launchSettings = launchSettings;
    try {
      writeStartupFiles(startupDirectory(node), validatedMedia);
      node.guestMedia = readStartupFiles(startupDirectory(node));
      setNodeHostname(node, hostname);
      node.guestIsoAttached = buildStartupDisk;
      persistHostConfiguration(node);
      saveSessionMetadata();
    } catch (error) {
      cleanupGuestIsoFiles(node);
      removeHostnameAlias(node);
      session.nodes.delete(id);
      fs.rmSync(node.runtimeDir, {recursive: true, force: true});
      throw error;
    }
    node.lastMessage = 'Host ready to start';
    io.emit('nodes-changed', {nodeId: id, running: false, hasLaunched: false, message: node.lastMessage});
    res.json({...hostConfigurationResponse(node), imageId: image.id});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.get('/api/nodes/:nodeId/config', (req, res) => {
  try {
    const node = getNode(req.params.nodeId);
    if (!node || node.kind !== 'host' || !node.selectedImage) throw new Error('Unknown host.');
    res.set('Cache-Control', 'no-store');
    res.json(hostConfigurationResponse(node));
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.put('/api/nodes/:nodeId/config', (req, res) => {
  try {
    const node = getNode(req.params.nodeId);
    if (!node || node.kind !== 'host' || !node.selectedImage) throw new Error('Unknown host.');
    if (node.action) throw new Error('Wait for the current host action to finish.');
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid host configuration.');
    const required = ['name', 'systemId', 'engine', 'settings', 'interfaces', 'guestMedia', 'startupDiskEnabled'];
    if (Object.keys(body).some(key => !required.includes(key)) || required.some(key => !Object.hasOwn(body, key))) throw new Error('Incomplete host configuration.');
    if (body.systemId !== node.selectedImage.id || body.engine !== node.engine) throw new Error('System and engine are read-only for an existing host.');
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(body.name)) throw new Error('Invalid host name (1 to 64 characters).');
    const name = body.name.trim();
    if ([...session.nodes.values()].some(other => other.id !== node.id && other.hostname === name)) throw new Error('Host name already exists.');
    const settings = validateLaunchSettings(body.settings);
    const media = validateBootFiles(body.guestMedia);
    const script = normalizeScript(media.script);
    if (typeof body.startupDiskEnabled !== 'boolean') throw new Error('Invalid startup CD-ROM option.');
    const switches = validateNetworkInterfaces(body.interfaces, node.engine, false);
    const oldSwitches = node.networkInterfaces.map(nic => nic.switchId);
    const interfaces = JSON.stringify(body.interfaces) === JSON.stringify(oldSwitches)
      ? node.networkInterfaces : assignNetworkInterfaces(node, switches);
    if (body.startupDiskEnabled) validateStartupTemplate(script, interfaces, true);
    const previousName = node.hostname;
    const previousMedia = readStartupFiles(startupDirectory(node));
    const nextMedia = validateBootFiles({script, resources: media.resources});
    const mediaChanged = JSON.stringify(nextMedia) !== JSON.stringify(previousMedia);
    let mediaWritten = false;
    if (name !== previousName) setNodeHostname(node, name);
    try {
      if (mediaChanged) {
        writeStartupFiles(startupDirectory(node), nextMedia);
        mediaWritten = true;
      }
      writeJsonAtomic(tempFile(node, 'host.json'),
        hostConfiguration(node, settings, interfaces, body.startupDiskEnabled, name));
    } catch (error) {
      if (mediaWritten) writeStartupFiles(startupDirectory(node), previousMedia);
      if (name !== previousName) setNodeHostname(node, previousName);
      throw error;
    }
    node.launchSettings = settings;
    node.networkInterfaces = interfaces;
    node.guestMedia = readStartupFiles(startupDirectory(node));
    node.guestIsoAttached = body.startupDiskEnabled;
    if (mediaChanged || name !== previousName) node.guestIsoOutdated = !!node.guestIso;
    if (name !== previousName) io.emit('node-renamed', {nodeId: node.id, name});
    io.emit('nodes-changed', {nodeId: node.id, running: !!node.machine, hasLaunched: node.everStarted, pendingRestart: pendingRestart(node), message: stateMessage(node)});
    res.json(hostConfigurationResponse(node));
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.get('/api/nodes/:nodeId/guest-media', (req, res) => {
  try {
    const node = getNode(req.params.nodeId);
    if (!node || node.kind !== 'host') throw new Error('Unknown host.');
    res.json({...readStartupFiles(startupDirectory(node)), guestCdrom: guestIsoStatus(node)});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.put('/api/nodes/:nodeId/guest-media', (req, res) => {
  try {
    const node = getNode(req.params.nodeId);
    if (!node || node.kind !== 'host') throw new Error('Unknown host.');
    const media = validateBootFiles(req.body);
    if (node.guestIsoAttached) validateStartupTemplate(media.script, node.networkInterfaces, true);
    writeStartupFiles(startupDirectory(node), media);
    node.guestMedia = readStartupFiles(startupDirectory(node));
    node.guestIsoOutdated = !!node.guestIso;
    appendLog(node, '# Guest startup files saved; create the CD-ROM to include these changes.');
    res.json({ok: true, files: node.guestMedia.resources.length, guestCdrom: guestIsoStatus(node)});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.post('/api/nodes/:nodeId/guest-cdrom', (req, res) => {
  try {
    const node = getNode(req.params.nodeId);
    if (!node || node.kind !== 'host') throw new Error('Unknown host.');
    const media = validateBootFiles(req.body);
    validateStartupTemplate(media.script, node.networkInterfaces, true);
    writeStartupFiles(startupDirectory(node), media);
    node.guestMedia = readStartupFiles(startupDirectory(node));
    const status = buildGuestIso(node);
    res.json({ok: true, guestCdrom: status});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.patch('/api/nodes/:nodeId/guest-cdrom', (req, res) => {
  try {
    const node = getNode(req.params.nodeId);
    if (!node || node.kind !== 'host') throw new Error('Unknown host.');
    if (typeof req.body?.attached !== 'boolean') throw new Error('Invalid CD-ROM attachment option.');
    if (req.body.attached && !guestIsoStatus(node).created) throw new Error('Create the CD-ROM before attaching it.');
    const previous = node.guestIsoAttached;
    node.guestIsoAttached = req.body.attached;
    try { persistHostConfiguration(node); }
    catch (error) { node.guestIsoAttached = previous; throw error; }
    res.json({ok: true, guestCdrom: guestIsoStatus(node)});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.post('/api/switches', async (req, res) => {
  let node;
  try {
    const {id, name, autostart = true} = req.body || {};
    if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(name)) throw new Error('Switch name must be 1–32 letters, digits, underscores or hyphens.');
    entityKind(id, 'switch');
    if (session.nodes.has(id) || [...session.nodes.values()].some(s => s.kind === 'switch' && s.hostname === name)) throw new Error('Switch ID or name already exists.');
    node = getNode(id, true, 'switch');
    setNodeHostname(node, name);
    node.lastMessage = 'VDE switch ready to start';
    persistSwitchConfiguration(node);
    saveSessionMetadata();
    if (autostart) await startSwitch(node);
    io.emit('nodes-changed', {nodeId: id, running: !!node.machine, hasLaunched: node.everStarted, message: stateMessage(node)});
    res.json({id, name, running: !!node.machine, message: stateMessage(node)});
  } catch (error) {
    if (node) {
      try { await destroyNode(node); }
      catch (cleanupError) { console.error('Cannot clean up failed switch:', cleanupError); }
    }
    res.status(node ? 500 : 400).json({error: error.message});
  }
});

app.post('/api/nodes/:nodeId/stop', async (req, res) => {
  const target = getNode(req.params.nodeId);
  if (target?.kind === 'switch') {
    try { await stopSwitch(target); res.json({ok: true}); }
    catch (error) { res.status(400).json({error: error.message}); }
    return;
  }
  try {
    if (target && target.action) throw new Error('An action is already in progress for this host.');
    await stop(target);
    res.json({ok: true});
  }
  catch (error) {
    console.error(error);
    try { const node = getNode(req.params.nodeId); if (node) publishState(node, error.message); } catch (_) {}
    res.status(500).json({error: error.message});
  }
});

app.post('/api/nodes/:nodeId/reboot', async (req, res) => {
  try { await reboot(getNode(req.params.nodeId)); res.json({ok: true}); }
  catch (error) { res.status(500).json({error: error.message}); }
});

app.post('/api/nodes/:nodeId/reset', async (req, res) => {
  try { await reset(getNode(req.params.nodeId)); res.json({ok: true}); }
  catch (error) { res.status(500).json({error: error.message}); }
});

app.post('/api/nodes/:nodeId/monitor', async (req, res) => {
  try {
    const node = getNode(req.params.nodeId);
    if (!node || node.kind !== 'host' || !node.machine || !node.engine.startsWith('qemu') || node.action) throw new Error('Monitor is available only for a running QEMU host.');
    const command = req.body && req.body.command;
    if (typeof command !== 'string' || !command.trim() || command.length > 256 || /[\r\n\x00-\x1f\x7f]/.test(command)) throw new Error('Enter a single-line QEMU command (maximum 256 characters).');
    appendLog(node, `$ monitor: ${command}`);
    const output = await sendMonitorCommand(node, command);
    appendLog(node, output || '(no output)');
    res.json({ok: true, output});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.patch('/api/nodes/:nodeId', (req, res) => {
  try {
    const node = getNode(req.params.nodeId);
    const name = req.body && req.body.name;
    if (!node || node.kind !== 'host') throw new Error('Unknown host.');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid name (1 to 64 characters).');
    if ([...session.nodes.values()].some(other => other.id !== node.id && other.hostname === name.trim())) throw new Error('Host name already exists.');
    const previous = node.hostname;
    setNodeHostname(node, name.trim());
    try { persistHostConfiguration(node); }
    catch (error) { setNodeHostname(node, previous); throw error; }
    io.emit('node-renamed', {nodeId: node.id, name: node.hostname});
    res.json({name: node.hostname});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.delete('/api/nodes', async (_req, res) => {
  try { res.json({removed: await exitAllNodes()}); }
  catch (error) { res.status(500).json({error: error.message}); }
});

app.delete('/api/nodes/:nodeId', async (req, res) => {
  try {
    const node = getNode(req.params.nodeId);
    await destroyNode(node);
    io.emit('nodes-removed', {ids: [req.params.nodeId]});
    res.json({ok: true});
  } catch (error) { res.status(500).json({error: error.message}); }
});

io.on('connection', socket => {
  let selectionQueue = Promise.resolve();
  socket.on('select-node', (id, token, acknowledge) => {
    selectionQueue = selectionQueue.then(async () => {
      const node = getNode(id);
      if (!node) throw new Error('Unknown node.');
      if (socket.nodeId && socket.nodeId !== id) {
        await socket.leave(socket.nodeId);
      }
      await socket.join(id);
      socket.nodeId = node.id;
      socket.emit('node-snapshot', {
        nodeId: node.id,
        token,
        state: {running: !!node.machine, message: stateMessage(node), hasLaunched: node.everStarted},
        logs: node.runLog,
        serial: node.serialBuffer
      });
      if (typeof acknowledge === 'function') acknowledge({ok: true});
    }).catch(error => {
      socket.emit('node-error', error.message);
      if (typeof acknowledge === 'function') acknowledge({error: error.message});
    });
  });
  socket.on('leave-node', id => {
    if (id !== socket.nodeId) return;
    socket.leave(id);
    socket.nodeId = null;
  });
  socket.on('input', data => {
    const node = socket.nodeId && session.nodes.get(socket.nodeId);
    if (!node || typeof data !== 'string' || data.length > 4096) return;
    if (node.kind === 'switch' && node.switchTerminal) node.switchTerminal.write(data);
    else if (node.serial) node.serial.write(data);
  });
  socket.on('terminal-resize', request => {
    if (!request || request.id !== socket.nodeId) return;
    const node = session.nodes.get(request.id);
    if (!node || node.kind !== 'switch' || !node.switchTerminal) return;
    const cols = Number(request.cols);
    const rows = Number(request.rows);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) return;
    try { node.switchTerminal.resize(cols, rows); } catch (_) {}
  });
  socket.on('clear-console', request => {
    if (!request || request.id !== socket.nodeId) return;
    const node = session.nodes.get(request.id);
    if (!node) return;
    const line = typeof request.line === 'string' ? request.line.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 1024) : '';
    const column = Number.isInteger(request.column) ? Math.max(0, Math.min(request.column, 1024)) : line.length;
    node.serialBuffer = line ? `${line}\x1b[${column + 1}G` : '';
    io.to(request.id).emit('serial-reset', {nodeId: request.id, preserveLine: true, serial: node.serialBuffer});
  });
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Stop the existing server or run PORT=${port + 1} npm start.`);
    process.exitCode = 1;
    return;
  }
  console.error('Server error:', error);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  pruneEmptyRuntimeSessions();
  fs.mkdirSync(session.runtimeDir, {recursive: true});
  saveSessionMetadata();
  fs.writeFileSync(serverPidFile, `${process.pid}\n`, {mode: 0o600});
  fs.writeFileSync(serverSessionFile, `${session.id}\n${ephemeralServer ? 'test' : 'regular'}\n`, {mode: 0o600});
  linkCurrentSession();
  console.log('\nQemuWeb is ready.');
  console.log(`  Web interface      http://127.0.0.1:${port}`);
  console.log(`  Session ID         ${session.id}`);
  console.log(`  Session directory  ${session.runtimeDir}`);
  console.log('  Stop               Ctrl+C or ./scripts/stop.sh\n');
});

process.on('exit', () => {
  removeCurrentSessionLink();
  try {
    if (fs.readFileSync(serverPidFile, 'utf8').trim() === String(process.pid)) fs.rmSync(serverPidFile, {force: true});
  } catch (_) {}
  try {
    if (fs.readFileSync(serverSessionFile, 'utf8').startsWith(`${session.id}\n`)) fs.rmSync(serverSessionFile, {force: true});
  } catch (_) {}
  removeEmptyRuntimeSession();
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(resourceTimer);
  const forceExit = setTimeout(() => process.exit(1), 10000);
  for (const kind of ['host', 'switch']) {
    await Promise.all([...session.nodes.values()].filter(node => node.kind === kind)
      .map(node => destroyNode(node).catch(error => console.error('Session shutdown:', error))));
  }
  io.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
