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
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(id)) throw new Error('Identifiant de machine invalide.');
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
  if (!session.machine) return session.lastMessage || 'Arrêtée';
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
  throw new Error(`Les 100 noms disponibles pour ${id} sont utilisés.`);
}

function validateQemuOptions(options, partial = false) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Options QEMU invalides.');
  for (const key of Object.keys(options)) {
    if (!qemuFields.includes(key)) throw new Error(`Option QEMU inconnue : ${key}.`);
  }
  if (!partial && qemuFields.some(key => !Object.hasOwn(options, key))) throw new Error('Options QEMU incomplètes.');
  for (const [key, value] of Object.entries(options)) {
    if (key === 'memory' || key === 'smp') {
      const limit = key === 'memory' ? [64, 32768] : [1, 64];
      if (!Number.isInteger(value) || value < limit[0] || value > limit[1]) throw new Error(`${key} doit être un entier entre ${limit[0]} et ${limit[1]}.`);
    } else if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error(`Valeur invalide pour ${key}.`);
    }
  }
  if (options.diskInterface && !['virtio', 'ide'].includes(options.diskInterface)) throw new Error('Bus disque QEMU : virtio ou ide.');
  for (const key of ['bootDisk']) {
    if (options[key] && !/^[a-dn]{1,5}$/.test(options[key])) throw new Error(`Ordre de boot QEMU invalide : ${key}.`);
  }
  return options;
}

function readConfig() {
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (error) { throw new Error(`Lecture de config.json impossible : ${error.message}`); }
  if (!config || !config.qemu || !config.systems || typeof config.systems !== 'object' || Array.isArray(config.systems)) throw new Error('Structure invalide dans config.json.');
  validateQemuOptions(config.qemu.defaults);
  for (const [id, system] of Object.entries(config.systems)) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || !system || system.type !== 'linux' || system.mode !== 'text') throw new Error(`Système ${id} invalide : seuls les profils Linux en mode texte sont pris en charge.`);
    for (const key of ['label', 'description', 'login']) {
      if (typeof system[key] !== 'string' || !system[key].trim()) throw new Error(`Champ ${key} manquant pour ${id}.`);
    }
    for (const format of ['raw', 'vdi']) {
      if (!system.images || typeof system.images[format] !== 'string' || !system.images[format] || /[\x00-\x1f\x7f]/.test(system.images[format])) throw new Error(`Chemin ${format} invalide pour ${id}.`);
    }
    validateQemuOptions(system.qemu, true);
    const vbox = system.virtualbox;
    if (!vbox || !Number.isInteger(vbox.memory) || vbox.memory < 64 || vbox.memory > 32768 || typeof vbox.nic !== 'string' || !vbox.nic || typeof vbox.osType !== 'string' || !vbox.osType) throw new Error(`Options VirtualBox invalides pour ${id}.`);
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

app.put('/api/qemu-config', (req, res) => {
  try {
    const {scope, imageId, options} = req.body || {};
    validateQemuOptions(options);
    const config = readConfig();
    if (scope === 'defaults') config.qemu.defaults = options;
    else if (scope === 'system' && Object.hasOwn(config.systems, imageId)) {
      const overrides = Object.fromEntries(qemuFields.filter(key => options[key] !== config.qemu.defaults[key]).map(key => [key, options[key]]));
      config.systems[imageId].qemu = overrides;
    } else throw new Error('Profil QEMU inconnu.');
    const temp = `${configPath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`);
      fs.renameSync(temp, configPath);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch (_) {}
      throw error;
    }
    res.json({defaults: config.qemu.defaults, systems: Object.fromEntries(Object.entries(config.systems).map(([id, system]) => [id, system.qemu]))});
  } catch (error) { res.status(400).json({error: error.message}); }
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
    hasDifferentialDisk: !!session.selectedImage,
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
      if (!session.stopping && session.action !== 'reboot' && session.machine) publishState(session, 'Console série déconnectée');
    });
    connection.on('error', error => console.error('serial:', error.message));
  });
  connection.once('error', () => setTimeout(() => connectSerial(session, attempt + 1, generation), 250));
}

