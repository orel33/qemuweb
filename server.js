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
const socketIo = require('socket.io');
const pty = require('node-pty');
const {resolveCommands} = require('./command-preflight');
const {parseHostCpu, parseProcessCpu, parseProcessRss, processCpuPercent, parseVBoxMetrics} = require('./resource-metrics');
const {parseTopology, formatTopology} = require('./topology');
const packageInfo = require('./package.json');

const root = __dirname;
let commands;
console.log(`QemuWeb ${packageInfo.version}\n`);
try { commands = resolveCommands(root); }
catch (error) { console.error(error.message); process.exit(1); }
const runtime = path.join(root, 'runtime');
const configPath = path.join(root, 'config.json');
const qemuFields = ['machine', 'cpuKvm', 'cpuTcg', 'memory', 'smp', 'display', 'rtcBase', 'diskInterface', 'networkModel', 'bootDisk', 'nic'];
const port = Number(process.env.PORT || 3002);
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const sessions = new Map();
const execFileAsync = promisify(execFile);
const resourceSamples = new Map();
const previousProcessSamples = new Map();
const vboxMetricSetup = new Map();
let samplingResources = false;
fs.mkdirSync(runtime, {recursive: true});

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
    const hostCpu = qemuRunning ? parseHostCpu(await fs.promises.readFile('/proc/stat', 'utf8').catch(() => '')) : null;
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
        result = resourceResult(cpuPercent, ramBytes);
      } else if (session.engine === 'virtualbox') {
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

function getSession(id, create = false, kind = 'vm') {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(id)) throw new Error('Invalid session ID.');
  if (!sessions.has(id) && create) {
    sessions.set(id, {
      id,
      kind,
      vmName: `qemuweb-${process.pid}-${id}`,
      socketPath: path.join(runtime, `qemuweb-${process.pid}-${id}.sock`),
      monitorPath: path.join(runtime, `qemuweb-${process.pid}-${id}.monitor.sock`),
      machine: null,
      serial: null,
      engine: null,
      qemuAcceleration: null,
      qemuOptions: null,
      launchSettings: null,
      selectedImage: null,
      hostname: null,
      everStarted: false,
      stopping: false,
      action: null,
      runLog: [],
      serialBuffer: '',
      generation: 0,
      runDisk: null,
      networkInterfaces: [],
      socketDir: kind === 'switch' ? path.join(runtime, `qemuweb-${process.pid}-${id}-vde`) : null,
      mgmtPath: kind === 'switch' ? path.join(runtime, `qemuweb-${process.pid}-${id}.mgmt`) : null,
      mgmtAliasPath: null,
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
  const state = {sessionId: session.id, running: !!session.machine, hasLaunched: session.everStarted, message};
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

function execLogged(session, command, args, options = {stdio: 'pipe'}) {
  appendLog(session, `$ ${[command, ...args].map(shellQuote).join(' ')}`);
  return execFileSync(command, args, options);
}

app.use(express.json());
app.use('/vendor', express.static(path.join(root, 'node_modules/xterm')));
app.use('/vendor-addon-fit', express.static(path.join(root, 'node_modules/xterm-addon-fit')));
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(root, 'public')));

function imageById(id) {
  const system = readConfig().systems[id];
  return system ? {id, ...system} : null;
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
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (error) { throw new Error(`Cannot read config.json: ${error.message}`); }
  if (!config || !config.qemu || !config.systems || typeof config.systems !== 'object' || Array.isArray(config.systems)) throw new Error('Invalid config.json structure.');
  validateQemuOptions(config.qemu.defaults, true);
  if (!config.settings || !config.settings.defaults || !config.settings.fields) throw new Error('Missing generic settings in config.json.');
  validateLaunchSettings(config.settings.defaults);
  if (config.qemu.defaults.nic !== 'none') throw new Error('External QEMU networking is disabled; qemu.defaults.nic must be none.');
  for (const [id, system] of Object.entries(config.systems)) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || !system || system.type !== 'linux' || system.mode !== 'text') throw new Error(`Invalid system ${id}: only Linux text-mode profiles are supported.`);
    for (const key of ['label', 'description', 'login']) {
      if (typeof system[key] !== 'string' || !system[key].trim()) throw new Error(`Missing ${key} for ${id}.`);
    }
    for (const format of ['raw', 'vdi']) {
      if (!system.images || typeof system.images[format] !== 'string' || !system.images[format] || /[\x00-\x1f\x7f]/.test(system.images[format])) throw new Error(`Invalid ${format} path for ${id}.`);
    }
    validateQemuOptions(system.qemu, true);
    validateLaunchSettings(system.settings || {}, true);
    if (system.qemu.nic && system.qemu.nic !== 'none') throw new Error(`External QEMU networking is disabled for ${id}.`);
    const vbox = system.virtualbox;
    if (!vbox || typeof vbox.nic !== 'string' || !vbox.nic || typeof vbox.osType !== 'string' || !vbox.osType) throw new Error(`Invalid VirtualBox settings for ${id}.`);
    if (vbox.nic !== 'none') throw new Error(`External VirtualBox networking is disabled for ${id}.`);
  }
  return config;
}

