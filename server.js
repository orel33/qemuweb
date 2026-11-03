'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const {spawn, execFileSync} = require('child_process');
const express = require('express');
const socketIo = require('socket.io');

const root = __dirname;
const runtime = path.join(root, 'runtime');
const socketPath = path.join(runtime, 'serial.sock');
const catalogPath = path.join(runtime, 'catalog.json');
const vmName = `qemuweb-serial-${process.pid}`;
const port = Number(process.env.PORT || 3002);
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

let machine = null;
let serial = null;
let engine = null;
let qemuAcceleration = null;
let selectedImage = null;
let stopping = false;
let runLog = [];

function shellQuote(value) {
  const text = String(value);
  return /^[a-zA-Z0-9_./:=,+-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\''`)}'`;
}

function appendLog(message) {
  const line = String(message).replace(/\s+$/, '');
  if (!line) return;
  runLog.push(line);
  if (runLog.length > 1000) runLog.shift();
  io.emit('log', line);
}

function execLogged(command, args, options = {stdio: 'pipe'}) {
  appendLog(`$ ${[command, ...args].map(shellQuote).join(' ')}`);
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

app.get('/api/logs', (_req, res) => res.json(runLog));

app.get('/api/images', (_req, res) => {
  res.json(catalog().map(({id, label, description, login, network}) => ({id, label, description, login, network})));
});

function publishState(message) {
  io.emit('state', {running: !!machine, message});
}

function connectSerial(attempt = 0) {
  if (!machine || stopping || attempt > 100) return;
  const connection = net.createConnection(socketPath);
  connection.once('connect', () => {
    serial = connection;
    publishState(`${engine === 'qemu' ? `QEMU/${qemuAcceleration.toUpperCase()}` : 'VirtualBox'} · ${selectedImage.label} · ttyS0`);
    connection.on('data', data => io.emit('serial', data.toString('utf8')));
    connection.on('close', () => {
      if (!stopping) publishState('Console série déconnectée');
    });
    connection.on('error', error => console.error('serial:', error.message));
  });
  connection.once('error', () => setTimeout(() => connectSerial(attempt + 1), 250));
}

function tempFile(name) {
  return path.join(runtime, `qemuweb-${process.pid}-${name}`);
}

function makeCloudSeed(image) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-cloudinit-'));
  const userData = path.join(dir, 'user-data');
  const metaData = path.join(dir, 'meta-data');
  const networkConfig = path.join(dir, 'network-config');
  const seedPath = tempFile('debian-seed.iso');
  const cloudConfig = `#cloud-config\nhostname: qemunet-demo\nmanage_etc_hosts: true\nssh_pwauth: true\nusers:\n  - default\n  - name: demo\n    groups: [sudo]\n    shell: /bin/bash\n    lock_passwd: false\nchpasswd:\n  expire: false\n  users:\n    - {name: demo, password: serial-demo, type: text}\nruncmd:\n  - [systemctl, enable, --now, serial-getty@ttyS0.service]\n`;
  fs.writeFileSync(userData, cloudConfig);
  fs.writeFileSync(metaData, `instance-id: qemunet-${process.pid}\nlocal-hostname: qemunet-demo\n`);
  fs.writeFileSync(networkConfig, 'version: 2\nethernets:\n  all-interfaces:\n    match:\n      name: "en*"\n    dhcp4: true\n');
  try {
    execLogged('genisoimage', ['-quiet', '-output', seedPath, '-volid', 'cidata', '-joliet', '-rock', userData, metaData, networkConfig], {stdio: 'pipe'});
    return seedPath;
  } catch (error) {
    try { fs.rmSync(seedPath, {force: true}); } catch (_) {}
    throw new Error(`Impossible de créer l’image cloud-init Debian (installer genisoimage). ${error.message}`);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

function makeRunVdi(image) {
  const source = path.join(runtime, image.disk);
  const vdi = tempFile(`${image.id}.vdi`);
  execLogged('qemu-img', ['convert', '-f', image.format, '-O', 'vdi', source, vdi], {stdio: 'pipe'});
  image.runFiles = [...(image.runFiles || []), vdi];
  return vdi;
}

function qemuArgs(image) {
  const common = [
    '-machine', 'q35', '-accel', qemuAcceleration, '-m', String(image.memory), '-smp', '1',
    '-display', 'none', '-monitor', 'none', '-no-reboot',
    '-chardev', `socket,id=serial0,path=${socketPath},server=on,wait=off`, '-serial', 'chardev:serial0'
  ];
  if (image.kind === 'iso') {
    return [...common, '-cdrom', path.join(runtime, image.iso), '-boot', 'order=d', '-nic', 'none'];
  }
  if (image.kind === 'cloud') {
    const overlay = tempFile('debian-overlay.qcow2');
    const seed = makeCloudSeed(image);
    execLogged('qemu-img', ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', path.join(runtime, image.disk), overlay], {stdio: 'pipe'});
    image.runFiles = [overlay, seed];
    return [...common, '-drive', `file=${overlay},if=virtio,format=qcow2`, '-drive', `file=${seed},media=cdrom,readonly=on`, '-boot', 'order=c', '-nic', 'user,restrict=on'];
  }
  if (image.kind === 'disk') {
    const overlay = tempFile(`${image.id}-overlay.qcow2`);
    execLogged('qemu-img', ['create', '-f', 'qcow2', '-F', image.format, '-b', path.join(runtime, image.disk), overlay], {stdio: 'pipe'});
    image.runFiles = [overlay];
    return [...common, '-drive', `file=${overlay},if=virtio,format=qcow2`, '-boot', 'order=c', '-nic', 'none'];
  }
  throw new Error(`Type d’image non pris en charge : ${image.kind}`);
}

function spawnQemu(image) {
  try {
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    qemuAcceleration = 'kvm';
  } catch (_) { qemuAcceleration = 'tcg'; }
  const args = qemuArgs(image);
  appendLog(`$ ${['qemu-system-x86_64', ...args].map(shellQuote).join(' ')}`);
  const child = spawn('qemu-system-x86_64', args, {stdio: ['ignore', 'pipe', 'pipe']});
  machine = child;
  child.stdout.on('data', data => { console.log('qemu:', data.toString().trim()); appendLog(data.toString()); });
  child.stderr.on('data', data => { console.log('qemu:', data.toString().trim()); appendLog(data.toString()); });
  child.once('error', error => {
    if (machine === child) { machine = null; cleanupRunFiles(image); publishState(`Erreur QEMU : ${error.message}`); }
  });
  child.once('exit', code => {
    cleanupRunFiles(image);
    if (stopping) return;
    if (machine === child) machine = null;
    publishState(`QEMU arrêté (${code})`);
  });
}

function cleanupRunFiles(image) {
  for (const file of image.runFiles || []) { try { fs.unlinkSync(file); } catch (_) {} }
  image.runFiles = [];
}

function vbox(args) {
  return execLogged('VBoxManage', args, {stdio: 'pipe'});
}

function spawnVirtualBox(image) {
  let diskPath;
  let seedPath;
  try {
    vbox(['createvm', '--name', vmName, '--ostype', image.vboxType || 'Linux_64', '--register']);
    vbox(['modifyvm', vmName, '--memory', String(image.memory), '--cpus', '1', '--nic1', image.kind === 'cloud' ? 'nat' : 'none', '--uart1', '0x3F8', '4', '--uartmode1', 'server', socketPath]);
    if (image.kind === 'iso') {
      vbox(['storagectl', vmName, '--name', 'IDE', '--add', 'ide']);
      vbox(['storageattach', vmName, '--storagectl', 'IDE', '--port', '0', '--device', '0', '--type', 'dvddrive', '--medium', path.join(runtime, image.iso)]);
      vbox(['modifyvm', vmName, '--boot1', 'dvd', '--boot2', 'none', '--boot3', 'none', '--boot4', 'none']);
    } else {
      image.runFiles = [];
      diskPath = makeRunVdi(image);
      vbox(['storagectl', vmName, '--name', 'SATA', '--add', 'sata', '--controller', 'IntelAhci']);
      vbox(['storageattach', vmName, '--storagectl', 'SATA', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', diskPath]);
      if (image.kind === 'cloud') {
        seedPath = makeCloudSeed(image);
        vbox(['storagectl', vmName, '--name', 'IDE', '--add', 'ide']);
        vbox(['storageattach', vmName, '--storagectl', 'IDE', '--port', '0', '--device', '0', '--type', 'dvddrive', '--medium', seedPath]);
        image.runFiles = [...image.runFiles, seedPath];
      }
      vbox(['modifyvm', vmName, '--boot1', 'disk', '--boot2', 'dvd', '--boot3', 'none', '--boot4', 'none']);
    }
    vbox(['startvm', vmName, '--type', 'headless']);
    machine = {kind: 'virtualbox'};
  } catch (error) {
    cleanupRunFiles(image);
    try { vbox(['unregistervm', vmName, '--delete']); } catch (_) {}
    throw error;
  }
}

function start(selectedEngine, imageId) {
  if (machine) throw new Error('Une VM est déjà lancée.');
  const image = imageById(imageId);
  if (!image) throw new Error('Image inconnue. Exécuter bash prepare.sh pour préparer le catalogue des systèmes.');
  const needed = image.kind === 'iso' ? image.iso : image.disk;
  if (!fs.existsSync(path.join(runtime, needed))) throw new Error(`Image ${image.label} absente ; exécuter bash prepare.sh.`);
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  stopping = false;
  runLog = [];
  io.emit('logs-reset');
  appendLog(`# ${selectedEngine} · ${image.label}`);
  engine = selectedEngine;
  selectedImage = image;
  if (engine === 'qemu') spawnQemu(image);
  else if (engine === 'virtualbox') spawnVirtualBox(image);
  else throw new Error('Moteur inconnu.');
  publishState(engine === 'qemu' ? `QEMU/${qemuAcceleration.toUpperCase()} en démarrage…` : `VirtualBox · ${image.label} en démarrage…`);
  connectSerial();
}

async function stop() {
  if (!machine) return;
  stopping = true;
  if (serial) { serial.destroy(); serial = null; }
  const current = machine;
  const image = selectedImage;
  machine = null;
  if (current.kind === 'virtualbox') {
    try { vbox(['controlvm', vmName, 'acpipowerbutton']); } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 3000));
    try { vbox(['controlvm', vmName, 'poweroff']); } catch (_) {}
    try { vbox(['unregistervm', vmName, '--delete']); } catch (error) { console.error(error.message); }
  } else {
    appendLog('$ signal envoyé à qemu-system-x86_64: SIGTERM');
    current.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (current.exitCode === null) current.kill('SIGKILL');
  }
  cleanupRunFiles(image || {});
  try { fs.unlinkSync(socketPath); } catch (_) {}
  stopping = false;
  publishState('VM arrêtée');
}

app.post('/api/start', (req, res) => {
  try { start(req.body.engine, req.body.imageId || 'alpine'); res.json({ok: true}); }
  catch (error) {
    machine = null;
    const message = error.stderr ? error.stderr.toString().trim() : error.message;
    console.error(message);
    res.status(500).json({error: message});
  }
});

app.post('/api/stop', async (_req, res) => {
  try { await stop(); res.json({ok: true}); }
  catch (error) { console.error(error); res.status(500).json({error: error.message}); }
});

io.on('connection', socket => {
  socket.emit('state', {running: !!machine, message: machine ? (engine === 'qemu' ? `QEMU/${qemuAcceleration.toUpperCase()}` : 'VirtualBox') : 'Arrêtée'});
  if (serial) serial.write('\r');
  socket.on('input', data => { if (serial && typeof data === 'string') serial.write(data); });
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
  const forceExit = setTimeout(() => process.exit(1), 5000);
  try { await stop(); }
  catch (error) { console.error('Arrêt de la VM :', error); }
  io.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