function tempFile(session, name) {
  return path.join(runtime, `qemuweb-${process.pid}-${session.id}-${name}`);
}

function imagePath(file) { return path.resolve(root, file); }

function makeRunVdi(session, image) {
  const base = imagePath(image.images.vdi);
  if (!fs.existsSync(base)) throw new Error(`Base VirtualBox ${image.label} absente ; exécuter bash prepare.sh.`);
  const vdi = tempFile(session, `${image.id}.vdi`);
  image.runFiles = [...(image.runFiles || []), vdi];
  vbox(session, ['createmedium', 'disk', '--filename', vdi, '--diffparent', base, '--format', 'VDI']);
  session.runDisk = vdi;
  return vdi;
}

function qemuArgs(session, image, reuseDisk = false) {
  const settings = session.qemuOptions;
  const common = [
    '-machine', settings.machine, '-accel', session.qemuAcceleration,
    '-cpu', session.qemuAcceleration === 'kvm' ? settings.cpuKvm : settings.cpuTcg,
    '-m', String(settings.memory), '-smp', String(settings.smp),
    '-display', settings.display, '-monitor', `unix:${session.monitorPath},server=on,wait=off`,
    '-serial', `unix:${session.socketPath},server=on,wait=off`
  ];
  // Notation de démarrage QEMU sur PC : c = premier disque dur.
  const overlay = reuseDisk ? session.runDisk : tempFile(session, `${image.id}-overlay.qcow2`);
  if (!overlay || !fs.existsSync(overlay)) {
    if (reuseDisk) throw new Error('Le disque différentiel à redémarrer est introuvable.');
    execLogged(session, 'qemu-img', ['create', '-f', 'qcow2', '-F', 'raw', '-b', imagePath(image.images.raw), overlay], {stdio: 'pipe'});
  }
  image.runFiles = [overlay];
  session.runDisk = overlay;
  return [...common, '-drive', `file=${overlay},if=${settings.diskInterface},format=qcow2,media=disk`, '-boot', `order=${settings.bootDisk}`, '-nic', settings.nic];
}