function qemuOptionsFor(imageId, overrides = {}) {
  const config = readConfig();
  const system = config.systems[imageId];
  const settings = validateLaunchSettings({...config.settings.defaults, ...(system?.settings || {}), ...overrides});
  return validateQemuOptions({...config.qemu.defaults, ...(system?.qemu || {}), memory: settings.memory, smp: settings.cpus, rtcBase: settings.clock});
}

function launchSettingsFor(imageId, overrides = {}) {
  const config = readConfig();
  const system = config.systems[imageId];
  return validateLaunchSettings({...config.settings.defaults, ...(system?.settings || {}), ...overrides});
}

app.get('/api/qemu-config', (_req, res) => {
  try {
    const config = readConfig();
    res.json({settings: config.settings, systems: Object.fromEntries(Object.entries(config.systems).map(([id, system]) => [id, {qemu: system.qemu, virtualbox: system.virtualbox, settings: system.settings || {}}]))});
  }
  catch (error) { res.status(500).json({error: error.message}); }
});

app.get('/api/systems', (_req, res) => {
  try {
    const config = readConfig();
    res.json(Object.entries(config.systems).map(([id, system]) => ({id, label: system.label, description: system.description, login: system.login, images: system.images, vboxNic: system.virtualbox.nic, hasDifferentialDisk: true})));
  } catch (error) { res.status(500).json({error: error.message}); }
});

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
    hasDifferentialDisk: !!session.runDisk && fs.existsSync(session.runDisk),
    message: stateMessage(session)
  })));
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
    const publishSerial = text => {
      if (!text) return;
      session.serialBuffer = (session.serialBuffer + text).slice(-262144);
      io.to(session.id).emit('serial', {sessionId: session.id, data: text});
    };
    session.serial = connection;
    publishState(session);
    connection.on('data', data => publishSerial(decoder.write(data)));
    connection.on('close', () => {
      publishSerial(decoder.end());
      if (session.serial === connection) session.serial = null;
      if (!session.stopping && session.action !== 'reboot' && session.machine) publishState(session, 'Serial console disconnected');
    });
    connection.on('error', error => console.error('serial:', error.message));
  });
  connection.once('error', () => setTimeout(() => connectSerial(session, attempt + 1, generation), 250));
}

function tempFile(session, name) {
  return path.join(runtime, `qemuweb-${process.pid}-${session.id}-${name}`);
}

function imagePath(file) { return path.resolve(root, file); }

