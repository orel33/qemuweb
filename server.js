'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const {spawn, execFileSync} = require('child_process');
const express = require('express');
const socketIo = require('socket.io');

const root = __dirname;
const runtime = path.join(root, 'runtime');
const configPath = path.join(root, 'config.json');
const qemuFields = ['machine', 'cpuKvm', 'cpuTcg', 'memory', 'smp', 'display', 'diskInterface', 'bootDisk', 'nic'];
const port = Number(process.env.PORT || 3002);
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const sessions = new Map();
const nameCounters = new Map();
fs.mkdirSync(runtime, {recursive: true});

function shellQuote(value) {
  const text = String(value);
  return /^[a-zA-Z0-9_./:=,+-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

function getSession(id, create = false) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(id)) throw new Error('Invalid machine ID.');
  if (!sessions.has(id) && create) {
    sessions.set(id, {
      id,
      vmName: `qemuweb-${process.pid}-${id}`,
      socketPath: path.join(runtime, `qemuweb-${process.pid}-${id}.sock`),
      monitorPath: path.join(runtime, `qemuweb-${process.pid}-${id}.monitor.sock`),
      machine: null,
      serial: null,
      engine: null,
      qemuAcceleration: null,
      qemuOptions: null,
      selectedImage: null,
      hostname: null,
      everStarted: false,
      stopping: false,
      action: null,
      runLog: [],
      serialBuffer: '',
      generation: 0,
      runDisk: null
    });
  }
  return sessions.get(id);
}

function stateMessage(session) {
  if (!session.machine) return session.lastMessage || 'Stopped';
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
app.use(express.static(path.join(root, 'public')));

function imageById(id) {
  const system = readConfig().systems[id];
  return system ? {id, ...system} : null;
}

function allocateName(id) {
  const used = new Set([...sessions.values()].map(session => session.hostname).filter(Boolean));
  for (let n = nameCounters.get(id) || 0; n < 100; n++) {
    const name = `${id}-${String(n).padStart(2, '0')}`;
    if (!used.has(name)) { nameCounters.set(id, n + 1); return name; }
  }
  throw new Error(`All 100 names for ${id} have been used.`);
}

function validateQemuOptions(options, partial = false) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid QEMU settings.');
  for (const key of Object.keys(options)) {
    if (!qemuFields.includes(key)) throw new Error(`Unknown QEMU setting: ${key}.`);
  }
  if (!partial && qemuFields.some(key => !Object.hasOwn(options, key))) throw new Error('Incomplete QEMU settings.');
  for (const [key, value] of Object.entries(options)) {
    if (key === 'memory' || key === 'smp') {
      const limit = key === 'memory' ? [64, 32768] : [1, 64];
      if (!Number.isInteger(value) || value < limit[0] || value > limit[1]) throw new Error(`${key} must be an integer between ${limit[0]} and ${limit[1]}.`);
    } else if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error(`Invalid value for ${key}.`);
    }
  }
  if (options.diskInterface && !['virtio', 'ide'].includes(options.diskInterface)) throw new Error('QEMU disk bus must be virtio or ide.');
  for (const key of ['bootDisk']) {
    if (options[key] && !/^[a-dn]{1,5}$/.test(options[key])) throw new Error(`Invalid QEMU boot order: ${key}.`);
  }
  return options;
}

function readConfig() {
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (error) { throw new Error(`Cannot read config.json: ${error.message}`); }
  if (!config || !config.qemu || !config.systems || typeof config.systems !== 'object' || Array.isArray(config.systems)) throw new Error('Invalid config.json structure.');
  validateQemuOptions(config.qemu.defaults);
  for (const [id, system] of Object.entries(config.systems)) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || !system || system.type !== 'linux' || system.mode !== 'text') throw new Error(`Invalid system ${id}: only Linux text-mode profiles are supported.`);
    for (const key of ['label', 'description', 'login']) {
      if (typeof system[key] !== 'string' || !system[key].trim()) throw new Error(`Missing ${key} for ${id}.`);
    }
    for (const format of ['raw', 'vdi']) {
      if (!system.images || typeof system.images[format] !== 'string' || !system.images[format] || /[\x00-\x1f\x7f]/.test(system.images[format])) throw new Error(`Invalid ${format} path for ${id}.`);
    }
    validateQemuOptions(system.qemu, true);
    const vbox = system.virtualbox;
    if (!vbox || !Number.isInteger(vbox.memory) || vbox.memory < 64 || vbox.memory > 32768 || typeof vbox.nic !== 'string' || !vbox.nic || typeof vbox.osType !== 'string' || !vbox.osType) throw new Error(`Invalid VirtualBox settings for ${id}.`);
  }
  return config;
}

