'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const express = require('express');
const socketIo = require('socket.io');

const root = __dirname;
const runtime = path.join(root, 'runtime');
const socketPath = path.join(runtime, 'serial.sock');
const alpineIso = path.join(runtime, 'alpine-virt-3.24.3-x86_64.iso');
const vmName = `qemuweb-serial-${process.pid}`;
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

let machine = null;
let serial = null;
let engine = null;
let qemuAcceleration = null;
let stopping = false;

app.use(express.json());
app.use('/vendor', express.static(path.join(root, 'node_modules/xterm')));
app.use('/vendor-addon-fit', express.static(path.join(root, 'node_modules/xterm-addon-fit')));
app.use(express.static(path.join(root, 'public')));

function publishState(message) {
  io.emit('state', {running: !!machine, message});
}

function connectSerial(attempt = 0) {
  if (!machine || stopping || attempt > 100) return;
  const connection = net.createConnection(socketPath);
  connection.once('connect', () => {
    serial = connection;
    publishState(`${engine === 'qemu' ? `QEMU/${qemuAcceleration.toUpperCase()}` : 'VirtualBox'} démarrée · connectée à ttyS0`);
    connection.on('data', data => io.emit('serial', data.toString('utf8')));
    connection.on('close', () => {
      if (!stopping) publishState('Console série déconnectée');
    });
    connection.on('error', error => console.error('serial:', error.message));
  });
  connection.once('error', () => setTimeout(() => connectSerial(attempt + 1), 250));
}

function spawnQemu() {
  try {
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    qemuAcceleration = 'kvm';
  } catch (_) {
    qemuAcceleration = 'tcg';
  }
  const args = [
    '-machine', 'q35', '-accel', qemuAcceleration, '-m', '512', '-smp', '1',
    '-cdrom', alpineIso, '-boot', 'order=d',
    '-nic', 'none', '-display', 'none', '-monitor', 'none', '-no-reboot',
    '-chardev', `socket,id=serial0,path=${socketPath},server=on,wait=off`,
    '-serial', 'chardev:serial0'
  ];
  machine = spawn('qemu-system-x86_64', args, {stdio: ['ignore', 'pipe', 'pipe']});
  machine.stdout.on('data', data => console.log('qemu:', data.toString().trim()));
  machine.stderr.on('data', data => console.log('qemu:', data.toString().trim()));
  machine.once('exit', code => {
    if (stopping) return;
    machine = null;
    publishState(`QEMU arrêté (${code})`);
  });
}

function vbox(args) {
  execFileSync('VBoxManage', args, {stdio: 'pipe'});
}

function spawnVirtualBox() {
  if (!fs.existsSync(alpineIso)) throw new Error('ISO Alpine absente ; relancer prepare.sh.');
  try {
    vbox(['createvm', '--name', vmName, '--ostype', 'Linux26_64', '--register']);
    vbox(['modifyvm', vmName, '--memory', '512', '--cpus', '1', '--nic1', 'none', '--uart1', '0x3F8', '4', '--uartmode1', 'server', socketPath]);
    vbox(['storagectl', vmName, '--name', 'IDE', '--add', 'ide']);
    vbox(['storageattach', vmName, '--storagectl', 'IDE', '--port', '0', '--device', '0', '--type', 'dvddrive', '--medium', alpineIso]);
    vbox(['modifyvm', vmName, '--boot1', 'dvd', '--boot2', 'none', '--boot3', 'none', '--boot4', 'none']);
    vbox(['startvm', vmName, '--type', 'headless']);
    machine = {kind: 'virtualbox'};
  } catch (error) {
    try { vbox(['unregistervm', vmName, '--delete']); } catch (_) {}
    throw error;
  }
}

function start(selectedEngine) {
  if (machine) throw new Error('Une VM est déjà lancée.');
  if (!fs.existsSync(alpineIso)) throw new Error('ISO Alpine absente ; exécuter prepare.sh.');
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  stopping = false;
  engine = selectedEngine;
  if (engine === 'qemu') spawnQemu();
  else if (engine === 'virtualbox') spawnVirtualBox();
  else throw new Error('Moteur inconnu.');
  publishState(engine === 'qemu' ? `QEMU/${qemuAcceleration.toUpperCase()} en démarrage…` : 'VirtualBox en démarrage…');
  connectSerial();
}

async function stop() {
  if (!machine) return;
  stopping = true;
  if (serial) { serial.destroy(); serial = null; }
  const current = machine;
  machine = null;
  if (current.kind === 'virtualbox') {
    try { vbox(['controlvm', vmName, 'acpipowerbutton']); } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 3000));
    try { vbox(['controlvm', vmName, 'poweroff']); } catch (_) {}
    try { vbox(['unregistervm', vmName, '--delete']); } catch (error) { console.error(error.message); }
  } else {
    current.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (current.exitCode === null) current.kill('SIGKILL');
  }
  try { fs.unlinkSync(socketPath); } catch (_) {}
  stopping = false;
  publishState('VM arrêtée');
}

app.post('/api/start', (req, res) => {
  try { start(req.body.engine); res.json({ok: true}); }
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
  socket.emit('state', {running: !!machine, message: machine ? (engine === 'qemu' ? `QEMU/${qemuAcceleration.toUpperCase()} active` : 'VirtualBox active') : 'Arrêtée'});
  if (serial) serial.write('\r');
  socket.on('input', data => { if (serial && typeof data === 'string') serial.write(data); });
});

server.listen(3002, '127.0.0.1', () => console.log('Console de test : http://127.0.0.1:3002'));
process.on('SIGINT', async () => { await stop(); server.close(() => process.exit(0)); });
process.on('SIGTERM', async () => { await stop(); server.close(() => process.exit(0)); });