function qemuArgs(session, image, overlay) {
  const settings = session.qemuOptions;
  const common = [
    '-machine', settings.machine, '-accel', session.qemuAcceleration,
    '-cpu', session.qemuAcceleration === 'kvm' ? settings.cpuKvm : settings.cpuTcg,
    '-m', String(settings.memory), '-smp', String(settings.smp),
    '-display', settings.display, '-rtc', `base=${settings.rtcBase}`, '-monitor', `unix:${session.monitorPath},server=on,wait=off`,
    '-serial', `unix:${session.socketPath},server=on,wait=off`
  ];
  // QEMU PC boot notation: c = first hard disk.
  const args = [...common, '-drive', `file=${overlay},if=${settings.diskInterface},format=qcow2,media=disk`, '-boot', `order=${settings.bootDisk}`];
  // Disable QEMU's implicit user-network NIC; explicit -device NICs below remain enabled.
  args.push('-nic', 'none');
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
  if (value === undefined) value = engine.startsWith('qemu') ? [null] : [];
  if (!Array.isArray(value) || value.length > 4 || (value.length && !engine.startsWith('qemu'))) throw new Error('Ethernet interfaces require QEMU (maximum four).');
  return value.map((switchId, index) => {
    if (switchId === null) return null;
    const sw = getSession(switchId);
    if (!sw || sw.kind !== 'switch' || (requireRunning && !sw.machine)) throw new Error(`Interface ${index + 1}: start its VDE switch first.`);
    return sw;
  });
}

function assignNetworkInterfaces(session, switches) {
  const planned = [];
  const usedMacs = new Set([...sessions.values()]
    .filter(other => other.id !== session.id)
    .flatMap(other => other.networkInterfaces || [])
    .map(nic => nic.mac));
  for (const [index, sw] of switches.entries()) {
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
    const used = new Set([...sessions.values()].filter(other => other.id !== session.id).flatMap(other => other.networkInterfaces || [])
      .filter(nic => nic.switchId === sw.id).map(nic => nic.port));
    for (const nic of planned) if (nic.switchId === sw.id) used.add(nic.port);
    const port = Array.from({length: 32}, (_, n) => n + 1).find(n => !used.has(n));
    if (!port) throw new Error(`No free port on ${sw.hostname}.`);
    planned.push({switchId: sw.id, port, mac});
  }
  return planned;
}

function linkedHosts(switchId) {
  return [...sessions.values()].filter(session => session.kind === 'vm' &&
    session.networkInterfaces.some(nic => nic.switchId === switchId));
}

function removeSwitchTerminalAlias(session) {
  const aliasPath = session.mgmtAliasPath;
  session.mgmtAliasPath = null;
  if (!aliasPath) return;
  try { fs.unlinkSync(aliasPath); } catch (_) {}
  try { fs.rmdirSync(path.dirname(aliasPath)); } catch (_) {}
}

function stopSwitchTerminal(session) {
  const terminal = session.switchTerminal;
  session.switchTerminal = null;
  if (terminal) {
    try { terminal.kill('SIGTERM'); } catch (_) {}
  }
  removeSwitchTerminalAlias(session);
}

function startSwitchTerminal(session) {
  stopSwitchTerminal(session);
  session.serialBuffer = '';
  io.to(session.id).emit('serial-reset', {sessionId: session.id, serial: ''});
  const aliasDir = path.join(runtime, `qemuweb-${process.pid}-vdeterm`);
  const aliasName = session.hostname;
  const aliasPath = path.join(aliasDir, aliasName);
  fs.mkdirSync(aliasDir, {recursive: true});
  try { fs.unlinkSync(aliasPath); } catch (_) {}
  fs.symlinkSync(session.mgmtPath, aliasPath);
  session.mgmtAliasPath = aliasPath;
  appendLog(session, `$ ${[commands.VDETERM, aliasName].map(shellQuote).join(' ')}  # cwd=${shellQuote(aliasDir)}`);
  let terminal;
  try {
    terminal = pty.spawn(commands.VDETERM, [aliasName], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: aliasDir,
      env: {...process.env, TERM: 'xterm-256color'}
    });
  } catch (error) {
    removeSwitchTerminalAlias(session);
    throw error;
  }
  session.switchTerminal = terminal;
  terminal.onData(data => {
    session.serialBuffer = (session.serialBuffer + data).slice(-262144);
    io.to(session.id).emit('serial', {sessionId: session.id, data});
  });
  terminal.onExit(({exitCode}) => {
    if (session.switchTerminal !== terminal) return;
    session.switchTerminal = null;
    removeSwitchTerminalAlias(session);
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
  if (engine === 'qemu-tcg') return 'tcg';
  if (engine !== 'qemu') throw new Error('Unknown QEMU acceleration mode.');
  if (!checkAvailability) return 'kvm';
  const virtualBoxRunning = [...sessions.values()].some(other => other.machine && other.engine === 'virtualbox');
  if (virtualBoxRunning) throw new Error('QEMU/KVM cannot start while a VirtualBox host is running. Stop that host or select QEMU · TCG.');
  try { fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK); }
  catch (_) { throw new Error('QEMU/KVM is unavailable: /dev/kvm is missing or not accessible. Choose QEMU · TCG or enable KVM.'); }
  return 'kvm';
}