function qemuOptionsFor(imageId) {
  const config = readConfig();
  return validateQemuOptions({...config.qemu.defaults, ...(config.systems[imageId]?.qemu || {})});
}

app.get('/api/qemu-config', (_req, res) => {
  try {
    const config = readConfig();
    res.json({defaults: config.qemu.defaults, systems: Object.fromEntries(Object.entries(config.systems).map(([id, system]) => [id, system.qemu]))});
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
    running: !!session.machine,
    hasLaunched: session.everStarted,
    engine: session.engine,
    imageId: session.selectedImage && session.selectedImage.id,
    hostname: session.hostname,
    hasDifferentialDisk: !!session.runDisk && fs.existsSync(session.runDisk),
    message: stateMessage(session)
  })));
});

function connectSerial(session, attempt = 0, generation = session.generation) {
  if (!session.machine || session.stopping || generation !== session.generation || attempt > 100) return;
  const connection = net.createConnection(session.socketPath);
  connection.once('connect', () => {
    session.serial = connection;
    publishState(session);
    connection.on('data', data => {
      const text = data.toString('utf8');
      session.serialBuffer = (session.serialBuffer + text).slice(-262144);
      io.to(session.id).emit('serial', {sessionId: session.id, data: text});
    });
    connection.on('close', () => {
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
    '-display', settings.display, '-monitor', `unix:${session.monitorPath},server=on,wait=off`,
    '-serial', `unix:${session.socketPath},server=on,wait=off`
  ];
  // QEMU PC boot notation: c = first hard disk.
  return [...common, '-drive', `file=${overlay},if=${settings.diskInterface},format=qcow2,media=disk`, '-boot', `order=${settings.bootDisk}`, '-nic', settings.nic];
}

function qemuAcceleration(engine, checkAvailability = true) {
  if (engine === 'qemu-tcg') return 'tcg';
  if (engine !== 'qemu') throw new Error('Unknown QEMU acceleration mode.');
  if (!checkAvailability) return 'kvm';
  const virtualBoxRunning = [...sessions.values()].some(other => other.machine && other.engine === 'virtualbox');
  if (virtualBoxRunning) throw new Error('QEMU/KVM cannot start while a VirtualBox VM is running. Stop VirtualBox or select QEMU · TCG.');
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
    if (reuseDisk) throw new Error('The current VM disk was not found.');
    execLogged(session, 'qemu-img', qemuOverlayArgs(image, overlay), {stdio: 'pipe'});
  }
  image.runFiles = [overlay];
  session.runDisk = overlay;
  const args = qemuArgs(session, image, overlay);
  appendLog(session, `$ ${['qemu-system-x86_64', ...args].map(shellQuote).join(' ')}`);
  const child = spawn('qemu-system-x86_64', args, {stdio: ['ignore', 'pipe', 'pipe']});
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
  return execLogged(session, 'VBoxManage', args, {stdio: 'pipe'});
}

function virtualBoxCommands(session, image) {
  const vmDir = tempFile(session, 'vbox-vm');
  const disk = tempFile(session, `${image.id}.vdi`);
  return [
    ['createvm', '--name', session.vmName, '--basefolder', vmDir, '--ostype', image.virtualbox.osType, '--register'],
    ['modifyvm', session.vmName, '--memory', String(image.virtualbox.memory), '--cpus', '1', '--nic1', image.virtualbox.nic, '--uart1', '0x3F8', '4', '--uartmode1', 'server', session.socketPath],
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
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) throw new Error('Invalid machine ID.');
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
      qemuOptions: engine.startsWith('qemu') ? qemuOptionsFor(image.id) : null
    };
    const isQemu = engine.startsWith('qemu');
    const options = isQemu ? session.qemuOptions : qemuOptionsFor(image.id);
    const overlay = launched && session.runDisk ? session.runDisk : tempFile(session, `${image.id}-overlay.qcow2`);
    const qemuMappings = {
      machine: '-machine', cpuKvm: session.qemuAcceleration === 'kvm' ? '-cpu' : 'inactive with this engine',
      cpuTcg: session.qemuAcceleration === 'tcg' ? '-cpu' : 'inactive with this engine', memory: '-m (MiB)',
      smp: '-smp', display: '-display', diskInterface: '-drive if=', bootDisk: '-boot order=', nic: '-nic'
    };
    const rows = [
      ['systems.' + image.id + '.type / mode', `${image.type} / ${image.mode}`, 'System profile; no command-line argument'],
      ['label / description / login', `${image.label} — ${image.description} Login: ${image.login}`, 'Interface; no command-line argument'],
      ['images.raw', image.images.raw, isQemu ? 'qemu-img create -b (RAW base)' : 'Master base; not passed to VirtualBox'],
      ['images.vdi', image.images.vdi, isQemu ? 'Not used by QEMU' : 'VBoxManage createmedium --diffparent']
    ];
    for (const key of qemuFields) rows.push(['qemu.' + key, String(options ? options[key] : ({...readConfig().qemu.defaults, ...image.qemu})[key]), isQemu ? qemuMappings[key] : 'Not used by VirtualBox']);
    for (const [key, value] of Object.entries(image.virtualbox)) rows.push(['virtualbox.' + key, String(value), isQemu ? 'Not used by QEMU' : ({memory: '--memory (MiB)', nic: '--nic1', osType: '--ostype'})[key] || 'Not used']);
    if (isQemu) rows.push(['Server: acceleration', session.qemuAcceleration, '-accel (KVM/TCG selection)'], ['Server: disk', 'QCOW2 working disk, format=qcow2, media=disk', '-drive'], ['Server: serial console', session.socketPath, '-serial unix:…,server=on,wait=off'], ['Server: monitor', session.monitorPath, '-monitor unix:…,server=on,wait=off'], ['QEMU: firmware and other devices', 'Selected machine defaults', 'Options not specified on the command line']);
    else rows.push(['Server: disk', 'VDI working disk, SATA controller', 'createmedium / storagectl / storageattach'], ['Server: CPU and boot', '1 CPU; disk, DVD', '--cpus 1 / --boot1 disk / --boot2 dvd'], ['Server: serial console', session.socketPath, '--uart1 0x3F8 4 / --uartmode1 server'], ['Server: display', 'Headless', 'startvm --type headless'], ['VirtualBox: other settings', 'VirtualBox defaults', 'Options not specified by the server']);
    const commands = isQemu
      ? [['qemu-img', ...qemuOverlayArgs(image, overlay)], ['qemu-system-x86_64', ...qemuArgs(session, image, overlay)]]
      : virtualBoxCommands(session, image).map(args => ['VBoxManage', ...args]);
    res.json({launched, engine, rows, commands: commands.map(args => args.map(shellQuote).join(' '))});
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
  if (session.action && !options.reset && !(options.resume && session.action === 'reboot')) throw new Error('An action is already in progress for this VM.');
  if (session.machine) throw new Error('This VM is already running.');
  const resume = session.everStarted && !options.reset;
  if (resume && (selectedEngine !== session.engine || imageId !== session.selectedImage?.id)) throw new Error('Resume must use the original system and engine.');
  if (resume && (!session.runDisk || !fs.existsSync(session.runDisk))) throw new Error('The current VM disk was not found.');
  if (!['qemu', 'qemu-tcg', 'virtualbox'].includes(selectedEngine)) throw new Error('Unknown engine.');
  const acceleration = selectedEngine.startsWith('qemu') ? qemuAcceleration(selectedEngine) : null;
  if (selectedEngine === 'virtualbox') {
    const qemuWithKvm = [...sessions.values()].some(other => other.machine && other.engine.startsWith('qemu') && other.qemuAcceleration === 'kvm');
    if (qemuWithKvm) throw new Error('VirtualBox cannot start while a QEMU VM uses KVM. Stop that VM, restart it with QEMU TCG, then start VirtualBox.');
  }
  const image = resume ? session.selectedImage : imageById(imageId);
  if (!image) throw new Error('Unknown system in config.json.');
  if (!fs.existsSync(imagePath(image.images.raw))) throw new Error(`RAW image for ${image.label} is missing; run bash prepare.sh.`);
  if (selectedEngine === 'virtualbox' && !fs.existsSync(imagePath(image.images.vdi))) throw new Error(`VirtualBox base for ${image.label} is missing; run bash prepare.sh.`);
  const qemuOptions = selectedEngine.startsWith('qemu') ? (resume ? session.qemuOptions : options.reset ? validateQemuOptions(options.qemuOptions) : qemuOptionsFor(image.id)) : null;
  const displayName = resume || options.reset ? session.hostname : allocateName(image.id);
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
  if (selectedEngine.startsWith('qemu')) spawnQemu(session, image, resume);
  else if (resume) {
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
    const timeout = setTimeout(() => finish(new Error('The VM did not respond to the graceful shutdown request.')), timeoutMs);
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
  const output = execFileSync('VBoxManage', ['showvminfo', session.vmName, '--machinereadable'], {encoding: 'utf8'});
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
  throw new Error('The VM did not respond to the graceful shutdown request.');
}

async function reboot(session) {
  if (!session || !session.everStarted) throw new Error('This machine has not started yet.');
  if (!session.machine) throw new Error('The VM is stopped; use Play to resume from its current disk.');
  if (session.action) throw new Error('An action is already in progress for this VM.');
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

async function reset(session) {
  if (!session || !session.everStarted || !session.selectedImage) throw new Error('This machine has not started yet.');
  if (session.action) throw new Error('An action is already in progress for this VM.');
  session.action = 'reset';
  const engine = session.engine;
  const imageId = session.selectedImage.id;
  const qemuOptions = session.qemuOptions;
  try {
    publishState(session, 'Resetting from the base image…');
    if (session.machine) await stop(session, {publish: false});
    if (session.action !== 'reset' || !sessions.has(session.id)) throw new Error('The session was deleted during reset.');
    discardSessionDisk(session);
    session.everStarted = false;
    start(session.id, engine, imageId, {reset: true, qemuOptions});
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
    if (options.publish !== false && session.action !== 'destroy') publishState(session, 'VM stopped; current disk kept');
  } finally {
    session.stopping = false;
    if (ownAction && session.action === 'stop') session.action = null;
  }
}

async function destroySession(session) {
  if (!session) return;
  session.action = 'destroy';
  session.stopping = true;
  session.generation += 1;
  if (session.serial) { session.serial.destroy(); session.serial = null; }
  const current = session.machine;
  const image = session.selectedImage || {};
  session.machine = null;
  if (session.engine === 'virtualbox' && session.selectedImage) {
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
    const session = start(req.body.sessionId, req.body.engine, req.body.imageId);
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

app.post('/api/stop/:sessionId', async (req, res) => {
  try {
    const session = getSession(req.params.sessionId);
    if (session && session.action) throw new Error('An action is already in progress for this VM.');
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
    if (!session || !session.machine || !session.engine.startsWith('qemu') || session.action) throw new Error('Monitor is available only for a running QEMU VM.');
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
    if (!session || !session.everStarted) throw new Error('This VM has not started yet.');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid name (1 to 64 characters).');
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
      const session = getSession(id, true);
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
  socket.on('input', data => {
    const session = socket.sessionId && sessions.get(socket.sessionId);
    if (session && session.serial && typeof data === 'string') session.serial.write(data);
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
server.listen(port, '127.0.0.1', () => console.log(`Test console: http://127.0.0.1:${port}`));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(1), 10000);
  await Promise.all([...sessions.values()].map(session => destroySession(session).catch(error => console.error('VM shutdown:', error))));
  io.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
