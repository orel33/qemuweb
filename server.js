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
const catalogPath = path.join(runtime, 'catalog.json');
const port = Number(process.env.PORT || 3002);
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const sessions = new Map();

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
      selectedImage: null,
      hostname: null,
      everStarted: false,
      stopping: false,
      action: null,
      runLog: [],
      serialBuffer: '',
      generation: 0
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

function catalog() {
  try { return JSON.parse(fs.readFileSync(catalogPath, 'utf8')); }
  catch (_) { return []; }
}

function imageById(id) {
  return catalog().find(image => image.id === id);
}

function hostnameForImage(image) {
  const defaults = {alpine: 'alpine', debian13: 'qemunet-demo', openwrt: 'OpenWrt'};
  return image.hostname || defaults[image.id] || image.id;
}

app.get('/api/images', (_req, res) => {
  res.json(catalog().map(image => ({id: image.id, label: image.label, description: image.description, login: image.login, network: image.network, hostname: hostnameForImage(image), hasDifferentialDisk: image.kind === 'raw'})));
});

app.get('/api/sessions', (_req, res) => {
  res.json([...sessions.values()].map(session => ({
    id: session.id,
    running: !!session.machine,
    hasLaunched: session.everStarted,
    engine: session.engine,
    imageId: session.selectedImage && session.selectedImage.id,
    hostname: session.hostname,
    hasDifferentialDisk: session.selectedImage && session.selectedImage.kind === 'raw',
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
      session.serialBuffer = (session.serialBuffer + text).slice(-65536);
      io.to(session.id).emit('serial', {sessionId: session.id, data: text});
    });
    connection.on('close', () => {
      if (session.serial === connection) session.serial = null;
      if (!session.stopping && session.machine) publishState(session, 'Console série déconnectée');
    });
    connection.on('error', error => console.error('serial:', error.message));
    connection.write('\r');
  });
  connection.once('error', () => setTimeout(() => connectSerial(session, attempt + 1, generation), 250));
}

function tempFile(session, name) {
  return path.join(runtime, `qemuweb-${process.pid}-${session.id}-${name}`);
}

function makeRunVdi(session, image) {
  const base = path.join(runtime, image.vdi || '');
  if (!fs.existsSync(base)) throw new Error(`Base VirtualBox ${image.label} absente ; exécuter bash prepare.sh.`);
  const vdi = tempFile(session, `${image.id}.vdi`);
  image.runFiles = [...(image.runFiles || []), vdi];
  vbox(session, ['createmedium', 'disk', '--filename', vdi, '--diffparent', base, '--format', 'VDI']);
  return vdi;
}

function qemuArgs(session, image) {
  const common = [
    '-machine', 'q35', '-accel', session.qemuAcceleration, '-m', String(image.memory), '-smp', '1',
    '-display', 'none', '-monitor', `unix:${session.monitorPath},server=on,wait=off`,
    '-chardev', `socket,id=serial0,path=${session.socketPath},server=on,wait=off`, '-serial', 'chardev:serial0'
  ];
  if (image.kind === 'iso') {
    return [...common, '-cdrom', path.join(runtime, image.iso), '-boot', 'order=d', '-nic', 'none'];
  }
  if (image.kind === 'raw') {
    const overlay = tempFile(session, `${image.id}-overlay.qcow2`);
    execLogged(session, 'qemu-img', ['create', '-f', 'qcow2', '-F', 'raw', '-b', path.join(runtime, image.disk), overlay], {stdio: 'pipe'});
    image.runFiles = [overlay];
    return [...common, '-drive', `file=${overlay},if=virtio,format=qcow2`, '-boot', 'order=c', '-nic', image.qemuNic || 'none'];
  }
  throw new Error(`Type d’image non pris en charge : ${image.kind}`);
}

function spawnQemu(session, image) {
  const virtualBoxRunning = [...sessions.values()].some(other => other.machine && other.engine === 'virtualbox');
  if (session.engine === 'qemu-tcg' || virtualBoxRunning) session.qemuAcceleration = 'tcg';
  else {
    try {
      fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
      session.qemuAcceleration = 'kvm';
    } catch (_) { session.qemuAcceleration = 'tcg'; }
  }
  const args = qemuArgs(session, image);
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
    cleanupRunFiles(session, image);
    try { fs.unlinkSync(session.socketPath); } catch (_) {}
    try { fs.unlinkSync(session.monitorPath); } catch (_) {}
    if (session.stopping) return;
    if (session.machine === child) session.machine = null;
    publishState(session, `QEMU arrêté (${code})`);
  });
}

function cleanupRunFiles(session, image) {
  for (const file of image.runFiles || []) { try { fs.unlinkSync(file); } catch (_) {} }
  image.runFiles = [];
}

function vbox(session, args) {
  return execLogged(session, 'VBoxManage', args, {stdio: 'pipe'});
}

