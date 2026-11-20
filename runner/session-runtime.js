'use strict';

// Node records and per-node runtime directories: paths, hostname aliases, state and log publishing.
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const {entityKind} = require('../common/node-id');
const {NODE_FILES, SOCKET_LIMIT, runtimeTooLong} = require('../common/runtime-dir');
const {shellQuote} = require('../common/shell-quote');
const {writeJsonAtomic} = require('../common/json-file');
const {SWITCH_SCHEMA_VERSION} = require('../common/schema-versions');
const {readStartupFiles} = require('./media/guest-media');

function createSessionRuntime(ctx) {
  function sessionPaths(id, kind = 'host') {
    entityKind(id, kind);
    const runtimeDir = path.join(ctx.session.runtimeDir, id);
    const paths = {
      runtimeDir,
      // Node IDs are unique within a session only (an archive keeps them), so the
      // VirtualBox VM name, global to the machine, also carries the session ID.
      vmName: ctx.session.id ? `qemuweb-${process.pid}-${ctx.session.id}-${id}` : `qemuweb-${process.pid}-${id}`,
      socketPath: path.join(runtimeDir, NODE_FILES.serial0),
      socketPath1: path.join(runtimeDir, NODE_FILES.serial1),
      monitorPath: path.join(runtimeDir, NODE_FILES.monitor),
      socketDir: kind === 'switch' ? path.join(runtimeDir, NODE_FILES.vde) : null,
      mgmtPath: kind === 'switch' ? path.join(runtimeDir, NODE_FILES.mgmt) : null
    };
    const tooLong = [paths.socketPath, paths.socketPath1, paths.monitorPath, paths.mgmtPath].find(name => name && Buffer.byteLength(name) > SOCKET_LIMIT);
    if (tooLong) {
      // The startup check (prepareRuntime) refuses such a directory first; this is the net under it.
      throw new Error(runtimeTooLong(ctx.runtimeRoot || path.dirname(path.dirname(runtimeDir))) ||
        `Runtime socket path ${tooLong} is longer than ${SOCKET_LIMIT} bytes. Use a shorter --runtime.`);
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
        serial1: null,
        engine: null,
        qemuAcceleration: null,
        qemuOptions: null,
        launchSettings: null,
        // The sparse config of host.json (keys per engine, see common/system-config.js); launchSettings
        // and guestIsoAttached are its values resolved for the current engine.
        hostConfig: {},
        selectedImage: null,
        hostname: null,
        hostnameAliasPath: null,
        everStarted: false,
        stopping: false,
        action: null,
        runLog: [],
        serialBuffer: '',
        serialBuffer1: '',
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
    writeJsonAtomic(tempFile(node, 'switch.json'), {schemaVersion: SWITCH_SCHEMA_VERSION, id: node.id, name: node.hostname, kind: 'vde'});
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
      JSON.stringify(node.launchSettings.serialPorts) !== JSON.stringify(active.settings.serialPorts) ||
      JSON.stringify(node.networkInterfaces) !== JSON.stringify(active.networkInterfaces) ||
      JSON.stringify(readStartupFiles(startupDirectory(node))) !== JSON.stringify(active.guestMedia) ||
      node.guestIsoAttached !== active.startupDiskEnabled;
  }

  // Serial ports of the running VM (the configured ports while stopped; ttyS0 alone for VirtualBox).
  function serialPortsOf(node) {
    if (node?.kind !== 'host' || !node.launchSettings || !node.engine?.startsWith('qemu')) return ['ttyS0'];
    return (node.machine && node.activeConfig ? node.activeConfig.settings : node.launchSettings).serialPorts;
  }

  // Removes the console and monitor sockets QEMU leaves behind.
  function removeConsoleSockets(node) {
    for (const file of [node.socketPath, node.socketPath1, node.monitorPath]) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }

  function stateMessage(node) {
    if (!node.machine) return node.lastMessage || 'Stopped';
    if (node.kind === 'switch') return `VDE switch · ${node.hostname}`;
    if (node.engine.startsWith('qemu')) return `QEMU/${node.qemuAcceleration.toUpperCase()} · ${node.selectedImage.label}`;
    return `VirtualBox · ${node.selectedImage.label}`;
  }

  function publishState(node, message = stateMessage(node)) {
    node.lastMessage = message;
    const state = {nodeId: node.id, running: !!node.machine, hasLaunched: node.everStarted, pendingRestart: pendingRestart(node), serialPorts: serialPortsOf(node), message};
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
      serialPorts: serialPortsOf(node),
      hasDifferentialDisk: !!node.runDisk && fs.existsSync(node.runDisk),
      message: stateMessage(node)
    }));
  }

  return {listNodes, sessionPaths, setNodeHostname, removeHostnameAlias, getNode, tempFile, startupDirectory, persistSwitchConfiguration, activeConfiguration, pendingRestart, serialPortsOf, removeConsoleSockets, stateMessage, publishState, appendLog, execLogged};
}

module.exports = {createSessionRuntime};