function spawnQemu(session, image, reuseDisk = false) {
  const virtualBoxRunning = [...sessions.values()].some(other => other.machine && other.engine === 'virtualbox');
  if (session.engine === 'qemu-tcg' || virtualBoxRunning) session.qemuAcceleration = 'tcg';
  else {
    try {
      fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
      session.qemuAcceleration = 'kvm';
    } catch (_) { session.qemuAcceleration = 'tcg'; }
  }
  const args = qemuArgs(session, image, reuseDisk);
  appendLog(session, `$ ${['qemu-system-x86_64', ...args].map(shellQuote).join(' ')}`);
  const child = spawn('qemu-system-x86_64', args, {stdio: ['ignore', 'pipe', 'pipe']});
  session.machine = child;
  child.stdout.on('data', data => { console.log('qemu:', data.toString().trim()); appendLog(session, data.toString()); });
  child.stderr.on('data', data => { console.log('qemu:', data.toString().trim()); appendLog(session, data.toString()); });
  child.once('error', error => {
    if (session.machine === child) {
      session.machine = null;
      session.everStarted = false;
      cleanupRunFiles(session, image);
      try { fs.unlinkSync(session.socketPath); } catch (_) {}
      try { fs.unlinkSync(session.monitorPath); } catch (_) {}
      publishState(session, `Erreur QEMU : ${error.message}`);
    }
  });
  child.once('exit', code => {
    const preserveDisk = session.action === 'reboot';
    if (!preserveDisk) cleanupRunFiles(session, image);
    try { fs.unlinkSync(session.socketPath); } catch (_) {}
    try { fs.unlinkSync(session.monitorPath); } catch (_) {}
    if (session.machine === child) session.machine = null;
    if (session.stopping || preserveDisk) return;
    publishState(session, `QEMU arrêté (${code})`);
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

function spawnVirtualBox(session, image) {
  let diskPath;
  const vmDir = tempFile(session, 'vbox-vm');
  fs.mkdirSync(vmDir, {recursive: true});
  try {
    vbox(session, ['createvm', '--name', session.vmName, '--basefolder', vmDir, '--ostype', image.virtualbox.osType, '--register']);
    vbox(session, ['modifyvm', session.vmName, '--memory', String(image.virtualbox.memory), '--cpus', '1', '--nic1', image.virtualbox.nic, '--uart1', '0x3F8', '4', '--uartmode1', 'server', session.socketPath]);
    image.runFiles = [];
    diskPath = makeRunVdi(session, image);
    vbox(session, ['storagectl', session.vmName, '--name', 'SATA', '--add', 'sata', '--controller', 'IntelAhci']);
    vbox(session, ['storageattach', session.vmName, '--storagectl', 'SATA', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', diskPath]);
    vbox(session, ['modifyvm', session.vmName, '--boot1', 'disk', '--boot2', 'dvd', '--boot3', 'none', '--boot4', 'none']);
    vbox(session, ['startvm', session.vmName, '--type', 'headless']);
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
  if (session.action && !options.reset) throw new Error('Une action est déjà en cours sur cette VM.');
  if (session.machine) throw new Error('Cette VM est déjà lancée.');
  if (session.everStarted && !options.reset) throw new Error('Cet onglet a déjà servi à lancer sa VM. Utilise Reboot ou Reset, ou crée un nouvel onglet pour une autre machine.');
  if (!['qemu', 'qemu-tcg', 'virtualbox'].includes(selectedEngine)) throw new Error('Moteur inconnu.');
  if (selectedEngine === 'virtualbox') {
    const qemuWithKvm = [...sessions.values()].some(other => other.machine && other.engine.startsWith('qemu') && other.qemuAcceleration === 'kvm');
    if (qemuWithKvm) throw new Error('VirtualBox ne peut pas démarrer tant qu’une VM QEMU utilise KVM. Arrête la VM QEMU, redémarre-la avec QEMU · TCG, puis lance VirtualBox.');
  }
  const image = imageById(imageId);
  if (!image) throw new Error('Système inconnu dans config.json.');
  if (!fs.existsSync(imagePath(image.images.raw))) throw new Error(`Image RAW ${image.label} absente ; exécuter bash prepare.sh.`);
  if (selectedEngine === 'virtualbox' && !fs.existsSync(imagePath(image.images.vdi))) throw new Error(`Base VirtualBox ${image.label} absente ; exécuter bash prepare.sh.`);
  const qemuOptions = selectedEngine.startsWith('qemu') ? (options.reset ? validateQemuOptions(options.qemuOptions) : qemuOptionsFor(image.id)) : null;
  const displayName = options.reset ? session.hostname : allocateName(image.id);
  if (fs.existsSync(session.socketPath)) fs.unlinkSync(session.socketPath);
  session.stopping = false;
  session.generation += 1;
  if (!options.reset) session.runLog = [];
  session.serialBuffer = '';
  session.lastMessage = 'Démarrage…';
  if (!options.reset) io.to(session.id).emit('logs-reset', {sessionId: session.id});
  io.to(session.id).emit('serial-reset', {sessionId: session.id});
  appendLog(session, `${options.reset ? '# Reset depuis la base' : '# Démarrage'} · ${selectedEngine} · ${image.label}`);
  session.engine = selectedEngine;
  session.selectedImage = image;
  session.hostname = displayName;
  session.qemuOptions = qemuOptions;
  if (selectedEngine.startsWith('qemu')) spawnQemu(session, image);
  else if (selectedEngine === 'virtualbox') spawnVirtualBox(session, image);
  session.everStarted = true;
  publishState(session, selectedEngine === 'qemu' ? `QEMU/${session.qemuAcceleration.toUpperCase()} · ${image.label} en démarrage…` : `VirtualBox · ${image.label} en démarrage…`);
  connectSerial(session);
  return session;
}

function sendMonitorCommand(session, command) {
  return new Promise((resolve, reject) => {
    const monitor = net.createConnection(session.monitorPath);
    let output = '';
    let sent = false;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('Délai dépassé pour la commande QEMU.')), 5000);
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
      if (output.length > 65536) return finish(new Error('Réponse du moniteur trop longue.'));
      if (!sent && output.includes('(qemu)')) {
        sent = true;
        output = '';
        monitor.write(`${command}\n`, error => { if (error) finish(error); });
      } else if (sent && output.includes('\n') && /(?:^|[\r\n])\(qemu\) ?$/.test(output.slice(output.indexOf('\n') + 1))) finish();
    });
    monitor.once('error', finish);
    monitor.once('close', () => { if (!settled) finish(new Error('Connexion au moniteur QEMU interrompue.')); });
  });
}

function waitForQemuExit(child, timeoutMs = 30000) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('La VM n’a pas répondu à la demande d’arrêt propre.')), timeoutMs);
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
  throw new Error('La VM n’a pas répondu à la demande d’arrêt propre.');
}