function spawnVirtualBox(session, image) {
  let diskPath;
  const vmDir = tempFile(session, 'vbox-vm');
  fs.mkdirSync(vmDir, {recursive: true});
  try {
    vbox(session, ['createvm', '--name', session.vmName, '--basefolder', vmDir, '--ostype', image.vboxType || 'Linux_64', '--register']);
    vbox(session, ['modifyvm', session.vmName, '--memory', String(image.memory), '--cpus', '1', '--nic1', image.vboxNic || 'none', '--uart1', '0x3F8', '4', '--uartmode1', 'server', session.socketPath]);
    if (image.kind === 'iso') {
      vbox(session, ['storagectl', session.vmName, '--name', 'IDE', '--add', 'ide']);
      vbox(session, ['storageattach', session.vmName, '--storagectl', 'IDE', '--port', '0', '--device', '0', '--type', 'dvddrive', '--medium', path.join(runtime, image.iso)]);
      vbox(session, ['modifyvm', session.vmName, '--boot1', 'dvd', '--boot2', 'none', '--boot3', 'none', '--boot4', 'none']);
    } else if (image.kind === 'raw') {
      image.runFiles = [];
      diskPath = makeRunVdi(session, image);
      vbox(session, ['storagectl', session.vmName, '--name', 'SATA', '--add', 'sata', '--controller', 'IntelAhci']);
      vbox(session, ['storageattach', session.vmName, '--storagectl', 'SATA', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', diskPath]);
      vbox(session, ['modifyvm', session.vmName, '--boot1', 'disk', '--boot2', 'dvd', '--boot3', 'none', '--boot4', 'none']);
    } else {
      throw new Error(`Type d’image VirtualBox non pris en charge : ${image.kind}`);
    }
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
  if (!image) throw new Error('Image inconnue. Exécuter bash prepare.sh pour préparer le catalogue des systèmes.');
  const needed = image.kind === 'iso' ? image.iso : image.disk;
  if (!fs.existsSync(path.join(runtime, needed))) throw new Error(`Image ${image.label} absente ; exécuter bash prepare.sh.`);
  if (selectedEngine === 'virtualbox' && image.kind === 'raw' && !fs.existsSync(path.join(runtime, image.vdi || ''))) throw new Error(`Base VirtualBox ${image.label} absente ; exécuter bash prepare.sh.`);
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
  session.hostname = hostnameForImage(image);
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
      else resolve();
    }
    monitor.on('data', data => {
      output += data.toString('utf8');
      if (!sent && output.includes('(qemu)')) {
        sent = true;
        output = '';
        monitor.write(`${command}\n`, error => { if (error) finish(error); });
      } else if (sent && output.includes('(qemu)')) finish();
    });
    monitor.once('error', finish);
    monitor.once('close', () => { if (!settled) finish(new Error('Connexion au moniteur QEMU interrompue.')); });
  });
}

async function reboot(session) {
  if (!session || !session.everStarted) throw new Error('Cette machine n’a pas encore démarré.');
  if (!session.machine) throw new Error('La VM est arrêtée ; utilise Reset pour repartir de l’image de base.');
  if (session.action) throw new Error('Une action est déjà en cours sur cette VM.');
  session.action = 'reboot';
  try {
    if (session.engine.startsWith('qemu')) appendLog(session, '$ QEMU monitor: system_reset');
    session.serialBuffer = '';
    io.to(session.id).emit('serial-reset', {sessionId: session.id});
    publishState(session, 'Redémarrage…');
    if (session.engine.startsWith('qemu')) await sendMonitorCommand(session, 'system_reset');
    else vbox(session, ['controlvm', session.vmName, 'reset']);
    publishState(session);
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
  try {
    publishState(session, 'Réinitialisation depuis l’image de base…');
    if (session.machine) await stop(session);
    session.everStarted = false;
    start(session.id, engine, imageId, {reset: true});
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

app.post('/api/start', (req, res) => {
  try {
    const session = start(req.body.sessionId, req.body.engine, req.body.imageId || 'alpine');
    res.json({ok: true, sessionId: session.id});
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

app.delete('/api/sessions/:sessionId', async (req, res) => {
  try {
    const session = getSession(req.params.sessionId);
    if (session) {
      if (session.action) throw new Error('Attends la fin de l’action en cours avant de fermer cette machine.');
      await stop(session);
      sessions.delete(session.id);
    }
    res.json({ok: true});
  } catch (error) { res.status(500).json({error: error.message}); }
});

io.on('connection', socket => {
  socket.on('select-session', id => {
    try {
      if (socket.sessionId) socket.leave(socket.sessionId);
      const session = getSession(id, true);
      socket.sessionId = session.id;
      socket.join(session.id);
      socket.emit('session-snapshot', {
        sessionId: session.id,
        state: {running: !!session.machine, message: stateMessage(session), hasLaunched: session.everStarted},
        logs: session.runLog,
        serial: session.serialBuffer
      });
    } catch (error) { socket.emit('session-error', error.message); }
  });
  socket.on('input', data => {
    const session = socket.sessionId && sessions.get(socket.sessionId);
    if (session && session.serial && typeof data === 'string') session.serial.write(data);
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
