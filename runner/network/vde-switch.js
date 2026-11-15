'use strict';

// VDE switch process and its management terminal (vdeterm over a pty).
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const pty = require('node-pty');
const {ctx} = require('../context');
const {shellQuote} = require('../../common/shell-quote');
const {appendLog, publishState} = require('../session-runtime');
const {linkedHosts} = require('./nics');
const {waitForChildExit} = require('../engines/child-exit');

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
  ctx.events.emit('serial-reset', {nodeId: node.id, serial: ''});
  const socketName = path.basename(node.mgmtPath);
  appendLog(node, `$ ${[ctx.commands.VDETERM, socketName].map(shellQuote).join(' ')}  # cwd=${shellQuote(node.runtimeDir)}`);
  const terminal = pty.spawn(ctx.commands.VDETERM, [socketName], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: node.runtimeDir,
    env: {...process.env, TERM: 'xterm-256color'}
  });
  node.switchTerminal = terminal;
  terminal.onData(data => {
    node.serialBuffer = (node.serialBuffer + data).slice(-262144);
    ctx.events.emit('serial', {nodeId: node.id, data});
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
  appendLog(node, `$ ${[ctx.commands.VDE_SWITCH, ...args].map(shellQuote).join(' ')}`);
  const child = spawn(ctx.commands.VDE_SWITCH, args, {stdio: ['pipe', 'pipe', 'pipe']});
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
    try { await waitForChildExit(child, 3000); }
    catch (_) { child.kill('SIGKILL'); try { await waitForChildExit(child, 3000); } catch (_) {} }
  }
  node.machine = null;
  try { fs.unlinkSync(node.mgmtPath); } catch (_) {}
  fs.rmSync(node.socketDir, {recursive: true, force: true});
  node.stopping = false;
  publishState(node, 'VDE switch stopped');
}

module.exports = {stopSwitchTerminal, startSwitchTerminal, startSwitch, stopSwitch};