async function reboot(session) {
  if (!session || !session.everStarted) throw new Error('Cette machine n’a pas encore démarré.');
  if (!session.machine) throw new Error('La VM est arrêtée ; utilise Reset pour repartir de l’image de base.');
  if (session.action) throw new Error('Une action est déjà en cours sur cette VM.');
  session.action = 'reboot';
  try {
    const image = session.selectedImage;
    const current = session.machine;
    publishState(session, 'Arrêt propre avant redémarrage…');
    if (session.engine.startsWith('qemu')) {
      appendLog(session, '$ QEMU monitor: system_powerdown');
      await sendMonitorCommand(session, 'system_powerdown');
      await waitForQemuExit(current);
    } else {
      vbox(session, ['controlvm', session.vmName, 'acpipowerbutton']);
      await waitForVirtualBoxPowerOff(session);
      session.machine = null;
    }
    if (session.action !== 'reboot' || !sessions.has(session.id)) throw new Error('La session a été supprimée pendant le Reboot.');
    if (session.serial) { session.serial.destroy(); session.serial = null; }
    session.generation += 1;
    session.serialBuffer = '';
    io.to(session.id).emit('serial-reset', {sessionId: session.id});
    publishState(session, 'Redémarrage depuis le disque différentiel…');
    if (session.engine.startsWith('qemu')) spawnQemu(session, image, true);
    else {
      vbox(session, ['startvm', session.vmName, '--type', 'headless']);
      session.machine = current;
    }
    connectSerial(session);
    publishState(session, `${stateMessage(session)} · redémarrage`);
  } catch (error) {
    publishState(session, error.message);
    throw error;
  } finally {
    session.action = null;
  }
}

async function reset(session) {
  if (!session || !session.everStarted || !session.selectedImage) throw new Error('Cette machine n’a pas encore démarré.');
  if (session.action) throw new Error('Une action est déjà en cours sur cette VM.');
  session.action = 'reset';
  const engine = session.engine;
  const imageId = session.selectedImage.id;
  const qemuOptions = session.qemuOptions;
  try {
    publishState(session, 'Réinitialisation depuis l’image de base…');
    if (session.machine) await stop(session);
    if (session.action !== 'reset' || !sessions.has(session.id)) throw new Error('La session a été supprimée pendant le Reset.');
    session.everStarted = false;
    start(session.id, engine, imageId, {reset: true, qemuOptions});
  } catch (error) {
    session.everStarted = true;
    publishState(session, error.message);
    throw error;
  } finally {
    session.action = null;
  }
}

