'use strict';

// Node records and per-node runtime directories: paths, hostname aliases, state and log publishing.
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const {ctx} = require('./context');
const {entityKind} = require('../common/node-id');
const {shellQuote} = require('../common/shell-quote');
const {writeJsonAtomic} = require('../common/json-file');
const {readStartupFiles} = require('./media/guest-media');

function sessionPaths(id, kind = 'host') {
  entityKind(id, kind);
  const runtimeDir = path.join(ctx.session.runtimeDir, id);
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
  return path.join(ctx.session.runtimeDir, node.kind === 'switch' ? 'switches' : 'hosts', component);
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
  if (!ctx.session.nodes.has(id) && create) {
    const paths = sessionPaths(id, kind);
    if (fs.existsSync(paths.runtimeDir) !== existingDir) throw new Error('Runtime directory state does not match this ID.');
    if (!existingDir) {
      fs.mkdirSync(paths.runtimeDir);
      if (kind === 'host') fs.mkdirSync(path.join(paths.runtimeDir, 'startup'));
    }
    ctx.session.nodes.set(id, {
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
  return ctx.session.nodes.get(id);
}

function tempFile(node, name) {
  return path.join(node.runtimeDir, name);
}

function startupDirectory(node) {
  return tempFile(node, 'startup');
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

function stateMessage(node) {
  if (!node.machine) return node.lastMessage || 'Stopped';
  if (node.kind === 'switch') return `VDE switch · ${node.hostname}`;
  if (node.engine.startsWith('qemu')) return `QEMU/${node.qemuAcceleration.toUpperCase()} · ${node.selectedImage.label}`;
  return `VirtualBox · ${node.selectedImage.label}`;
}

function publishState(node, message = stateMessage(node)) {
  node.lastMessage = message;
  const state = {nodeId: node.id, running: !!node.machine, hasLaunched: node.everStarted, pendingRestart: pendingRestart(node), message};
  ctx.events.emit('state', state);
}

function appendLog(node, message) {
  const line = String(message).replace(/\s+$/, '');
  if (!line) return;
  node.runLog.push(line);
  if (node.runLog.length > 1000) node.runLog.shift();
  ctx.events.emit('log', {nodeId: node.id, line});
}

function execLogged(node, command, args, options = {stdio: 'pipe'}) {
  appendLog(node, `$ ${[command, ...args].map(shellQuote).join(' ')}`);
  return execFileSync(command, args, options);
}

function listNodes() {
  return [...ctx.session.nodes.values()].map(node => ({
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
  }));
}

module.exports = {listNodes, sessionPaths, setNodeHostname, removeHostnameAlias, getNode, tempFile, startupDirectory, persistSwitchConfiguration, activeConfiguration, pendingRestart, stateMessage, publishState, appendLog, execLogged};