function qemuOverlayArgs(image, overlay) {
  return ['create', '-f', 'qcow2', '-F', 'raw', '-b', imagePath(image.images.raw), overlay];
}

function spawnQemu(session, image, reuseDisk = false) {
  const overlay = reuseDisk ? session.runDisk : tempFile(session, `${image.id}-overlay.qcow2`);
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
      session.everStarted = !!session.runDisk;
      try { fs.unlinkSync(session.socketPath); } catch (_) {}
      try { fs.unlinkSync(session.monitorPath); } catch (_) {}
      publishState(session, `QEMU error: ${error.message}`);
    }
  });
  child.once('exit', code => {
    try { fs.unlinkSync(session.socketPath); } catch (_) {}
    try { fs.unlinkSync(session.monitorPath); } catch (_) {}
    if (session.machine === child) session.machine = null;
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

function virtualBoxCommands(session, image) {
  const vmDir = tempFile(session, 'vbox-vm');
  const disk = tempFile(session, `${image.id}.vdi`);
  return [
    ['createvm', '--name', session.vmName, '--basefolder', vmDir, '--ostype', image.virtualbox.osType, '--register'],
    ['modifyvm', session.vmName, '--memory', String(session.launchSettings.memory), '--cpus', String(session.launchSettings.cpus), '--rtcuseutc', session.launchSettings.clock === 'utc' ? 'on' : 'off', '--nic1', image.virtualbox.nic, '--uart1', '0x3F8', '4', '--uartmode1', 'server', session.socketPath],
    ['createmedium', 'disk', '--filename', disk, '--diffparent', imagePath(image.images.vdi), '--format', 'VDI'],
    ['storagectl', session.vmName, '--name', 'SATA', '--add', 'sata', '--controller', 'IntelAhci'],
    ['storageattach', session.vmName, '--storagectl', 'SATA', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', disk],
    ['modifyvm', session.vmName, '--boot1', 'disk', '--boot2', 'dvd', '--boot3', 'none', '--boot4', 'none'],
    ['startvm', session.vmName, '--type', 'headless']
  ];
}

app.get('/api/options/:sessionId', (req, res) => {
  try {
    const id = req.params.sessionId;
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) throw new Error('Invalid session ID.');
    const existing = getSession(id);
    const launched = !!(existing && existing.everStarted && existing.selectedImage);
    const image = launched ? existing.selectedImage : imageById(req.query.system);
    const engine = launched ? existing.engine : req.query.engine;
    if (!image || !['qemu', 'qemu-tcg', 'virtualbox'].includes(engine)) throw new Error('Unknown system or engine.');
    const session = launched ? existing : {
      id, vmName: `qemuweb-${process.pid}-${id}`,
      socketPath: path.join(runtime, `qemuweb-${process.pid}-${id}.sock`),
      monitorPath: path.join(runtime, `qemuweb-${process.pid}-${id}.monitor.sock`),
      engine, qemuAcceleration: engine.startsWith('qemu') ? qemuAcceleration(engine, false) : null,
      launchSettings: launchSettingsFor(image.id, req.query.settings ? JSON.parse(req.query.settings) : {}),
      qemuOptions: null,
      networkInterfaces: assignNetworkInterfaces({id}, validateNetworkInterfaces(req.query.interfaces !== undefined ? JSON.parse(req.query.interfaces) : req.query.switches ? String(req.query.switches).split(',') : undefined, engine, false))
    };
    const isQemu = engine.startsWith('qemu');
    const draftSettings = req.query.settings ? JSON.parse(req.query.settings) : {};
    const userSettings = launched
      ? existing.machine || existing.action ? session.launchSettings : validateLaunchSettings({...session.launchSettings, ...draftSettings})
      : launchSettingsFor(image.id, draftSettings);
    const options = isQemu
      ? launched ? {...session.qemuOptions, memory: userSettings.memory, smp: userSettings.cpus, rtcBase: userSettings.clock} : qemuOptionsFor(image.id, userSettings)
      : null;
    if (!launched && isQemu) session.qemuOptions = options;
    const previewSession = {...session, launchSettings: userSettings, qemuOptions: options};
    const overlay = launched && session.runDisk ? session.runDisk : tempFile(session, `${image.id}-overlay.qcow2`);
    const fixed = isQemu
      ? {engine: `QEMU · ${session.qemuAcceleration.toUpperCase()}`, machine: options.machine, diskBus: options.diskInterface, networkCard: options.networkModel}
      : {engine: 'VirtualBox', osType: image.virtualbox.osType, diskBus: 'SATA', networkCard: image.virtualbox.nic};
    const launchCommands = isQemu
      ? [...(launched ? [] : [[commands.QEMU_IMG, ...qemuOverlayArgs(image, overlay)]]), [commands.QEMU_SYSTEM_X86_64, ...qemuArgs(previewSession, image, overlay)]]
      : launched
        ? [[commands.VBOXMANAGE, 'modifyvm', session.vmName, '--memory', String(userSettings.memory), '--cpus', String(userSettings.cpus), '--rtcuseutc', userSettings.clock === 'utc' ? 'on' : 'off'], [commands.VBOXMANAGE, 'startvm', session.vmName, '--type', 'headless']]
        : virtualBoxCommands(previewSession, image).map(args => [commands.VBOXMANAGE, ...args]);
    const socketLabel = filePath => path.join('runtime', path.relative(runtime, filePath));
    const storage = isQemu
      ? [
          {label: 'Base image (RAW)', path: path.relative(root, imagePath(image.images.raw))},
          {label: 'Working disk (QCOW2 overlay)', path: path.relative(root, overlay)}
        ]
      : [
          {label: 'Base image (VDI)', path: path.relative(root, imagePath(image.images.vdi))},
          {label: 'Working disk (VDI differential)', path: path.relative(root, session.runDisk || tempFile(session, `${image.id}.vdi`))}
        ];
    res.json({launched, engine, settings: userSettings, fields: readConfig().settings.fields, fixed, storage, interfaces: session.networkInterfaces.map((nic, index) => ({index: index + 1, switch: nic.switchId === null ? 'Disconnected' : `${sessions.get(nic.switchId)?.hostname || nic.switchId} · port ${nic.port}`, port: nic.port, mac: nic.mac})), console: {guest: 'ttyS0 · 115200 baud', socket: socketLabel(session.socketPath)}, monitor: isQemu ? socketLabel(session.monitorPath) : null, commands: launchCommands.map(args => args.map(shellQuote).join(' '))});
  } catch (error) { res.status(400).json({error: error.message}); }
});

function spawnVirtualBox(session, image) {
  const vmDir = tempFile(session, 'vbox-vm');
  fs.mkdirSync(vmDir, {recursive: true});
  try {
    const disk = tempFile(session, `${image.id}.vdi`);
    image.runFiles = [disk];
    session.runDisk = disk;
    for (const args of virtualBoxCommands(session, image)) vbox(session, args);
    session.machine = {kind: 'virtualbox', vmDir};
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
  const session = getSession(sessionId, true);
  if (session.kind !== 'vm') throw new Error('This tab is a VDE switch.');
  if (session.action && !options.reset && !(options.resume && session.action === 'reboot')) throw new Error('An action is already in progress for this host.');
  if (session.machine) throw new Error('This host is already running.');
  const resume = session.everStarted && !options.reset;
  if (resume && (selectedEngine !== session.engine || imageId !== session.selectedImage?.id)) throw new Error('Resume must use the original system and engine.');
  if (resume && (!session.runDisk || !fs.existsSync(session.runDisk))) throw new Error('The current host disk was not found.');
  if (!['qemu', 'qemu-tcg', 'virtualbox'].includes(selectedEngine)) throw new Error('Unknown engine.');
  const acceleration = selectedEngine.startsWith('qemu') ? qemuAcceleration(selectedEngine) : null;
  if (selectedEngine === 'virtualbox') {
    const qemuWithKvm = [...sessions.values()].some(other => other.kind === 'vm' && other.machine && other.engine.startsWith('qemu') && other.qemuAcceleration === 'kvm');
    if (qemuWithKvm) throw new Error('VirtualBox cannot start while a QEMU host uses KVM. Stop that host, restart it with QEMU TCG, then start VirtualBox.');
  }
  const image = resume ? session.selectedImage : imageById(imageId);
  if (!image) throw new Error('Unknown system in config.json.');
  if (!fs.existsSync(imagePath(image.images.raw))) throw new Error(`RAW image for ${image.label} is missing; run bash prepare.sh.`);
  if (selectedEngine === 'virtualbox' && !fs.existsSync(imagePath(image.images.vdi))) throw new Error(`VirtualBox base for ${image.label} is missing; run bash prepare.sh.`);
  const launchSettings = resume
    ? validateLaunchSettings({...session.launchSettings, ...(options.settings || {})})
    : launchSettingsFor(image.id, options.settings || {});
  const qemuOptions = selectedEngine.startsWith('qemu')
    ? resume ? {...session.qemuOptions, memory: launchSettings.memory, smp: launchSettings.cpus, rtcBase: launchSettings.clock} : qemuOptionsFor(image.id, launchSettings)
    : null;
  if (resume || options.reset) {
    for (const nic of session.networkInterfaces) validateNetworkInterfaces([nic.switchId], selectedEngine);
  } else {
    session.networkInterfaces = assignNetworkInterfaces(session, validateNetworkInterfaces(options.interfaces, selectedEngine));
  }
  const displayName = session.hostname || allocateName('h');
  if (fs.existsSync(session.socketPath)) fs.unlinkSync(session.socketPath);
  session.stopping = false;
  session.generation += 1;
  if (!options.reset && !resume) session.runLog = [];
  session.serialBuffer = '';
  session.lastMessage = 'Starting…';
  if (!options.reset && !resume) io.to(session.id).emit('logs-reset', {sessionId: session.id});
  io.to(session.id).emit('serial-reset', {sessionId: session.id});
  appendLog(session, `${options.reset ? '# Reset from base image' : resume ? '# Resuming from current disk' : '# Starting'} · ${selectedEngine} · ${image.label}`);
  session.engine = selectedEngine;
  session.qemuAcceleration = acceleration;
  session.selectedImage = image;
  session.hostname = displayName;
  session.qemuOptions = qemuOptions;
  session.launchSettings = launchSettings;
  if (selectedEngine.startsWith('qemu')) spawnQemu(session, image, resume);
  else if (resume) {
    vbox(session, ['modifyvm', session.vmName, '--memory', String(launchSettings.memory), '--cpus', String(launchSettings.cpus), '--rtcuseutc', launchSettings.clock === 'utc' ? 'on' : 'off']);
    vbox(session, ['startvm', session.vmName, '--type', 'headless']);
    session.machine = {kind: 'virtualbox', vmDir: tempFile(session, 'vbox-vm')};
  } else spawnVirtualBox(session, image);
  session.everStarted = true;
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

async function reboot(session) {
  if (session?.kind === 'switch') throw new Error('Reboot applies only to hosts.');
  if (!session || !session.everStarted) throw new Error('This host has not started yet.');
  if (!session.machine) throw new Error('The host is stopped; use Play to resume from its current disk.');
  if (session.action) throw new Error('An action is already in progress for this host.');
  session.action = 'reboot';
  try {
    publishState(session, 'Graceful shutdown before reboot…');
    await stop(session, {publish: false});
    if (session.action !== 'reboot' || !sessions.has(session.id)) throw new Error('The session was deleted during reboot.');
    publishState(session, 'Restarting from the current disk…');
    start(session.id, session.engine, session.selectedImage.id, {resume: true});
  } catch (error) {
    publishState(session, error.message);
    throw error;
  } finally {
    session.action = null;
    if (session.machine) publishState(session);
  }
}

async function reset(session, settings) {
  if (session?.kind === 'switch') throw new Error('Reset applies only to hosts.');
  if (!session || !session.everStarted || !session.selectedImage) throw new Error('This host has not started yet.');
  if (session.action) throw new Error('An action is already in progress for this host.');
  session.action = 'reset';
  const engine = session.engine;
  const imageId = session.selectedImage.id;
  const launchSettings = settings ? validateLaunchSettings({...session.launchSettings, ...settings}) : session.launchSettings;
  try {
    publishState(session, 'Resetting from the base image…');
    if (session.machine) await stop(session, {publish: false});
    if (session.action !== 'reset' || !sessions.has(session.id)) throw new Error('The session was deleted during reset.');
    discardSessionDisk(session);
    session.everStarted = false;
    start(session.id, engine, imageId, {reset: true, settings: launchSettings});
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
  if (session.engine === 'virtualbox') {
    vbox(session, ['unregistervm', session.vmName]);
    for (const file of image.runFiles || []) {
      try { vbox(session, ['closemedium', 'disk', file, '--delete']); }
      catch (error) { appendLog(session, `# VirtualBox medium already unregistered: ${error.message}`); }
    }
    fs.rmSync(tempFile(session, 'vbox-vm'), {recursive: true, force: true});
  }
  cleanupRunFiles(session, image);
}

async function stop(session, options = {}) {
  if (!session || !session.machine) return;
  const ownAction = !session.action;
  if (ownAction) session.action = 'stop';
  session.stopping = true;
  const current = session.machine;
  try {
    if (current.kind === 'virtualbox') {
      try {
        vbox(session, ['controlvm', session.vmName, 'acpipowerbutton']);
        await waitForVirtualBoxPowerOff(session, 10000);
      } catch (error) {
        const state = virtualBoxState(session);
        if (!['poweroff', 'aborted', 'saved'].includes(state)) {
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
    sessions.delete(session.id);
    return;
  }
  session.action = 'destroy';
  session.stopping = true;
  session.generation += 1;
  if (session.serial) { session.serial.destroy(); session.serial = null; }
  const current = session.machine;
  const image = session.selectedImage || {};
  session.machine = null;
  if (session.engine === 'virtualbox' && session.everStarted && session.selectedImage) {
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
  session.runLog = [];
  session.serialBuffer = '';
  session.selectedImage = null;
  session.qemuOptions = null;
  session.everStarted = false;
  sessions.delete(session.id);
}

app.post('/api/start', (req, res) => {
  try {
    const session = start(req.body.sessionId, req.body.engine, req.body.imageId, {interfaces: req.body.interfaces, settings: req.body.settings});
    res.json({ok: true, sessionId: session.id, name: session.hostname});
  } catch (error) {
    const message = error.stderr ? error.stderr.toString().trim() : error.message;
    console.error(message);
    try {
      const session = getSession(req.body.sessionId);
      if (session) publishState(session, message);
    } catch (_) {}
    res.status(500).json({error: message});
  }
});

app.post('/api/topology', (req, res) => {
  const created = [];
  try {
    const {text, engine = 'qemu'} = req.body || {};
    if (!['qemu', 'qemu-tcg', 'virtualbox'].includes(engine)) throw new Error('Unknown engine.');
    const topology = parseTopology(text, Object.keys(readConfig().systems));
    if (engine === 'virtualbox' && topology.hosts.some(host => host.switches.length)) throw new Error('Connected interfaces require a QEMU engine.');
    const used = new Set([...sessions.values()].map(session => session.hostname?.toLowerCase()));
    for (const entry of [...topology.switches, ...topology.hosts]) if (used.has(entry.name.toLowerCase())) throw new Error(`Name already exists: ${entry.name}.`);
    const switchIds = new Map();
    for (const sw of topology.switches) {
      const id = `sw-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
      const session = getSession(id, true, 'switch'); created.push(id);
      session.hostname = sw.name; session.lastMessage = 'VDE switch ready to start';
      switchIds.set(sw.name, id);
    }
    for (const host of topology.hosts) {
      const id = `vm-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
      const interfaces = assignNetworkInterfaces({id}, validateNetworkInterfaces(host.switches.map(name => switchIds.get(name)), engine, false));
      const session = getSession(id, true, 'vm'); created.push(id);
      session.hostname = host.name; session.selectedImage = imageById(host.system); session.engine = engine;
      session.networkInterfaces = interfaces; session.lastMessage = 'Host ready to start';
    }
    res.json({created: created.length});
  } catch (error) {
    for (const id of created) sessions.delete(id);
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
        if (!sw || sw.kind !== 'switch') throw new Error(`Host ${session.hostname} has a disconnected interface; .top cannot represent it.`);
        return sw.hostname;
      })
    }));
    const text = formatTopology({switches, hosts});
    parseTopology(text, Object.keys(readConfig().systems));
    res.type('text/plain').send(text);
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.post('/api/hosts', (req, res) => {
  try {
    const {id, name, imageId, engine = 'qemu', interfaces, settings} = req.body || {};
    if (sessions.has(id)) throw new Error('Host ID already exists.');
    const image = imageById(imageId || Object.keys(readConfig().systems)[0]);
    if (!image) throw new Error('Unknown system in config.json.');
    if (!['qemu', 'qemu-tcg', 'virtualbox'].includes(engine)) throw new Error('Unknown engine.');
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(name))) throw new Error('Invalid host name (1 to 64 characters).');
    const hostname = name === undefined ? allocateName('h') : name.trim();
    if ([...sessions.values()].some(other => other.hostname === hostname)) throw new Error('Host name already exists.');
    const networkInterfaces = assignNetworkInterfaces({id}, validateNetworkInterfaces(interfaces, engine, false));
    const launchSettings = settings ? launchSettingsFor(image.id, settings) : null;
    const session = getSession(id, true, 'vm');
    session.hostname = hostname;
    session.selectedImage = image;
    session.engine = engine;
    session.networkInterfaces = networkInterfaces;
    session.launchSettings = launchSettings;
    session.lastMessage = 'Host ready to start';
    res.json({id, name: hostname, imageId: image.id, engine, interfaces: networkInterfaces.map(nic => nic.switchId), settings: launchSettings});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.post('/api/switches', async (req, res) => {
  let session;
  try {
    const {id, name, autostart = true} = req.body || {};
    if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(name)) throw new Error('Switch name must be 1–32 letters, digits, underscores or hyphens.');
    if (sessions.has(id) || [...sessions.values()].some(s => s.kind === 'switch' && s.hostname === name)) throw new Error('Switch ID or name already exists.');
    session = getSession(id, true, 'switch');
    session.hostname = name;
    session.lastMessage = 'VDE switch ready to start';
    if (autostart) await startSwitch(session);
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
  try { await reset(getSession(req.params.sessionId), req.body?.settings); res.json({ok: true}); }
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
    session.hostname = name.trim();
    io.emit('session-renamed', {sessionId: session.id, name: session.hostname});
    res.json({name: session.hostname});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.delete('/api/sessions/:sessionId', async (req, res) => {
  try {
    const session = getSession(req.params.sessionId);
    await destroySession(session);
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
        await new Promise((resolve, reject) => socket.leave(socket.sessionId, error => error ? reject(error) : resolve()));
      }
      await new Promise((resolve, reject) => socket.join(id, error => error ? reject(error) : resolve()));
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
  console.log('\nQemuWeb is ready.');
  console.log(`  Web interface  http://127.0.0.1:${port}`);
  console.log('  Stop           Ctrl+C\n');
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
