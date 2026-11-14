'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const {StringDecoder} = require('string_decoder');
const path = require('path');
const crypto = require('crypto');
const {spawn, spawnSync, execFileSync, execFile} = require('child_process');
const {promisify} = require('util');
const express = require('express');
const {Server: SocketIoServer} = require('socket.io');
const pty = require('node-pty');
const {resolveCommands} = require('./command-preflight');
const {parseHostCpu, parseProcessCpu, parseProcessRss, processCpuPercent, parseVBoxMetrics, getHostCpuTicks, parsePsOutput} = require('./resource-metrics');
const {parseTopology, formatTopology} = require('./topology');
const {writeArchive, readArchive} = require('./session-archive');
const {readCatalog, selectedProfile, profileHash, sparseOverrides, validateOverrides} = require('./system-config');
const {LABEL: GUEST_ISO_LABEL, validateBootFiles, validateStartupTemplate, normalizeScript, readStartupFiles, writeStartupScript, writeStartupFiles, createGuestIso} = require('./guest-media');
const packageInfo = require('./package.json');

const root = __dirname;
let commands;
console.log(`QemuWeb ${packageInfo.version}\n`);
try { commands = resolveCommands(root); }
catch (error) { console.error(error.message); process.exit(1); }
const availableEngines = commands.VBOXMANAGE ? ['qemu', 'vbox'] : ['qemu'];
const runtime = path.join(root, 'runtime');
const sessionId = crypto.randomBytes(8).toString('hex');
const runtimeInstance = path.join(runtime, sessionId);
const sessionFile = path.join(runtimeInstance, 'session.json');
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
const sessions = new Map();
let archiveBusy = false;
const execFileAsync = promisify(execFile);
const resourceSamples = new Map();
const previousProcessSamples = new Map();
const vboxMetricSetup = new Map();
let samplingResources = false;
fs.mkdirSync(runtime, {recursive: true});
readCatalog(configPath);
let sessionEngine = 'qemu';
function detectSupportedQemuAccelerators() {
  try {
    const result = spawnSync(commands.QEMU_SYSTEM_X86_64, ['-accel', 'help'], {encoding: 'utf8', timeout: 5000});
    if (result.status === 0) {
      return result.stdout.split('\n')
        .map(line => line.trim().toLowerCase())
        .filter(line => line && !line.includes('accelerators supported'));
    }
  } catch (_) {}
  return ['tcg'];
}

function detectBestQemuAcceleration() {
  if (process.env.QEMU_ACCEL) return process.env.QEMU_ACCEL;
  const supported = detectSupportedQemuAccelerators();
  if (process.platform === 'linux') {
    try {
      fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
      if (supported.includes('kvm')) return 'kvm';
    } catch (_) {}
  } else if (process.platform === 'darwin') {
    if (supported.includes('hvf')) return 'hvf';
  }
  return 'tcg';
}

const activeQemuAccel = detectBestQemuAcceleration();
if (process.platform === 'linux' && activeQemuAccel !== 'kvm') {
  console.warn('QEMU/KVM unavailable: /dev/kvm is missing or inaccessible.');
}
console.log(`QEMU acceleration: \x1b[32m${activeQemuAccel.toUpperCase()}\x1b[0m${activeQemuAccel === 'tcg' ? ' (software emulation)' : ''}.`);

function pointCurrentSession(id) {
  const temporary = path.join(runtime, `.current-${sessionId}`);
  try {
    fs.symlinkSync(id, temporary, 'dir');
    fs.renameSync(temporary, currentSessionLink);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    console.warn(`Cannot update runtime/current: ${error.message}`);
  }
}

function linkCurrentSession() {
  if (!ephemeralServer) pointCurrentSession(sessionId);
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
    if (fs.readlinkSync(currentSessionLink) !== sessionId) return;
    const live = liveServerSessions();
    const fallback = fs.readdirSync(runtime).filter(name => /^[0-9a-f]{16}$/.test(name) && name !== sessionId && live.has(name) && !live.get(name).ephemeral)
      .map(name => {
        try {
          return {name, started: fs.statSync(path.join(runtime, name)).birthtimeMs};
        } catch (_) { return null; }
      }).filter(Boolean).sort((a, b) => b.started - a.started)[0];
    if (fallback) pointCurrentSession(fallback.name);
    else fs.unlinkSync(currentSessionLink);
  } catch (error) { if (error.code !== 'ENOENT') console.warn(`Cannot remove runtime/current: ${error.message}`); }
}