async function stop(session) {
  if (!session || !session.machine) return;
  session.stopping = true;
  if (session.serial) { session.serial.destroy(); session.serial = null; }
  const current = session.machine;
  const image = session.selectedImage;
  session.machine = null;
  if (current.kind === 'virtualbox') {
    try { vbox(session, ['controlvm', session.vmName, 'acpipowerbutton']); } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 3000));
    try { vbox(session, ['controlvm', session.vmName, 'poweroff']); } catch (_) {}
    try { vbox(session, ['unregistervm', session.vmName]); } catch (error) { console.error(error.message); }
    for (const file of image.runFiles || []) { try { vbox(session, ['closemedium', 'disk', file, '--delete']); } catch (error) { console.error(error.message); } }
    if (current.vmDir) fs.rmSync(current.vmDir, {recursive: true, force: true});
  } else {
    appendLog(session, '$ signal envoyé à qemu-system-x86_64: SIGTERM');
    current.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (current.exitCode === null) current.kill('SIGKILL');
  }
  cleanupRunFiles(session, image || {});
  try { fs.unlinkSync(session.socketPath); } catch (_) {}
  try { fs.unlinkSync(session.monitorPath); } catch (_) {}
  session.stopping = false;
  publishState(session, 'VM arrêtée');
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
  if (current && current.kind === 'virtualbox') {
    try { vbox(session, ['controlvm', session.vmName, 'poweroff']); } catch (_) {}
    try { vbox(session, ['unregistervm', session.vmName]); } catch (_) {}
    for (const file of image.runFiles || []) {
      try { vbox(session, ['closemedium', 'disk', file, '--delete']); } catch (_) {}
    }
    if (current.vmDir) fs.rmSync(current.vmDir, {recursive: true, force: true});
  } else if (current) {
    appendLog(session, '$ kill forcé de qemu-system-x86_64: SIGKILL');
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
    if (session && session.action) throw new Error('Une action est déjà en cours sur cette VM.');
    await stop(session);
    res.json({ok: true});
  }
  catch (error) { console.error(error); res.status(500).json({error: error.message}); }
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
    if (!session || !session.machine || !session.engine.startsWith('qemu') || session.action) throw new Error('Moniteur disponible uniquement pour une VM QEMU en cours.');
    const command = req.body && req.body.command;
    if (typeof command !== 'string' || !command.trim() || command.length > 256 || /[\r\n\x00-\x1f\x7f]/.test(command)) throw new Error('Saisir une commande QEMU sur une seule ligne (256 caractères maximum).');
    appendLog(session, `$ monitor: ${command}`);
    const output = await sendMonitorCommand(session, command);
    appendLog(session, output || '(aucune sortie)');
    res.json({ok: true, output});
  } catch (error) { res.status(400).json({error: error.message}); }
});

app.patch('/api/sessions/:sessionId', (req, res) => {
  try {
    const session = getSession(req.params.sessionId);
    const name = req.body && req.body.name;
    if (!session || !session.everStarted) throw new Error('Cette VM n’a pas encore démarré.');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Nom invalide (1 à 64 caractères).');
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
  socket.on('clear-console', id => {
    if (id !== socket.sessionId) return;
    const session = sessions.get(id);
    if (!session) return;
    session.serialBuffer = '';
    io.to(id).emit('serial-reset', {sessionId: id});
  });
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Le port ${port} est déjà utilisé. Arrêtez le serveur existant ou lancez avec PORT=${port + 1} npm start.`);
    process.exitCode = 1;
    return;
  }
  console.error('Erreur serveur :', error);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`Console de test : http://127.0.0.1:${port}`));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(1), 10000);
  await Promise.all([...sessions.values()].map(session => stop(session).catch(error => console.error('Arrêt VM :', error))));
  io.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