function removeEmptyRuntimeSession() {
  if (sessions.size) return;
  try {
    for (const name of ['hosts', 'switches']) {
      try { fs.rmdirSync(path.join(runtimeInstance, name)); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
    }
    if (fs.readdirSync(runtimeInstance).some(name => name !== 'session.json')) return;
    const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (!Array.isArray(saved.hosts) || saved.hosts.length || !Array.isArray(saved.switches) || saved.switches.length) return;
    fs.unlinkSync(sessionFile);
    fs.rmdirSync(runtimeInstance);
  } catch (_) { /* Keep incomplete sessions for inspection or later recovery. */ }
}

function pruneEmptyRuntimeSessions() {
  const liveSessions = liveServerSessions();
  let removed = 0;
  for (const name of fs.readdirSync(runtime)) {
    if (!/^[0-9a-f]{16}$/.test(name)) continue;
    const directory = path.join(runtime, name);
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

function saveSessionMetadata(engine = sessionEngine) {
  writeJsonAtomic(sessionFile, sessionMetadata(engine));
}

function sessionMetadata(engine = sessionEngine) {
  const ids = kind => [...sessions.values()]
    .filter(session => session.kind === kind && session.hostname && (kind === 'switch' || session.selectedImage))
    .map(session => session.id).sort();
  return {schemaVersion: 4, engine, hosts: ids('vm'), switches: ids('switch'), baseImages: {}};
}

function entityKind(id, expectedKind) {
  if (typeof id !== 'string' || !/^[hs]-[0-9a-f]{16}$/.test(id)) throw new Error('Invalid host or switch ID; expected h- or s- followed by 16 lowercase hex characters.');
  const kind = id[0] === 'h' ? 'vm' : 'switch';
  if (expectedKind && kind !== expectedKind) throw new Error(`Expected a ${expectedKind === 'vm' ? 'host' : 'switch'} ID.`);
  return kind;
}

function newEntityId(kind) {
  return `${kind === 'switch' ? 's' : 'h'}-${crypto.randomBytes(8).toString('hex')}`;
}

function requireSessionEngine(engine) {
  if (!availableEngines.includes(engine)) throw new Error(`${engine === 'vbox' ? 'VirtualBox' : 'QEMU'} is unavailable on this server.`);
  if (engine !== sessionEngine) throw new Error(`Engine ${engine} differs from this session's ${sessionEngine} engine. Change General Settings before adding hosts.`);
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
    const running = [...sessions.values()].filter(session => session.kind === 'vm' && session.machine);
    const qemuRunning = running.some(session => session.engine?.startsWith('qemu'));
    const hostStat = await fs.promises.readFile('/proc/stat', 'utf8').catch(() => '');
    const hostCpu = qemuRunning ? (parseHostCpu(hostStat) || getHostCpuTicks()) : null;
    await Promise.all(running.map(async session => {
      const machine = session.machine;
      let result;
      if (session.engine?.startsWith('qemu')) {
        const pid = machine.pid;
        const [stat, status] = Number.isInteger(pid) ? await Promise.all([
          fs.promises.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''),
          fs.promises.readFile(`/proc/${pid}/status`, 'utf8').catch(() => '')
        ]) : ['', ''];
        const processCpu = parseProcessCpu(stat);
        const previous = previousProcessSamples.get(session.id);
        const cpuPercent = previous?.machine === machine ? processCpuPercent(previous, processCpu, hostCpu) : null;
        const ramBytes = parseProcessRss(status);
        if (processCpu && hostCpu) previousProcessSamples.set(session.id, {...processCpu, hostTicks: hostCpu.totalTicks, machine});
        if (cpuPercent !== null || ramBytes !== null) {
          result = resourceResult(cpuPercent, ramBytes);
        } else if (Number.isInteger(pid)) {
          try {
            const {stdout} = await execFileAsync('ps', ['-p', String(pid), '-o', '%cpu=,rss='], {encoding: 'utf8', timeout: 2000});
            const psMetrics = parsePsOutput(stdout);
            if (psMetrics) result = resourceResult(psMetrics.cpuPercent, psMetrics.ramBytes);
          } catch (_) {}
        }
      } else if (session.engine === 'vbox') {
        try {
          if (vboxMetricSetup.get(session.id) !== machine) {
            await vboxMetricCommand(['setup', '--period', '2', '--samples', '1', session.vmName, 'CPU/Load,RAM/Usage']);
            if (session.machine !== machine) return;
            vboxMetricSetup.set(session.id, machine);
          }
          const values = parseVBoxMetrics(await vboxMetricCommand([
            'query', session.vmName, 'CPU/Load/User,CPU/Load/Kernel,RAM/Usage/Used'
          ]));
          result = resourceResult(values.cpuPercent, values.ramBytes);
        } catch (_) { result = resourceResult(null, null); }
      }
      if (result && session.machine === machine) resourceSamples.set(session.id, {machine, result});
    }));
    const runningIds = new Set(running.map(session => session.id));
    for (const id of resourceSamples.keys()) if (!runningIds.has(id)) resourceSamples.delete(id);
    for (const id of previousProcessSamples.keys()) if (!runningIds.has(id)) previousProcessSamples.delete(id);
    for (const id of vboxMetricSetup.keys()) if (!runningIds.has(id)) vboxMetricSetup.delete(id);
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

function sessionPaths(id, kind = 'vm') {
  entityKind(id, kind);
  const runtimeDir = path.join(runtimeInstance, id);
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

function hostnameAliasPath(session, name) {
  const encoded = encodeURIComponent(name);
  const safeName = encoded === '.' || encoded === '..' ? encoded.replaceAll('.', '%2E') : encoded;
  const component = Buffer.byteLength(safeName) <= 120
    ? safeName : `${safeName.slice(0, 96)}-${path.basename(session.runtimeDir)}`;
  return path.join(runtimeInstance, session.kind === 'switch' ? 'switches' : 'hosts', component);
}

function setSessionHostname(session, name) {
  const alias = hostnameAliasPath(session, name);
  if (alias !== session.hostnameAliasPath) {
    fs.mkdirSync(path.dirname(alias), {recursive: true});
    const target = path.relative(path.dirname(alias), session.runtimeDir);
    try { fs.symlinkSync(target, alias, 'dir'); }
    catch (error) {
      if (error.code !== 'EEXIST' || fs.readlinkSync(alias) !== target) throw error;
    }
    removeHostnameAlias(session);
    session.hostnameAliasPath = alias;
  }
  session.hostname = name;
}

function removeHostnameAlias(session) {
  const alias = session.hostnameAliasPath;
  if (!alias) return;
  try { fs.unlinkSync(alias); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  session.hostnameAliasPath = null;
  try { fs.rmdirSync(path.dirname(alias)); } catch (_) {}
}

function getSession(id, create = false, expectedKind = null, existingDir = false) {
  const kind = entityKind(id, expectedKind);
  if (!sessions.has(id) && create) {
    const paths = sessionPaths(id, kind);
    if (fs.existsSync(paths.runtimeDir) !== existingDir) throw new Error('Runtime directory state does not match this ID.');
    if (!existingDir) {
      fs.mkdirSync(paths.runtimeDir);
      if (kind === 'vm') fs.mkdirSync(path.join(paths.runtimeDir, 'startup'));
    }
    sessions.set(id, {
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
  return sessions.get(id);
}

function stateMessage(session) {
  if (!session.machine) return session.lastMessage || 'Stopped';
  if (session.kind === 'switch') return `VDE switch · ${session.hostname}`;
  if (session.engine.startsWith('qemu')) return `QEMU/${session.qemuAcceleration.toUpperCase()} · ${session.selectedImage.label}`;
  return `VirtualBox · ${session.selectedImage.label}`;
}

function publishState(session, message = stateMessage(session)) {
  session.lastMessage = message;
  const state = {sessionId: session.id, running: !!session.machine, hasLaunched: session.everStarted, pendingRestart: pendingRestart(session), message};
  io.to(session.id).emit('state', state);
  io.emit('sessions-changed', state);
}

function appendLog(session, message) {
  const line = String(message).replace(/\s+$/, '');
  if (!line) return;
  session.runLog.push(line);
  if (session.runLog.length > 1000) session.runLog.shift();
  io.to(session.id).emit('log', {sessionId: session.id, line});
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

function filterGuestHookSerial(session, text) {
  let visible = '';
  for (const char of text) {
    if (session.serialFilterPassThrough) {
      visible += char;
      if (char === '\n') session.serialFilterPassThrough = false;
      continue;
    }
    session.serialFilterPending += char;
    if (char === '\n') {
      if (!/(?:qemuweb-guest-start\[\d+\]:\s*)?QEMUWEB_START_(?:BEGIN|EXIT)\b/.test(plainSerialLine(session.serialFilterPending))) {
        visible += session.serialFilterPending;
      }
      session.serialFilterPending = '';
    } else if (standaloneTerminalControl(session.serialFilterPending)) {
      // Pass CR and complete terminal controls without waiting for a newline.
      visible += session.serialFilterPending;
      session.serialFilterPending = '';
    } else if (!possibleGuestHookLine(session.serialFilterPending)) {
      visible += session.serialFilterPending;
      session.serialFilterPending = '';
      session.serialFilterPassThrough = true;
    }
  }
  return visible;
}

function execLogged(session, command, args, options = {stdio: 'pipe'}) {
  appendLog(session, `$ ${[command, ...args].map(shellQuote).join(' ')}`);
  return execFileSync(command, args, options);
}

app.use(express.json({limit: '6mb'}));
app.use('/api', (req, res, next) => {
  if (archiveBusy && !['GET', 'HEAD'].includes(req.method)) return res.status(409).json({error: 'Session archive operation in progress.'});
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
  const active = selectedProfile(catalog, id, sessionEngine);
  return {id, label: active.label, startupDiskEnabled: active.startupDiskEnabled,
    images: {raw: qemu.image, vdi: vbox.image},
    virtualbox: {osType: 'Linux_64', networkModel: vbox.networkModel === 'virtio' ? 'virtio' : '82540EM',
      firmware: vbox.firmware, diskBus: vbox.diskInterface,
      diskController: 'IntelAhci', cdromBus: vbox.cdromInterface,
      cdromController: 'PIIX4'}};
}

function allocateName(prefix) {
  const used = new Set([...sessions.values()].map(session => session.hostname).filter(Boolean));
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
  const p = selectedProfile(readConfig(), imageId, sessionEngine);
  return validateLaunchSettings({memory: p.memory, cpus: p.cpus, clock: p.clock, ...overrides});
}

app.get('/api/general-settings', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    sessionId,
    engine: sessionEngine,
    availableEngines,
    vboxAvailable: availableEngines.includes('vbox'),
    qemuAcceleration: detectBestQemuAcceleration()
  });
});

app.put('/api/general-settings', (req, res) => {
  try {
    const engine = req.body?.engine;
    if (!['qemu', 'vbox'].includes(engine) || Object.keys(req.body || {}).some(key => key !== 'engine')) throw new Error('Invalid session engine.');
    if (!availableEngines.includes(engine)) throw new Error('VirtualBox is unavailable on this server.');
    if (engine !== sessionEngine) {
      if ([...sessions.values()].some(session => session.kind === 'vm')) {
        return res.status(409).json({error: 'Delete existing hosts before changing the session engine.'});
      }
      saveSessionMetadata(engine);
      sessionEngine = engine;
      io.emit('general-settings-changed', {sessionId, engine});
    }
    res.json({sessionId, engine: sessionEngine});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.get('/api/systems', (_req, res) => {
  try {
    const config = readConfig();
    res.json(Object.keys(config.systems).filter(id => id !== 'default').map(id => {
      const p = selectedProfile(config, id, sessionEngine);
      const rawFile = config.systems[id].qemu.image;
      const vdiFile = config.systems[id].vbox.image;
      return {id, label: p.label,
        images: {raw: rawFile, vdi: vdiFile},
        imageExists: {
          raw: !!(rawFile && fs.existsSync(imagePath(rawFile))),
          vdi: !!(vdiFile && fs.existsSync(imagePath(vdiFile)))
        },
        memory: p.memory, cpus: p.cpus, clock: p.clock,
        startupDiskEnabled: p.startupDiskEnabled,
        vboxNetworkModel: p.networkModel === 'virtio' ? 'virtio' : '82540EM',
        hasDifferentialDisk: true};
    }));
  } catch (error) { res.status(500).json({error: error.message}); }
});

app.get('/api/guest-cdrom-capability', (_req, res) => res.json({autoBuild: true, previewIso: true}));

app.get('/api/sessions', (_req, res) => {
  res.json([...sessions.values()].map(session => ({
    id: session.id,
    kind: session.kind,
    running: !!session.machine,
    hasLaunched: session.everStarted,
    engine: session.engine,
    imageId: session.selectedImage && session.selectedImage.id,
    settings: session.launchSettings,
    hostname: session.hostname,
    networkInterfaces: session.networkInterfaces,
    pendingRestart: pendingRestart(session),
    hasDifferentialDisk: !!session.runDisk && fs.existsSync(session.runDisk),
    message: stateMessage(session)
  })));
});

const MAX_SESSION_ARCHIVE = 0xffffffff;
function fileSha256(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`Base image is not a regular file: ${file}`);
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
  return {size: stat.size, sha256: hash.digest('hex')};
}
function archiveSources(includeDisks, allowRunning = false) {
  if (typeof includeDisks !== 'boolean') throw new Error('Invalid working disk option.');
  if (includeDisks && sessionEngine === 'vbox') throw new Error('VirtualBox working disk archives are not supported.');
  const runningHosts = [...sessions.values()].filter(item => item.kind === 'vm' && item.machine);
  if (includeDisks && [...sessions.values()].some(item => item.kind === 'vm' && item.action)) {
    throw new Error('Wait for the current host action to finish before saving working disks.');
  }
  if (includeDisks && !allowRunning && runningHosts.length) {
    throw new Error('Stop every host before saving working disks.');
  }
  const all = [...sessions.values()];
  const sources = [{name: 'session.json', file: sessionFile}], systems = new Set();
  const switches = all.filter(item => item.kind === 'switch').map(item => {
    sources.push({name: `${item.id}/switch.json`, file: tempFile(item, 'switch.json')});
    return {id: item.id, name: item.hostname};
  });
  const hosts = all.filter(item => item.kind === 'vm').map(item => {
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
function validateArchiveSession(snapshot, stage) {
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
    entityKind(host.id, 'vm');
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
    if (expected.size !== actual.size || expected.sha256 !== actual.sha256) throw new Error(`Base image incompatible: ${id}.`);
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
}
function installArchive(snapshot, stage) {
  if (sessions.size) throw new Error('Load requires an empty session.');
  const oldEngine = sessionEngine, moved = [], created = [];
  const entries = [...snapshot.switches, ...snapshot.hosts];
  for (const entry of entries) if (fs.existsSync(path.join(runtimeInstance, entry.id))) throw new Error(`Runtime directory already exists: ${entry.id}.`);
  try {
    for (const entry of entries) {
      const source = path.join(stage, entry.id);
      fs.mkdirSync(source, {recursive: true});
      const target = path.join(runtimeInstance, entry.id);
      fs.renameSync(source, target); moved.push({source, target});
    }
    sessionEngine = snapshot.engine;
    for (const entry of snapshot.switches) {
      const item = getSession(entry.id, true, 'switch', true); created.push(item);
      setSessionHostname(item, entry.name); item.lastMessage = 'VDE switch stopped';
      persistSwitchConfiguration(item);
    }
    for (const entry of snapshot.hosts) {
      const item = getSession(entry.id, true, 'vm', true); created.push(item);
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
      setSessionHostname(item, entry.name); item.lastMessage = entry.disk ? 'Host stopped; current disk kept' : 'Host stopped; ready to start';
      persistHostConfiguration(item);
    }
    fs.copyFileSync(path.join(stage, 'session.json'), sessionFile);
  } catch (error) {
    for (const item of created.reverse()) { try { removeHostnameAlias(item); } catch (_) {} sessions.delete(item.id); }
    for (const {source, target} of moved.reverse()) { try { fs.renameSync(target, source); } catch (_) {} }
    sessionEngine = oldEngine;
    try { saveSessionMetadata(oldEngine); } catch (_) {}
    throw error;
  }
  io.emit('general-settings-changed', {sessionId, engine: sessionEngine});
  io.emit('sessions-changed', {sessionId: null});
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
  archiveBusy = true;
  const archive = path.join(runtimeInstance, `.session-export-${crypto.randomBytes(8).toString('hex')}.zip`);
  try {
    const includeDisks = req.body?.includeDisks;
    const prepared = archiveSources(includeDisks, includeDisks);
    const baseImages = {};
    for (const id of prepared.systems) {
      const format = sessionEngine === 'vbox' ? 'vdi' : 'raw';
      baseImages[id] = {format, ...fileSha256(imagePath(imageById(id).images[format]))};
    }
    if (includeDisks) {
      for (const host of sessions.values()) if (host.kind === 'vm' && host.machine) {
        try { await stop(host, {forceOnTimeout: false}); }
        catch (error) { throw new Error(`Cannot power off ${host.hostname}: ${error.message}. Hosts already stopped remain stopped.`); }
      }
      for (const sw of sessions.values()) if (sw.kind === 'switch' && sw.machine) {
        try { await stopSwitch(sw); }
        catch (error) { throw new Error(`Cannot stop ${sw.hostname}: ${error.message}. Instances already stopped remain stopped.`); }
      }
    }
    const {sources} = includeDisks ? archiveSources(includeDisks) : prepared;
    writeJsonAtomic(sessionFile, {...sessionMetadata(), baseImages});
    await writeArchive(archive, sources);
    res.set('Cache-Control', 'no-store');
    // The temporary archive is dot-prefixed; sendFile ignores dotfiles by default.
    res.download(archive, 'qemuweb-session-v4.zip', {dotfiles: 'allow'}, error => {
      archiveBusy = false;
      fs.rmSync(archive, {force: true});
      if (error && !res.headersSent) res.status(500).json({error: error.message});
    });
  } catch (error) { archiveBusy = false; fs.rmSync(archive, {force: true}); res.status(400).json({error: error.code === 'ENOSPC' ? 'Insufficient disk space to save session archive.' : error.message}); }
});
app.post('/api/session-archive/import', async (req, res) => {
  archiveBusy = true;
  const upload = path.join(runtimeInstance, `.session-upload-${crypto.randomBytes(8).toString('hex')}.zip`);
  let stage;
  try {
    const autoStart = req.query.autoStart === 'true';
    if (req.query.autoStart !== undefined && !['true', 'false'].includes(req.query.autoStart)) throw new Error('Invalid automatic start option.');
    stage = fs.mkdtempSync(path.join(runtimeInstance, '.session-import-'));
    if (sessions.size) throw new Error('Load requires an empty session.');
    if (req.headers['content-type'] !== 'application/zip') throw new Error('Choose a QemuWeb ZIP archive.');
    const available = fs.statfsSync(runtimeInstance);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > 0 && declared + 64 * 1024 * 1024 > available.bavail * available.bsize) throw new Error('Insufficient disk space for session archive upload.');
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(upload, {flags: 'wx', mode: 0o600});
      let size = 0;
      req.on('data', chunk => { size += chunk.length; if (size > MAX_SESSION_ARCHIVE) req.destroy(new Error('Session archive exceeds ZIP total size limit (4 GiB).')); });
      req.on('error', reject); out.on('error', reject); out.on('finish', resolve); req.pipe(out);
    });
    if (sessions.size) throw new Error('Load requires an empty session.');
    const files = await readArchive(upload, stage);
    const snapshot = archivedSessionFiles(stage, files);
    validateArchiveSession(snapshot, stage);
    installArchive(snapshot, stage);
    const startErrors = [];
    if (autoStart) {
      for (const entry of [...snapshot.switches, ...snapshot.hosts]) {
        const session = sessions.get(entry.id);
        try {
          if (session.kind === 'switch') await startSwitch(session);
          else start(session.id, session.engine, session.selectedImage.id, {
            interfaces: session.networkInterfaces.map(nic => nic.switchId)
          });
        } catch (error) {
          const message = `Start failed: ${error.message}`;
          startErrors.push(`${session.hostname}: ${error.message}`);
          publishState(session, message);
        }
      }
    }
    res.json({ok: true, hosts: snapshot.hosts.length, switches: snapshot.switches.length, startErrors});
  } catch (error) { res.status(error.message === 'Load requires an empty session.' ? 409 : 400).json({error: error.code === 'ENOSPC' ? 'Insufficient disk space to load session archive.' : error.message}); }
  finally { archiveBusy = false; fs.rmSync(upload, {force: true}); if (stage) fs.rmSync(stage, {recursive: true, force: true}); }
});

app.get('/api/metrics', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(Object.fromEntries([...sessions.values()].filter(session => session.kind === 'vm').map(session => {
    if (!session.machine) return [session.id, {status: 'stopped', cpuPercent: null, ramBytes: null}];
    const sample = resourceSamples.get(session.id);
    return [session.id, sample?.machine === session.machine
      ? sample.result : {status: 'warming', cpuPercent: null, ramBytes: null}];
  })));
});

function connectSerial(session, attempt = 0, generation = session.generation) {
  if (!session.machine || session.stopping || generation !== session.generation || attempt > 100) return;
  const connection = net.createConnection(session.socketPath);
  connection.once('connect', () => {
    // Serial socket chunks can split a UTF-8 character across reads.
    const decoder = new StringDecoder('utf8');
    const emitSerial = text => {
      if (!text) return;
      session.serialBuffer = (session.serialBuffer + text).slice(-262144);
      io.to(session.id).emit('serial', {sessionId: session.id, data: text});
    };
    const publishSerial = text => emitSerial(filterGuestHookSerial(session, text));
    session.serial = connection;
    publishState(session);
    connection.on('data', data => publishSerial(decoder.write(data)));
    connection.on('close', () => {
      publishSerial(decoder.end());
      emitSerial(session.serialFilterPending);
      session.serialFilterPending = '';
      session.serialFilterPassThrough = false;
      if (session.serial === connection) session.serial = null;
      if (!session.stopping && session.action !== 'reboot' && session.machine) publishState(session, 'Serial console disconnected');
    });
    connection.on('error', error => console.error('serial:', error.message));
  });
  connection.once('error', () => setTimeout(() => connectSerial(session, attempt + 1, generation), 250));
}

function tempFile(session, name) {
  return path.join(session.runtimeDir, name);
}

function guestIsoStatus(session) {
  const attachedNow = !!session.machine && !!session.activeGuestIso;
  return {
    created: !!session.guestIso && fs.existsSync(session.guestIso),
    attached: session.guestIsoAttached,
    attachedNow,
    currentIso: attachedNow && session.activeGuestIso === session.guestIso,
    outdated: session.guestIsoOutdated || (!!session.guestIsoSource &&
      JSON.stringify(readStartupFiles(startupDirectory(session))) !== JSON.stringify(session.guestIsoSource))
  };
}

function startupDirectory(session) {
  return tempFile(session, 'startup');
}

function buildGuestIso(session, destination = tempFile(session, `startup-${crypto.randomUUID()}.iso`)) {
  const next = destination;
  createGuestIso({directory: startupDirectory(session), destination: next, genisoimage: commands.GENISOIMAGE,
    hostname: session.hostname, interfaces: session.networkInterfaces,
    onCommand: (command, args) => appendLog(session, `$ ${[command, ...args].map(shellQuote).join(' ')}`)});
  const previous = session.guestIso;
  session.guestMedia = readStartupFiles(startupDirectory(session));
  session.guestIsoSource = session.guestMedia;
  session.guestIso = next;
  session.guestIsoOutdated = false;
  session.guestIsoFiles.add(next);
  if (previous && previous !== session.activeGuestIso) {
    fs.rmSync(previous, {force: true});
    session.guestIsoFiles.delete(previous);
  }
  appendLog(session, `# Guest setup ISO created: ${next} (label QWEBSTART; read-only)`);
  return guestIsoStatus(session);
}

function cleanupGuestIsoFiles(session) {
  for (const file of session.guestIsoFiles) fs.rmSync(file, {force: true});
  session.guestIsoFiles.clear();
  session.guestIso = null;
  session.guestIsoSource = null;
  session.activeGuestIso = null;
}

function persistSwitchConfiguration(session) {
  writeJsonAtomic(tempFile(session, 'switch.json'), {schemaVersion: 2, id: session.id, name: session.hostname, kind: 'vde'});
}

function activeConfiguration(session) {
  return {
    settings: {...session.launchSettings},
    networkInterfaces: session.networkInterfaces.map(nic => ({...nic})),
    guestMedia: readStartupFiles(startupDirectory(session)),
    startupDiskEnabled: session.guestIsoAttached
  };
}

function pendingRestart(session) {
  if (session?.kind !== 'vm' || !session.machine || !session.activeConfig) return false;
  const active = session.activeConfig;
  return ['memory', 'cpus', 'clock'].some(key => session.launchSettings[key] !== active.settings[key]) ||
    JSON.stringify(session.networkInterfaces) !== JSON.stringify(active.networkInterfaces) ||
    JSON.stringify(readStartupFiles(startupDirectory(session))) !== JSON.stringify(active.guestMedia) ||
    session.guestIsoAttached !== active.startupDiskEnabled;
}

function hostConfiguration(session, settings = session.launchSettings, interfaces = session.networkInterfaces,
  startupDiskEnabled = session.guestIsoAttached, name = session.hostname) {
  const profile = selectedProfile(readConfig(), session.selectedImage.id, session.engine);
  const hash = profileHash(profile);
  if (session.profileHash && session.profileHash !== hash) {
    throw new Error(`System profile changed for ${name}; restore its original config.json or recreate the host.`);
  }
  session.profileHash = hash;
  return {
    schemaVersion: 3,
    id: session.id,
    name,
    system: session.selectedImage.id,
    engine: session.engine,
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
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate session entity ID.');
  const readEntity = (id, kind) => {
    entityKind(id, kind);
    const file = path.join(stage, id, kind === 'vm' ? 'host.json' : 'switch.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.id !== id || data.schemaVersion !== (kind === 'vm' ? 3 : 2)) throw new Error(`Invalid configuration for ${id}.`);
    if (kind === 'switch' && (data.kind !== 'vde' ||
        Object.keys(data).some(key => !['schemaVersion', 'id', 'name', 'kind'].includes(key)))) {
      throw new Error(`Invalid switch configuration for ${id}.`);
    }
    return data;
  };
  const hosts = metadata.hosts.map(id => {
    const data = readEntity(id, 'vm');
    return {...data, disk: paths.includes(`${id}/disk.qcow2`)};
  });
  const switches = metadata.switches.map(id => readEntity(id, 'switch'));
  return {engine: metadata.engine, hosts, switches, baseImages: metadata.baseImages, files: paths};
}

function persistHostConfiguration(session) {
  writeJsonAtomic(tempFile(session, 'host.json'), hostConfiguration(session));
}

function hostConfigurationResponse(session) {
  return {...hostConfiguration(session), systemId: session.selectedImage.id, settings: session.launchSettings,
    networkInterfaces: session.networkInterfaces, startupDiskEnabled: session.guestIsoAttached,
    guestMedia: readStartupFiles(startupDirectory(session)), interfaces: session.networkInterfaces.map(nic => nic.switchId),
    running: !!session.machine, hasLaunched: session.everStarted, pendingRestart: pendingRestart(session),
    guestCdrom: guestIsoStatus(session)};
}

function imagePath(file) { return path.resolve(root, file); }

function qemuArgs(session, image, overlay) {
  const settings = session.qemuOptions;
  const extraOptions = [...settings.extraOptions];
  if (session.qemuAcceleration === 'tcg') {
    const cpuIndex = extraOptions.indexOf('-cpu');
    if (cpuIndex !== -1 && extraOptions[cpuIndex + 1] === 'host') {
      extraOptions[cpuIndex + 1] = 'max';
    }
  }
  const common = [
    ...extraOptions, '-accel', session.qemuAcceleration,
    '-display', settings.display, '-m', String(settings.memory), '-smp', String(settings.smp),
    '-rtc', `base=${settings.rtcBase}`, '-monitor', `unix:${session.monitorPath},server=on,wait=off`,
    '-serial', `unix:${session.socketPath},server=on,wait=off`
  ];
  // QEMU PC boot notation: c = first hard disk.
  const args = [...common, '-drive', `file=${overlay},if=${settings.diskInterface},format=qcow2,media=disk`, '-boot', `order=${settings.bootDisk}`];
  if (session.guestIsoAttached && session.guestIso) args.push('-drive', `file=${session.guestIso},if=ide,index=2,media=cdrom,readonly=on,format=raw`);
  // The profile's -nic none disables QEMU's implicit user-network NIC.
  for (const [index, nic] of session.networkInterfaces.entries()) {
    if (nic.switchId === null) {
      args.push('-device', `${settings.networkModel},mac=${nic.mac}`);
      continue;
    }
    const sw = sessions.get(nic.switchId);
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
    const sw = getSession(switchId);
    if (!sw || sw.kind !== 'switch' || (requireRunning && !sw.machine)) throw new Error(`Ethernet ${index}: start its VDE switch first.`);
    return sw;
  });
}

function assignNetworkInterfaces(session, switches) {
  const previous = session.networkInterfaces || [];
  const planned = [];
  const otherInterfaces = [...sessions.values()].flatMap(other => [
    ...(other.id === session.id ? [] : other.networkInterfaces || []),
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
      const digest = crypto.createHash('sha256').update(`${session.id}:${index}${salt ? `:${salt}` : ''}`).digest();
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
  return [...sessions.values()].filter(session => session.kind === 'vm' &&
    [...session.networkInterfaces, ...(session.machine ? session.activeConfig?.networkInterfaces || [] : [])]
      .some(nic => nic.switchId === switchId));
}

function stopSwitchTerminal(session) {
  const terminal = session.switchTerminal;
  session.switchTerminal = null;
  if (terminal) {
    try { terminal.kill('SIGTERM'); } catch (_) {}
  }
}

function startSwitchTerminal(session) {
  stopSwitchTerminal(session);
  session.serialBuffer = '';
  io.to(session.id).emit('serial-reset', {sessionId: session.id, serial: ''});
  const socketName = path.basename(session.mgmtPath);
  appendLog(session, `$ ${[commands.VDETERM, socketName].map(shellQuote).join(' ')}  # cwd=${shellQuote(session.runtimeDir)}`);
  const terminal = pty.spawn(commands.VDETERM, [socketName], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: session.runtimeDir,
    env: {...process.env, TERM: 'xterm-256color'}
  });
  session.switchTerminal = terminal;
  terminal.onData(data => {
    session.serialBuffer = (session.serialBuffer + data).slice(-262144);
    io.to(session.id).emit('serial', {sessionId: session.id, data});
  });
  terminal.onExit(({exitCode}) => {
    if (session.switchTerminal !== terminal) return;
    session.switchTerminal = null;
    if (!session.stopping && session.machine) publishState(session, `VDE terminal stopped (${exitCode})`);
  });
}

async function startSwitch(session) {
  if (session.kind !== 'switch' || session.machine) throw new Error('Switch is already running.');
  fs.mkdirSync(session.socketDir, {recursive: true});
  try { fs.unlinkSync(session.mgmtPath); } catch (_) {}
  const args = ['-s', session.socketDir, '-M', session.mgmtPath];
  appendLog(session, `$ ${[commands.VDE_SWITCH, ...args].map(shellQuote).join(' ')}`);
  const child = spawn(commands.VDE_SWITCH, args, {stdio: ['pipe', 'pipe', 'pipe']});
  session.machine = child;
  session.stopping = false;
  child.stdout.on('data', data => appendLog(session, data.toString()));
  child.stderr.on('data', data => appendLog(session, data.toString()));
  child.once('error', error => {
    stopSwitchTerminal(session);
    session.lastMessage = `VDE error: ${error.message}`;
    if (session.machine === child) session.machine = null;
    publishState(session, session.lastMessage);
  });
  child.once('exit', code => {
    stopSwitchTerminal(session);
    if (session.machine === child) session.machine = null;
    try { fs.unlinkSync(session.mgmtPath); } catch (_) {}
    fs.rmSync(session.socketDir, {recursive: true, force: true});
    if (!session.stopping) publishState(session, `VDE stopped (${code})`);
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (fs.existsSync(session.mgmtPath)) {
      try { startSwitchTerminal(session); }
      catch (error) {
        child.kill('SIGTERM');
        session.machine = null;
        try { fs.unlinkSync(session.mgmtPath); } catch (_) {}
        fs.rmSync(session.socketDir, {recursive: true, force: true});
        throw new Error(`Cannot start VDE terminal: ${error.message}`);
      }
      session.everStarted = true;
      publishState(session);
      return;
    }
    if (!session.machine) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (session.machine) { session.machine.kill('SIGTERM'); session.machine = null; }
  throw new Error(session.lastMessage || 'VDE management socket did not appear.');
}

async function stopSwitch(session, force = false) {
  if (!force && linkedHosts(session.id).some(host => host.machine)) throw new Error('Stop connected hosts before stopping this switch.');
  const child = session.machine;
  session.stopping = true;
  stopSwitchTerminal(session);
  if (child) {
    child.kill('SIGTERM');
    try { await waitForQemuExit(child, 3000); }
    catch (_) { child.kill('SIGKILL'); try { await waitForQemuExit(child, 3000); } catch (_) {} }
  }
  session.machine = null;
  try { fs.unlinkSync(session.mgmtPath); } catch (_) {}
  fs.rmSync(session.socketDir, {recursive: true, force: true});
  session.stopping = false;
  publishState(session, 'VDE switch stopped');
}

function qemuAcceleration(engine, checkAvailability = true) {
  if (engine !== 'qemu') throw new Error('Unknown QEMU acceleration mode.');
  const accel = detectBestQemuAcceleration();
  if (!checkAvailability) return accel;
  const virtualBoxRunning = [...sessions.values()].some(other => other.machine && other.engine === 'vbox');
  if (virtualBoxRunning && accel === 'kvm') {
    throw new Error('QEMU/KVM cannot start while a VirtualBox host is running. Stop that host first.');
  }
  if (accel === 'kvm') {
    try { fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK); }
    catch (_) { throw new Error('QEMU/KVM is unavailable: /dev/kvm is missing or not accessible. Enable KVM or select VirtualBox if it is installed.'); }
  }
  return accel;
}

function qemuOverlayArgs(image, overlay) {
  return ['create', '-f', 'qcow2', '-F', 'raw', '-b', imagePath(image.images.raw), overlay];
}

function spawnQemu(session, image, reuseDisk = false) {
  const overlay = reuseDisk ? session.runDisk : tempFile(session, 'disk.qcow2');
  if (!overlay || !fs.existsSync(overlay)) {
    if (reuseDisk) throw new Error('The current host disk was not found.');
    execLogged(session, commands.QEMU_IMG, qemuOverlayArgs(image, overlay), {stdio: 'pipe'});
  }
  image.runFiles = [overlay];
  session.runDisk = overlay;
  const args = qemuArgs(session, image, overlay);
  appendLog(session, `$ ${[commands.QEMU_SYSTEM_X86_64, ...args].map(shellQuote).join(' ')}`);
  const child = spawn(commands.QEMU_SYSTEM_X86_64, args, {stdio: ['ignore', 'pipe', 'pipe']});
  session.machine = child;
  child.stdout.on('data', data => { console.log('qemu:', data.toString().trim()); appendLog(session, data.toString()); });
  child.stderr.on('data', data => { console.log('qemu:', data.toString().trim()); appendLog(session, data.toString()); });
  child.once('error', error => {
    if (session.machine === child) {
      session.machine = null;
      session.activeConfig = null;
      session.everStarted = !!session.runDisk;
      try { fs.unlinkSync(session.socketPath); } catch (_) {}
      try { fs.unlinkSync(session.monitorPath); } catch (_) {}
      publishState(session, `QEMU error: ${error.message}`);
    }
  });
  child.once('exit', code => {
    try { fs.unlinkSync(session.socketPath); } catch (_) {}
    try { fs.unlinkSync(session.monitorPath); } catch (_) {}
    if (session.machine === child) { session.machine = null; session.activeConfig = null; }
    if (session.stopping || session.action === 'reboot' || session.action === 'reset' || session.action === 'destroy') return;
    publishState(session, `QEMU stopped (${code})`);
  });
}

function cleanupRunFiles(session, image) {
  for (const file of image.runFiles || []) { try { fs.unlinkSync(file); } catch (_) {} }
  image.runFiles = [];
  session.runDisk = null;
}

function vbox(session, args) {
  return execLogged(session, commands.VBOXMANAGE, args, {stdio: 'pipe'});
}

function virtualBoxNetworkArgs(session, image) {
  const args = [];
  for (let index = 0; index < 4; index++) {
    const number = index + 1;
    const nic = session.networkInterfaces[index];
    if (!nic) { args.push(`--nic${number}`, 'none'); continue; }
    args.push(`--nic${number}`, nic.switchId === null ? 'null' : 'generic',
      `--nictype${number}`, image.virtualbox.networkModel,
      `--macaddress${number}`, nic.mac.replaceAll(':', '').toUpperCase(),
      `--cableconnected${number}`, 'on');
    if (nic.switchId !== null) {
      const sw = sessions.get(nic.switchId);
      if (!sw || sw.kind !== 'switch') throw new Error(`Unknown VDE switch for Ethernet ${index}.`);
      args.push(`--nicgenericdrv${number}`, 'VDE',
        `--nicproperty${number}`, `network=${sw.socketDir}[${nic.port}]`);
    }
  }
  return args;
}

function virtualBoxCommands(session, image) {
  const vmDir = tempFile(session, 'vbox-vm');
  const disk = tempFile(session, 'disk.vdi');
  return [
    ['createvm', '--name', session.vmName, '--basefolder', vmDir, '--ostype', image.virtualbox.osType, '--register'],
    ['modifyvm', session.vmName, '--memory', String(session.launchSettings.memory), '--cpus', String(session.launchSettings.cpus), '--rtcuseutc', session.launchSettings.clock === 'utc' ? 'on' : 'off', '--firmware', image.virtualbox.firmware, ...virtualBoxNetworkArgs(session, image), '--uart1', '0x3F8', '4', '--uartmode1', 'server', session.socketPath],
    ['createmedium', 'disk', '--filename', disk, '--diffparent', imagePath(image.images.vdi), '--format', 'VDI'],
    ['storagectl', session.vmName, '--name', 'SATA', '--add', image.virtualbox.diskBus, '--controller', image.virtualbox.diskController],
    ['storageattach', session.vmName, '--storagectl', 'SATA', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', disk],
    ['storagectl', session.vmName, '--name', 'Guest setup', '--add', image.virtualbox.cdromBus, '--controller', image.virtualbox.cdromController],
    ...(session.guestIsoAttached ? [['storageattach', session.vmName, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', session.guestIso]] : []),
    ['modifyvm', session.vmName, '--boot1', 'disk', '--boot2', 'dvd', '--boot3', 'none', '--boot4', 'none'],
    ['startvm', session.vmName, '--type', 'headless']
  ];
}

app.get('/api/options/:sessionId', (req, res) => {
  try {
    if (Object.keys(req.query).some(key => !['system', 'engine', 'interfaces', 'settings', 'startupDiskEnabled'].includes(key))) {
      throw new Error('Unknown host preview option.');
    }
    if (req.query.startupDiskEnabled !== undefined && !['true', 'false'].includes(req.query.startupDiskEnabled)) {
      throw new Error('startupDiskEnabled must be true or false.');
    }
    const id = req.params.sessionId;
    entityKind(id, 'vm');
    const existing = getSession(id);
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
    const session = launched ? existing : {
      id, ...sessionPaths(id),
      generation: existing?.generation || 0,
      engine, qemuAcceleration: engine.startsWith('qemu') ? qemuAcceleration(engine, false) : null,
      launchSettings: launchSettingsFor(image.id, req.query.settings ? JSON.parse(req.query.settings) : {}),
      qemuOptions: null,
      networkInterfaces: previewInterfaces
    };
    const attachGuestCdrom = req.query.startupDiskEnabled === undefined
      ? (existing?.guestIsoAttached ?? image.startupDiskEnabled) : req.query.startupDiskEnabled === 'true';
    if (!launched) session.guestIso = existing?.guestIso || null;
    const isQemu = engine.startsWith('qemu');
    const draftSettings = req.query.settings ? JSON.parse(req.query.settings) : {};
    const userSettings = launched
      ? validateLaunchSettings({...session.launchSettings, ...draftSettings})
      : launchSettingsFor(image.id, draftSettings);
    const options = isQemu
      ? launched ? {...session.qemuOptions, memory: userSettings.memory, smp: userSettings.cpus, rtcBase: userSettings.clock} : qemuOptionsFor(image.id, userSettings)
      : null;
    if (!launched && isQemu) session.qemuOptions = options;
    const nextGuestIso = tempFile(session, `startup-${session.generation + 1}.iso`);
    const previewSession = {...session, launchSettings: userSettings, networkInterfaces: previewInterfaces, qemuOptions: options,
      guestIsoAttached: attachGuestCdrom,
      guestIso: attachGuestCdrom ? nextGuestIso : null};
    const overlay = launched && session.runDisk ? session.runDisk : tempFile(session, 'disk.qcow2');
    const profile = selectedProfile(readConfig(), image.id, engine);
    const fixed = {
      type: profile.type, arch: profile.arch, mode: profile.mode,
      firmware: profile.firmware,
      acceleration: isQemu ? (previewSession.qemuAcceleration || 'tcg') : profile.acceleration,
      boot: profile.boot,
      diskInterface: profile.diskInterface, networkModel: profile.networkModel,
      cdromInterface: profile.cdromInterface, extraOptions: profile.extraOptions || []
    };
    const isoCommands = attachGuestCdrom
      ? [[commands.GENISOIMAGE, '-quiet', '-R', '-J', '-V', GUEST_ISO_LABEL, '-o', nextGuestIso, tempFile(session, '.iso-stage')]]
      : [];
    const vboxDetachCommand = launched && !isQemu && session.activeGuestIso
      ? [[commands.VBOXMANAGE, 'storageattach', session.vmName, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', 'none']]
      : [];
    const vboxAttachCommand = launched && !isQemu && attachGuestCdrom
      ? [[commands.VBOXMANAGE, 'storageattach', session.vmName, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', previewSession.guestIso]]
      : [];
    const launchCommands = isQemu
      ? [...(launched ? [] : [[commands.QEMU_IMG, ...qemuOverlayArgs(image, overlay)]]), [commands.QEMU_SYSTEM_X86_64, ...qemuArgs(previewSession, image, overlay)]]
      : launched
        ? [...vboxDetachCommand, [commands.VBOXMANAGE, 'modifyvm', session.vmName, '--memory', String(userSettings.memory), '--cpus', String(userSettings.cpus), '--rtcuseutc', userSettings.clock === 'utc' ? 'on' : 'off', ...virtualBoxNetworkArgs(previewSession, image)], ...vboxAttachCommand, [commands.VBOXMANAGE, 'startvm', session.vmName, '--type', 'headless']]
        : virtualBoxCommands(previewSession, image).map(args => [commands.VBOXMANAGE, ...args]);
    const socketLabel = filePath => path.join('runtime', path.relative(runtime, filePath));
    const storage = isQemu
      ? [
          {label: 'Base image (RAW)', path: path.relative(root, imagePath(image.images.raw))},
          {label: 'Working disk (QCOW2 overlay)', path: path.relative(root, overlay)}
        ]
      : [
          {label: 'Base image (VDI)', path: path.relative(root, imagePath(image.images.vdi))},
          {label: 'Working disk (VDI differential)', path: path.relative(root, session.runDisk || tempFile(session, 'disk.vdi'))}
        ];
    storage.push({label: 'Startup disk (cd-rom)', path: attachGuestCdrom ? socketLabel(nextGuestIso) : session.guestIso ? socketLabel(session.guestIso) : 'Not created'});
    res.json({launched, engine, settings: userSettings, fields: launchSettingFields, fixed, storage, interfaces: previewInterfaces.map((nic, index) => ({index: index + 1, switch: nic.switchId === null ? 'Disconnected' : `${sessions.get(nic.switchId)?.hostname || nic.switchId} · port ${nic.port}`, port: nic.port, mac: nic.mac})), console: {guest: 'ttyS0 · 115200 baud', socket: socketLabel(session.socketPath)}, monitor: isQemu ? socketLabel(session.monitorPath) : null, commands: [...isoCommands, ...launchCommands].map(args => args.map(shellQuote).join(' '))});
  } catch (error) { res.status(400).json({error: error.message}); }
});

function spawnVirtualBox(session, image) {
  const vmDir = tempFile(session, 'vbox-vm');
  fs.mkdirSync(vmDir, {recursive: true});
  try {
    const disk = tempFile(session, 'disk.vdi');
    image.runFiles = [disk];
    session.runDisk = disk;
    for (const args of virtualBoxCommands(session, image)) vbox(session, args);
    session.machine = {kind: 'vbox', vmDir};
  } catch (error) {
    try { vbox(session, ['controlvm', session.vmName, 'poweroff']); } catch (_) {}
    try { vbox(session, ['unregistervm', session.vmName]); } catch (_) {}
    for (const file of image.runFiles || []) { try { vbox(session, ['closemedium', 'disk', file, '--delete']); } catch (_) {} }
    cleanupRunFiles(session, image);
    fs.rmSync(vmDir, {recursive: true, force: true});
    throw error;
  }
}

function start(sessionId, selectedEngine, imageId, options = {}) {
  const session = getSession(sessionId);
  if (!session) throw new Error('Unknown host configuration.');
  if (session.kind !== 'vm') throw new Error('This tab is a VDE switch.');
  if (session.action && !options.reset && !(options.resume && session.action === 'reboot')) throw new Error('An action is already in progress for this host.');
  if (session.machine) throw new Error('This host is already running.');
  const resume = session.everStarted && !options.reset;
  if (resume && (selectedEngine !== session.engine || imageId !== session.selectedImage?.id)) throw new Error('Resume must use the original system and engine.');
  if (resume && (!session.runDisk || !fs.existsSync(session.runDisk))) throw new Error('The current host disk was not found.');
  if (!['qemu', 'vbox'].includes(selectedEngine)) throw new Error('Unknown engine.');
  requireSessionEngine(selectedEngine);
  const acceleration = selectedEngine.startsWith('qemu') ? qemuAcceleration(selectedEngine) : null;
  if (selectedEngine === 'vbox') {
    if (!commands.VBOXMANAGE) throw new Error('VirtualBox is unavailable: VBoxManage is not installed on this host.');
    const qemuWithKvm = [...sessions.values()].some(other => other.kind === 'vm' && other.machine && other.engine.startsWith('qemu') && other.qemuAcceleration === 'kvm');
    if (qemuWithKvm) throw new Error('VirtualBox cannot start while a QEMU/KVM host is running. Stop that host first.');
  }
  const image = resume ? session.selectedImage : imageById(imageId);
  if (!image) throw new Error('Unknown system in config.json.');
  if (session.profileHash && session.profileHash !== profileHash(selectedProfile(readConfig(), image.id, selectedEngine))) {
    throw new Error(`System profile changed for ${session.hostname}; restore its original config.json or recreate the host.`);
  }
  if (!fs.existsSync(imagePath(image.images.raw))) throw new Error(`RAW image for ${image.label} is missing; run bash scripts/prepare.sh.`);
  if (selectedEngine === 'vbox' && !fs.existsSync(imagePath(image.images.vdi))) throw new Error(`VirtualBox base for ${image.label} is missing; run bash scripts/prepare.sh.`);
  session.guestMedia = readStartupFiles(startupDirectory(session));
  if (options.startupDiskEnabled !== undefined) {
    if (typeof options.startupDiskEnabled !== 'boolean') throw new Error('Invalid startup CD-ROM option.');
    session.guestIsoAttached = options.startupDiskEnabled;
  }
  const launchSettings = resume
    ? validateLaunchSettings({...session.launchSettings, ...(options.settings || {})})
    : launchSettingsFor(image.id, options.settings || {});
  const qemuOptions = selectedEngine.startsWith('qemu')
    ? resume ? {...session.qemuOptions, memory: launchSettings.memory, smp: launchSettings.cpus, rtcBase: launchSettings.clock} : qemuOptionsFor(image.id, launchSettings)
    : null;
  if (resume || options.reset) {
    for (const nic of session.networkInterfaces) validateNetworkInterfaces([nic.switchId], selectedEngine);
  } else {
    const switches = validateNetworkInterfaces(options.interfaces, selectedEngine);
    const saved = session.networkInterfaces.map(nic => nic.switchId);
    session.networkInterfaces = JSON.stringify(options.interfaces) === JSON.stringify(saved)
      ? session.networkInterfaces : assignNetworkInterfaces(session, switches);
  }
  const displayName = session.hostname || allocateName('h');
  if (fs.existsSync(session.socketPath)) fs.unlinkSync(session.socketPath);
  session.stopping = false;
  session.generation += 1;
  if (!options.reset && !resume) session.runLog = [];
  session.serialBuffer = '';
  session.serialFilterPending = '';
  session.serialFilterPassThrough = false;
  session.lastMessage = 'Starting…';
  if (!options.reset && !resume) io.to(session.id).emit('logs-reset', {sessionId: session.id});
  io.to(session.id).emit('serial-reset', {sessionId: session.id});
  appendLog(session, `${options.reset ? '# Reset from base image' : resume ? '# Resuming from current disk' : '# Starting'} · ${selectedEngine} · ${image.label}`);
  session.engine = selectedEngine;
  session.qemuAcceleration = acceleration;
  session.selectedImage = image;
  setSessionHostname(session, displayName);
  session.qemuOptions = qemuOptions;
  session.launchSettings = launchSettings;
  if (session.guestIsoAttached) buildGuestIso(session, tempFile(session, `startup-${session.generation}.iso`));
  if (selectedEngine === 'vbox' && resume) {
    if (!['poweroff', 'aborted'].includes(virtualBoxState(session))) throw new Error('VirtualBox must be powered off before replacing guest startup media.');
    if (session.activeGuestIso) vbox(session, ['storageattach', session.vmName, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', 'none']);
  }
  if (session.guestIsoAttached) appendLog(session, `# Guest setup ISO attached: ${session.guestIso} (read-only)`);
  if (selectedEngine.startsWith('qemu')) spawnQemu(session, image, resume);
  else if (resume) {
    vbox(session, ['modifyvm', session.vmName, '--memory', String(launchSettings.memory), '--cpus', String(launchSettings.cpus), '--rtcuseutc', launchSettings.clock === 'utc' ? 'on' : 'off', ...virtualBoxNetworkArgs(session, image)]);
    if (session.guestIsoAttached) vbox(session, ['storageattach', session.vmName, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', session.guestIso]);
    vbox(session, ['startvm', session.vmName, '--type', 'headless']);
    session.machine = {kind: 'vbox', vmDir: tempFile(session, 'vbox-vm')};
  } else spawnVirtualBox(session, image);
  session.activeGuestIso = session.guestIsoAttached ? session.guestIso : null;
  for (const file of session.guestIsoFiles) if (file !== session.guestIso && file !== session.activeGuestIso) { fs.rmSync(file, {force: true}); session.guestIsoFiles.delete(file); }
  session.everStarted = true;
  session.activeConfig = activeConfiguration(session);
  publishState(session, selectedEngine === 'qemu' ? `QEMU/${session.qemuAcceleration.toUpperCase()} · ${image.label} starting…` : `VirtualBox · ${image.label} starting…`);
  connectSerial(session);
  return session;
}

function sendMonitorCommand(session, command) {
  return new Promise((resolve, reject) => {
    const monitor = net.createConnection(session.monitorPath);
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

function virtualBoxState(session) {
  const output = execFileSync(commands.VBOXMANAGE, ['showvminfo', session.vmName, '--machinereadable'], {encoding: 'utf8'});
  const match = output.match(/^VMState="([^"]+)"/m);
  return match ? match[1] : 'unknown';
}

async function waitForVirtualBoxPowerOff(session, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = virtualBoxState(session);
    if (state === 'poweroff' || state === 'aborted' || state === 'saved') return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('The host did not respond to the graceful shutdown request.');
}

function validateRestartPrerequisites(session) {
  requireSessionEngine(session.engine);
  if (session.engine.startsWith('qemu')) qemuAcceleration(session.engine);
  else {
    if (!commands.VBOXMANAGE) throw new Error('VirtualBox is unavailable: VBoxManage is not installed on this host.');
    if ([...sessions.values()].some(other => other.id !== session.id && other.machine && other.engine === 'qemu' && other.qemuAcceleration === 'kvm')) {
      throw new Error('VirtualBox cannot start while a QEMU/KVM host is running. Stop that host first.');
    }
  }
  const image = session.selectedImage;
  if (!fs.existsSync(imagePath(image.images.raw))) throw new Error(`RAW image for ${image.label} is missing; run bash scripts/prepare.sh.`);
  if (session.engine === 'vbox' && !fs.existsSync(imagePath(image.images.vdi))) throw new Error(`VirtualBox base for ${image.label} is missing; run bash scripts/prepare.sh.`);
  for (const nic of session.networkInterfaces) validateNetworkInterfaces([nic.switchId], session.engine);
}

async function reboot(session, startup = {}) {
  if (session?.kind === 'switch') throw new Error('Reboot applies only to hosts.');
  if (!session || !session.everStarted) throw new Error('This host has not started yet.');
  if (!session.machine) throw new Error('The host is stopped; use Play to resume from its current disk.');
  if (session.action) throw new Error('An action is already in progress for this host.');
  if (!session.runDisk || !fs.existsSync(session.runDisk)) throw new Error('The current host disk was not found.');
  validateRestartPrerequisites(session);
  session.action = 'reboot';
  try {
    publishState(session, 'Graceful shutdown before reboot…');
    await stop(session, {publish: false});
    if (session.action !== 'reboot' || !sessions.has(session.id)) throw new Error('The session was deleted during reboot.');
    publishState(session, 'Restarting from the current disk…');
    start(session.id, session.engine, session.selectedImage.id, {resume: true, ...startup});
  } catch (error) {
    publishState(session, error.message);
    throw error;
  } finally {
    session.action = null;
    if (session.machine) publishState(session);
  }
}

async function reset(session, settings, startup = {}) {
  if (session?.kind === 'switch') throw new Error('Reset applies only to hosts.');
  if (!session || !session.everStarted || !session.selectedImage) throw new Error('This host has not started yet.');
  if (session.action) throw new Error('An action is already in progress for this host.');
  validateRestartPrerequisites(session);
  const engine = session.engine;
  const imageId = session.selectedImage.id;
  const launchSettings = settings ? validateLaunchSettings({...session.launchSettings, ...settings}) : session.launchSettings;
  session.action = 'reset';
  try {
    publishState(session, 'Resetting from the base image…');
    if (session.machine) await stop(session, {publish: false});
    if (session.action !== 'reset' || !sessions.has(session.id)) throw new Error('The session was deleted during reset.');
    discardSessionDisk(session);
    session.everStarted = false;
    start(session.id, engine, imageId, {reset: true, settings: launchSettings, ...startup});
  } catch (error) {
    session.everStarted = !!session.runDisk;
    publishState(session, error.message);
    throw error;
  } finally {
    session.action = null;
    if (session.machine) publishState(session);
  }
}

function discardSessionDisk(session) {
  const image = session.selectedImage;
  if (session.engine === 'vbox') {
    vbox(session, ['unregistervm', session.vmName]);
    for (const file of image.runFiles || []) {
      try { vbox(session, ['closemedium', 'disk', file, '--delete']); }
      catch (error) { appendLog(session, `# VirtualBox medium already unregistered: ${error.message}`); }
    }
    fs.rmSync(tempFile(session, 'vbox-vm'), {recursive: true, force: true});
  }
  cleanupRunFiles(session, image);
  session.activeGuestIso = null;
  for (const file of session.guestIsoFiles) if (file !== session.guestIso) { fs.rmSync(file, {force: true}); session.guestIsoFiles.delete(file); }
}

async function stop(session, options = {}) {
  if (!session || !session.machine) return;
  const ownAction = !session.action;
  if (ownAction) session.action = 'stop';
  session.stopping = true;
  const current = session.machine;
  try {
    if (current.kind === 'vbox') {
      try {
        vbox(session, ['controlvm', session.vmName, 'acpipowerbutton']);
        await waitForVirtualBoxPowerOff(session, 10000);
      } catch (error) {
        const state = virtualBoxState(session);
        if (!['poweroff', 'aborted', 'saved'].includes(state)) {
          if (options.forceOnTimeout === false) throw new Error(`Host did not power off gracefully: ${error.message}`);
          appendLog(session, `# Graceful VirtualBox shutdown failed: ${error.message}; forcing power off`);
          vbox(session, ['controlvm', session.vmName, 'poweroff']);
        }
      }
    } else {
      try {
        appendLog(session, '$ QEMU monitor: system_powerdown');
        await sendMonitorCommand(session, 'system_powerdown');
        await waitForQemuExit(current, 10000);
      } catch (error) {
        if (options.forceOnTimeout === false) throw new Error(`Host did not power off gracefully: ${error.message}`);
        appendLog(session, `# Graceful QEMU shutdown failed: ${error.message}; sending SIGTERM`);
        current.kill('SIGTERM');
        try { await waitForQemuExit(current, 2000); }
        catch (_) {
          appendLog(session, '$ signal sent to qemu-system-x86_64: SIGKILL');
          current.kill('SIGKILL');
          await waitForQemuExit(current, 5000);
        }
      }
    }
    if (session.serial) { session.serial.destroy(); session.serial = null; }
    if (session.machine === current) session.machine = null;
    session.activeConfig = null;
    try { fs.unlinkSync(session.socketPath); } catch (_) {}
    try { fs.unlinkSync(session.monitorPath); } catch (_) {}
    if (options.publish !== false && session.action !== 'destroy') publishState(session, 'Host stopped; current disk kept');
  } finally {
    session.stopping = false;
    if (ownAction && session.action === 'stop') session.action = null;
  }
}

async function destroySession(session) {
  if (!session) return;
  if (session.kind === 'switch') {
    if (linkedHosts(session.id).length) throw new Error('Remove connected host tabs before deleting this switch.');
    await stopSwitch(session, true);
    removeHostnameAlias(session);
    sessions.delete(session.id);
    fs.rmSync(session.runtimeDir, {recursive: true, force: true});
    saveSessionMetadata();
    return;
  }
  session.action = 'destroy';
  session.stopping = true;
  session.generation += 1;
  if (session.serial) { session.serial.destroy(); session.serial = null; }
  const current = session.machine;
  const image = session.selectedImage || {};
  session.machine = null;
  session.activeConfig = null;
  if (session.engine === 'vbox' && session.everStarted && session.selectedImage) {
    if (current) { try { vbox(session, ['controlvm', session.vmName, 'poweroff']); } catch (_) {} }
    try { vbox(session, ['unregistervm', session.vmName]); } catch (_) {}
    for (const file of image.runFiles || []) {
      try { vbox(session, ['closemedium', 'disk', file, '--delete']); } catch (_) {}
    }
    fs.rmSync(tempFile(session, 'vbox-vm'), {recursive: true, force: true});
  } else if (current) {
    appendLog(session, '$ force kill qemu-system-x86_64: SIGKILL');
    current.kill('SIGKILL');
    try { await waitForQemuExit(current, 5000); } catch (_) {}
  }
  cleanupRunFiles(session, image);
  try { fs.unlinkSync(session.socketPath); } catch (_) {}
  try { fs.unlinkSync(session.monitorPath); } catch (_) {}
  cleanupGuestIsoFiles(session);
  session.runLog = [];
  session.serialBuffer = '';
  session.selectedImage = null;
  session.qemuOptions = null;
  session.everStarted = false;
  removeHostnameAlias(session);
  sessions.delete(session.id);
  fs.rmSync(session.runtimeDir, {recursive: true, force: true});
  saveSessionMetadata();
}

async function exitAllSessions() {
  const removed = [];
  try {
    for (const kind of ['vm', 'switch']) {
      for (const session of [...sessions.values()].filter(item => item.kind === kind)) {
        await destroySession(session);
        removed.push(session.id);
      }
    }
    return removed;
  } finally {
    if (removed.length) io.emit('sessions-removed', {ids: removed});
  }
}

app.post('/api/start', async (req, res) => {
  try {
    const configured = getSession(req.body?.sessionId);
    if (!configured || configured.kind !== 'vm' || !configured.selectedImage) throw new Error('Unknown host configuration.');
    if (req.body.engine !== configured.engine || req.body.imageId !== configured.selectedImage.id) throw new Error('Host system and engine differ from the saved configuration.');
    start(configured.id, configured.engine, configured.selectedImage.id, {
      interfaces: configured.networkInterfaces.map(nic => nic.switchId), settings: configured.launchSettings,
      startupDiskEnabled: configured.guestIsoAttached
    });
    res.json({ok: true, sessionId: configured.id, name: configured.hostname});
  } catch (error) {
    const message = error.stderr ? error.stderr.toString().trim() : error.message;
    console.error(message);
    try {
      const session = getSession(req.body.sessionId);
      if (session) publishState(session, message.startsWith('Start failed:') ? message : `Start failed: ${message}`);
    } catch (_) {}
    res.status(500).json({error: message});
  }
});

function validateTopologyRequest(body) {
  const {text, engine = sessionEngine} = body || {};
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
    const used = new Set(closePrevious ? [] : [...sessions.values()].map(session => session.hostname?.toLowerCase()));
    for (const entry of [...topology.switches, ...topology.hosts]) if (used.has(entry.name.toLowerCase())) throw new Error(`Name already exists: ${entry.name}.`);
    if (closePrevious) await exitAllSessions();
    const switchIds = new Map();
    for (const sw of topology.switches) {
      const id = newEntityId('switch');
      const session = getSession(id, true, 'switch'); created.push(id);
      setSessionHostname(session, sw.name); session.lastMessage = 'VDE switch ready to start';
      persistSwitchConfiguration(session);
      switchIds.set(sw.name, id);
    }
    for (const host of topology.hosts) {
      const id = newEntityId('vm');
      const interfaces = assignNetworkInterfaces({id}, validateNetworkInterfaces(host.switches.map(name => switchIds.get(name)), engine, false));
      const session = getSession(id, true, 'vm'); created.push(id);
      setSessionHostname(session, host.name); session.selectedImage = imageById(host.system); session.engine = engine;
      session.networkInterfaces = interfaces; session.launchSettings = launchSettingsFor(host.system);
      session.guestIsoAttached = session.selectedImage.startupDiskEnabled;
      writeStartupScript(startupDirectory(session), defaultStartupScript(interfaces));
      session.guestMedia = readStartupFiles(startupDirectory(session));
      session.lastMessage = 'Host ready to start';
      persistHostConfiguration(session);
    }
    saveSessionMetadata();
    const errors = [];
    if (autostart) {
      for (const id of created) {
        const session = sessions.get(id);
        try {
          if (session.kind === 'switch') await startSwitch(session);
          else start(id, engine, session.selectedImage.id, {interfaces: session.networkInterfaces.map(nic => nic.switchId)});
        } catch (error) {
          session.lastMessage = `Start failed: ${error.message}`;
          errors.push(`${session.hostname}: ${error.message}`);
          publishState(session, session.lastMessage);
        }
      }
    }
    if (created.length) io.emit('sessions-changed', {sessionId: null});
    res.json({created: created.length, errors});
  } catch (error) {
    for (const id of created.reverse()) {
      const session = sessions.get(id);
      if (session) {
        try { await destroySession(session); }
        catch (cleanupError) { console.error('Topology rollback:', cleanupError); }
      }
    }
    res.status(400).json({error: error.message});
  }
});

app.get('/api/topology', (_req, res) => {
  try {
    const all = [...sessions.values()];
    const switches = all.filter(session => session.kind === 'switch').map(session => ({name: session.hostname}));
    const hosts = all.filter(session => session.kind === 'vm').map(session => ({
      name: session.hostname, system: session.selectedImage?.id,
      switches: session.networkInterfaces.map(nic => {
        const sw = nic.switchId && sessions.get(nic.switchId);
        if (!sw || sw.kind !== 'switch') throw new Error(`Host ${session.hostname} has a disconnected interface; .topo cannot represent it.`);
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
    const {id, name, imageId, engine = sessionEngine, interfaces, settings, guestMedia, startupDiskEnabled} = req.body || {};
    entityKind(id, 'vm');
    if (sessions.has(id)) throw new Error('Host ID already exists.');
    const image = imageById(imageId || Object.keys(readConfig().systems).find(id => id !== 'default'));
    if (!image) throw new Error('Unknown system in config.json.');
    if (!['qemu', 'vbox'].includes(engine)) throw new Error('Unknown engine.');
    requireSessionEngine(engine);
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(name))) throw new Error('Invalid host name (1 to 64 characters).');
    const hostname = name === undefined ? allocateName('h') : name.trim();
    if ([...sessions.values()].some(other => other.hostname === hostname)) throw new Error('Host name already exists.');
    const networkInterfaces = assignNetworkInterfaces({id}, validateNetworkInterfaces(interfaces, engine, false));
    const launchSettings = launchSettingsFor(image.id, settings || {});
    const validatedMedia = guestMedia === undefined ? {script: defaultStartupScript(networkInterfaces), resources: []} : validateBootFiles(guestMedia);
    if (startupDiskEnabled !== undefined && typeof startupDiskEnabled !== 'boolean') throw new Error('Invalid startup disk option.');
    const buildStartupDisk = startupDiskEnabled ?? image.startupDiskEnabled;
    if (buildStartupDisk) {
      validateStartupTemplate(validatedMedia.script, networkInterfaces, true);
    }
    const session = getSession(id, true, 'vm');
    session.selectedImage = image;
    session.engine = engine;
    session.networkInterfaces = networkInterfaces;
    session.launchSettings = launchSettings;
    try {
      writeStartupFiles(startupDirectory(session), validatedMedia);
      session.guestMedia = readStartupFiles(startupDirectory(session));
      setSessionHostname(session, hostname);
      session.guestIsoAttached = buildStartupDisk;
      persistHostConfiguration(session);
      saveSessionMetadata();
    } catch (error) {
      cleanupGuestIsoFiles(session);
      removeHostnameAlias(session);
      sessions.delete(id);
      fs.rmSync(session.runtimeDir, {recursive: true, force: true});
      throw error;
    }
    session.lastMessage = 'Host ready to start';
    io.emit('sessions-changed', {sessionId: id, running: false, hasLaunched: false, message: session.lastMessage});
    res.json({...hostConfigurationResponse(session), imageId: image.id});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.get('/api/hosts/:sessionId/config', (req, res) => {
  try {
    const session = getSession(req.params.sessionId);
    if (!session || session.kind !== 'vm' || !session.selectedImage) throw new Error('Unknown host.');
    res.set('Cache-Control', 'no-store');
    res.json(hostConfigurationResponse(session));
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.put('/api/hosts/:sessionId/config', (req, res) => {
  try {
    const session = getSession(req.params.sessionId);
    if (!session || session.kind !== 'vm' || !session.selectedImage) throw new Error('Unknown host.');
    if (session.action) throw new Error('Wait for the current host action to finish.');
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid host configuration.');
    const required = ['name', 'systemId', 'engine', 'settings', 'interfaces', 'guestMedia', 'startupDiskEnabled'];
    if (Object.keys(body).some(key => !required.includes(key)) || required.some(key => !Object.hasOwn(body, key))) throw new Error('Incomplete host configuration.');
    if (body.systemId !== session.selectedImage.id || body.engine !== session.engine) throw new Error('System and engine are read-only for an existing host.');
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(body.name)) throw new Error('Invalid host name (1 to 64 characters).');
    const name = body.name.trim();
    if ([...sessions.values()].some(other => other.id !== session.id && other.hostname === name)) throw new Error('Host name already exists.');
    const settings = validateLaunchSettings(body.settings);
    const media = validateBootFiles(body.guestMedia);
    const script = normalizeScript(media.script);
    if (typeof body.startupDiskEnabled !== 'boolean') throw new Error('Invalid startup CD-ROM option.');
    const switches = validateNetworkInterfaces(body.interfaces, session.engine, false);
    const oldSwitches = session.networkInterfaces.map(nic => nic.switchId);
    const interfaces = JSON.stringify(body.interfaces) === JSON.stringify(oldSwitches)
      ? session.networkInterfaces : assignNetworkInterfaces(session, switches);
    if (body.startupDiskEnabled) validateStartupTemplate(script, interfaces, true);
    const previousName = session.hostname;
    const previousMedia = readStartupFiles(startupDirectory(session));
    const nextMedia = validateBootFiles({script, resources: media.resources});
    const mediaChanged = JSON.stringify(nextMedia) !== JSON.stringify(previousMedia);
    let mediaWritten = false;
    if (name !== previousName) setSessionHostname(session, name);
    try {
      if (mediaChanged) {
        writeStartupFiles(startupDirectory(session), nextMedia);
        mediaWritten = true;
      }
      writeJsonAtomic(tempFile(session, 'host.json'),
        hostConfiguration(session, settings, interfaces, body.startupDiskEnabled, name));
    } catch (error) {
      if (mediaWritten) writeStartupFiles(startupDirectory(session), previousMedia);
      if (name !== previousName) setSessionHostname(session, previousName);
      throw error;
    }
    session.launchSettings = settings;
    session.networkInterfaces = interfaces;
    session.guestMedia = readStartupFiles(startupDirectory(session));
    session.guestIsoAttached = body.startupDiskEnabled;
    if (mediaChanged || name !== previousName) session.guestIsoOutdated = !!session.guestIso;
    if (name !== previousName) io.emit('session-renamed', {sessionId: session.id, name});
    io.emit('sessions-changed', {sessionId: session.id, running: !!session.machine, hasLaunched: session.everStarted, pendingRestart: pendingRestart(session), message: stateMessage(session)});
    res.json(hostConfigurationResponse(session));
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.get('/api/hosts/:sessionId/guest-media', (req, res) => {
  try {
    const session = getSession(req.params.sessionId);
    if (!session || session.kind !== 'vm') throw new Error('Unknown host.');
    res.json({...readStartupFiles(startupDirectory(session)), guestCdrom: guestIsoStatus(session)});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.put('/api/hosts/:sessionId/guest-media', (req, res) => {
  try {
    const session = getSession(req.params.sessionId);
    if (!session || session.kind !== 'vm') throw new Error('Unknown host.');
    const media = validateBootFiles(req.body);
    if (session.guestIsoAttached) validateStartupTemplate(media.script, session.networkInterfaces, true);
    writeStartupFiles(startupDirectory(session), media);
    session.guestMedia = readStartupFiles(startupDirectory(session));
    session.guestIsoOutdated = !!session.guestIso;
    appendLog(session, '# Guest startup files saved; create the CD-ROM to include these changes.');
    res.json({ok: true, files: session.guestMedia.resources.length, guestCdrom: guestIsoStatus(session)});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.post('/api/hosts/:sessionId/guest-cdrom', (req, res) => {
  try {
    const session = getSession(req.params.sessionId);
    if (!session || session.kind !== 'vm') throw new Error('Unknown host.');
    const media = validateBootFiles(req.body);
    validateStartupTemplate(media.script, session.networkInterfaces, true);
    writeStartupFiles(startupDirectory(session), media);
    session.guestMedia = readStartupFiles(startupDirectory(session));
    const status = buildGuestIso(session);
    res.json({ok: true, guestCdrom: status});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.patch('/api/hosts/:sessionId/guest-cdrom', (req, res) => {
  try {
    const session = getSession(req.params.sessionId);
    if (!session || session.kind !== 'vm') throw new Error('Unknown host.');
    if (typeof req.body?.attached !== 'boolean') throw new Error('Invalid CD-ROM attachment option.');
    if (req.body.attached && !guestIsoStatus(session).created) throw new Error('Create the CD-ROM before attaching it.');
    const previous = session.guestIsoAttached;
    session.guestIsoAttached = req.body.attached;
    try { persistHostConfiguration(session); }
    catch (error) { session.guestIsoAttached = previous; throw error; }
    res.json({ok: true, guestCdrom: guestIsoStatus(session)});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.post('/api/switches', async (req, res) => {
  let session;
  try {
    const {id, name, autostart = true} = req.body || {};
    if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(name)) throw new Error('Switch name must be 1–32 letters, digits, underscores or hyphens.');
    entityKind(id, 'switch');
    if (sessions.has(id) || [...sessions.values()].some(s => s.kind === 'switch' && s.hostname === name)) throw new Error('Switch ID or name already exists.');
    session = getSession(id, true, 'switch');
    setSessionHostname(session, name);
    session.lastMessage = 'VDE switch ready to start';
    persistSwitchConfiguration(session);
    saveSessionMetadata();
    if (autostart) await startSwitch(session);
    io.emit('sessions-changed', {sessionId: id, running: !!session.machine, hasLaunched: session.everStarted, message: stateMessage(session)});
    res.json({id, name, running: !!session.machine, message: stateMessage(session)});
  } catch (error) {
    if (session) {
      try { await destroySession(session); }
      catch (cleanupError) { console.error('Cannot clean up failed switch:', cleanupError); }
    }
    res.status(session ? 500 : 400).json({error: error.message});
  }
});

app.post('/api/switches/:id/start', async (req, res) => {
  try {
    const session = getSession(req.params.id);
    if (!session || session.kind !== 'switch') throw new Error('Unknown switch.');
    await startSwitch(session);
    res.json({ok: true});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.post('/api/switches/:id/stop', async (req, res) => {
  try {
    const session = getSession(req.params.id);
    if (!session || session.kind !== 'switch') throw new Error('Unknown switch.');
    await stopSwitch(session);
    res.json({ok: true});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.post('/api/stop/:sessionId', async (req, res) => {
  try {
    const session = getSession(req.params.sessionId);
    if (session && session.kind !== 'vm') throw new Error('Use the switch stop action.');
    if (session && session.action) throw new Error('An action is already in progress for this host.');
    await stop(session);
    res.json({ok: true});
  }
  catch (error) {
    console.error(error);
    try { const session = getSession(req.params.sessionId); if (session) publishState(session, error.message); } catch (_) {}
    res.status(500).json({error: error.message});
  }
});

app.post('/api/reboot/:sessionId', async (req, res) => {
  try { await reboot(getSession(req.params.sessionId)); res.json({ok: true}); }
  catch (error) { res.status(500).json({error: error.message}); }
});

app.post('/api/reset/:sessionId', async (req, res) => {
  try { await reset(getSession(req.params.sessionId)); res.json({ok: true}); }
  catch (error) { res.status(500).json({error: error.message}); }
});

app.post('/api/monitor/:sessionId', async (req, res) => {
  try {
    const session = getSession(req.params.sessionId);
    if (!session || session.kind !== 'vm' || !session.machine || !session.engine.startsWith('qemu') || session.action) throw new Error('Monitor is available only for a running QEMU host.');
    const command = req.body && req.body.command;
    if (typeof command !== 'string' || !command.trim() || command.length > 256 || /[\r\n\x00-\x1f\x7f]/.test(command)) throw new Error('Enter a single-line QEMU command (maximum 256 characters).');
    appendLog(session, `$ monitor: ${command}`);
    const output = await sendMonitorCommand(session, command);
    appendLog(session, output || '(no output)');
    res.json({ok: true, output});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.patch('/api/sessions/:sessionId', (req, res) => {
  try {
    const session = getSession(req.params.sessionId);
    const name = req.body && req.body.name;
    if (!session || session.kind !== 'vm') throw new Error('Unknown host.');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid name (1 to 64 characters).');
    if ([...sessions.values()].some(other => other.id !== session.id && other.hostname === name.trim())) throw new Error('Host name already exists.');
    const previous = session.hostname;
    setSessionHostname(session, name.trim());
    try { persistHostConfiguration(session); }
    catch (error) { setSessionHostname(session, previous); throw error; }
    io.emit('session-renamed', {sessionId: session.id, name: session.hostname});
    res.json({name: session.hostname});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.delete('/api/sessions', async (_req, res) => {
  try { res.json({removed: await exitAllSessions()}); }
  catch (error) { res.status(500).json({error: error.message}); }
});

app.delete('/api/sessions/:sessionId', async (req, res) => {
  try {
    const session = getSession(req.params.sessionId);
    await destroySession(session);
    io.emit('sessions-removed', {ids: [req.params.sessionId]});
    res.json({ok: true});
  } catch (error) { res.status(500).json({error: error.message}); }
});

io.on('connection', socket => {
  let selectionQueue = Promise.resolve();
  socket.on('select-session', (id, token, acknowledge) => {
    selectionQueue = selectionQueue.then(async () => {
      const session = getSession(id);
      if (!session) throw new Error('Unknown session.');
      if (socket.sessionId && socket.sessionId !== id) {
        await socket.leave(socket.sessionId);
      }
      await socket.join(id);
      socket.sessionId = session.id;
      socket.emit('session-snapshot', {
        sessionId: session.id,
        token,
        state: {running: !!session.machine, message: stateMessage(session), hasLaunched: session.everStarted},
        logs: session.runLog,
        serial: session.serialBuffer
      });
      if (typeof acknowledge === 'function') acknowledge({ok: true});
    }).catch(error => {
      socket.emit('session-error', error.message);
      if (typeof acknowledge === 'function') acknowledge({error: error.message});
    });
  });
  socket.on('leave-session', id => {
    if (id !== socket.sessionId) return;
    socket.leave(id);
    socket.sessionId = null;
  });
  socket.on('input', data => {
    const session = socket.sessionId && sessions.get(socket.sessionId);
    if (!session || typeof data !== 'string' || data.length > 4096) return;
    if (session.kind === 'switch' && session.switchTerminal) session.switchTerminal.write(data);
    else if (session.serial) session.serial.write(data);
  });
  socket.on('terminal-resize', request => {
    if (!request || request.id !== socket.sessionId) return;
    const session = sessions.get(request.id);
    if (!session || session.kind !== 'switch' || !session.switchTerminal) return;
    const cols = Number(request.cols);
    const rows = Number(request.rows);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) return;
    try { session.switchTerminal.resize(cols, rows); } catch (_) {}
  });
  socket.on('clear-console', request => {
    if (!request || request.id !== socket.sessionId) return;
    const session = sessions.get(request.id);
    if (!session) return;
    const line = typeof request.line === 'string' ? request.line.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 1024) : '';
    const column = Number.isInteger(request.column) ? Math.max(0, Math.min(request.column, 1024)) : line.length;
    session.serialBuffer = line ? `${line}\x1b[${column + 1}G` : '';
    io.to(request.id).emit('serial-reset', {sessionId: request.id, preserveLine: true, serial: session.serialBuffer});
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
  fs.mkdirSync(runtimeInstance, {recursive: true});
  saveSessionMetadata();
  fs.writeFileSync(serverPidFile, `${process.pid}\n`, {mode: 0o600});
  fs.writeFileSync(serverSessionFile, `${sessionId}\n${ephemeralServer ? 'test' : 'regular'}\n`, {mode: 0o600});
  linkCurrentSession();
  console.log('\nQemuWeb is ready.');
  console.log(`  Web interface      http://127.0.0.1:${port}`);
  console.log(`  Session ID         ${sessionId}`);
  console.log(`  Session directory  ${runtimeInstance}`);
  console.log('  Stop               Ctrl+C or ./scripts/stop.sh\n');
});

process.on('exit', () => {
  removeCurrentSessionLink();
  try {
    if (fs.readFileSync(serverPidFile, 'utf8').trim() === String(process.pid)) fs.rmSync(serverPidFile, {force: true});
  } catch (_) {}
  try {
    if (fs.readFileSync(serverSessionFile, 'utf8').startsWith(`${sessionId}\n`)) fs.rmSync(serverSessionFile, {force: true});
  } catch (_) {}
  removeEmptyRuntimeSession();
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(resourceTimer);
  const forceExit = setTimeout(() => process.exit(1), 10000);
  for (const kind of ['vm', 'switch']) {
    await Promise.all([...sessions.values()].filter(session => session.kind === kind)
      .map(session => destroySession(session).catch(error => console.error('Session shutdown:', error))));
  }
  io.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
