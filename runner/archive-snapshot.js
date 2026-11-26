'use strict';

// Session snapshot logic behind ZIP archive export and import: what to archive,
// validation of an archive before it is installed, and installation into an empty session.
// ZIP reading and writing live in runner/archive-zip.js. Node operations go through the session
// runner (runner/session-runner.js).
const fs = require('fs');
const path = require('path');
const {entityKind} = require('../common/node-id');
const {SESSION_SCHEMA_VERSION, HOST_SCHEMA_VERSION, SWITCH_SCHEMA_VERSION} = require('../common/schema-versions');
const {validateLaunchSettings} = require('../common/launch-settings');
const {selectedProfile, validateHostConfig, resolveHostConfig, engines} = require('../common/system-config');
const {WORKING_DISKS} = require('./media/disks');
const {createArchiveDisks} = require('./archive-disks');
const {parseLayout} = require('../common/graphic-layout');

// session: runner/session.js Session; runner: runner/session-runner.js; commands: resolved executables;
// emit(event, payload): send to every browser of this session.
function createSessionSnapshot({session, runner, commands, emit}) {
  const {createNode, tempFile, startupDirectory, hostConfiguration, setNodeHostname, removeHostnameAlias,
    persistSwitchConfiguration, persistHostConfiguration, imageById, readConfig} = runner;
  const archiveDisks = createArchiveDisks({runner, commands});
  const isDiskName = name => /\/disk\.(?:qcow2|vdi)$/.test(name);
  const {readStartupFiles, validateStartupTemplate} = runner.media;

  function archiveSources(includeDisks, allowRunning = false) {
    if (typeof includeDisks !== 'boolean') throw new Error('Invalid working disk option.');
    const runningHosts = [...session.nodes.values()].filter(item => item.kind === 'host' && item.machine);
    if (includeDisks && [...session.nodes.values()].some(item => item.kind === 'host' && item.action)) {
      throw new Error('Wait for the current host action to finish before saving working disks.');
    }
    if (includeDisks && !allowRunning && runningHosts.length) {
      throw new Error('Stop every host before saving working disks.');
    }
    const all = [...session.nodes.values()];
    const sources = [{name: 'session.json', file: session.metadataFile}];
    // The node positions of the Graphic view, when there are any (layout.json is then up to date).
    if (session.positions.size) sources.push({name: 'layout.json', file: session.layoutFile});
    const switches = all.filter(item => item.kind === 'switch').map(item => {
      sources.push({name: `${item.id}/switch.json`, file: tempFile(item, 'switch.json')});
      return {id: item.id, name: item.hostname};
    });
    const hosts = all.filter(item => item.kind === 'host').map(item => {
      sources.push({name: `${item.id}/host.json`, file: tempFile(item, 'host.json')});
      const media = readStartupFiles(startupDirectory(item));
      const startup = path.join(item.runtimeDir, 'startup');
      if (fs.existsSync(path.join(startup, 'start.sh'))) sources.push({name: `${item.id}/startup/start.sh`, file: path.join(startup, 'start.sh')});
      for (const resource of media.resources) sources.push({name: `${item.id}/startup/${resource.path}`, file: path.join(startup, resource.path)});
      // Every working disk the host owns, whichever engine is current: the formats of their base images.
      const disks = [];
      if (includeDisks) {
        for (const kind of WORKING_DISKS) {
          const file = tempFile(item, kind.file);
          if (!fs.existsSync(file)) continue;
          sources.push({name: `${item.id}/${kind.file}`, file});
          disks.push(kind.format);
        }
      }
      return {...hostConfiguration(item), disks};
    });
    let logicalBytes = 0, allocatedBytes = 0, estimatedBytes = 8192;
    for (const item of sources) {
      const stat = fs.lstatSync(item.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular archive file: ${item.name}`);
      if (isDiskName(item.name) && stat.size > 64 * 1024 * 1024 * 1024) throw new Error('Working disk size exceeds 64 GiB limit.');
      logicalBytes += stat.size;
      allocatedBytes += stat.blocks * 512;
      estimatedBytes += isDiskName(item.name)
        ? Math.ceil(stat.blocks * 512 * 1.05 + stat.size / 800)
        : stat.size;
      estimatedBytes += 200 + Buffer.byteLength(item.name);
    }
    if (logicalBytes > 256 * 1024 * 1024 * 1024) throw new Error('Session archive logical size exceeds 256 GiB limit.');
    return {sources, hosts, switches, logicalBytes, allocatedBytes, estimatedBytes, runningHosts: runningHosts.length};
  }

  async function validateArchiveSession(snapshot, stage, {discardDisks = false} = {}) {
    if (!['qemu', 'vbox'].includes(snapshot.engine) ||
        !Array.isArray(snapshot.hosts) || !Array.isArray(snapshot.switches)) {
      throw new Error('Invalid archived session.');
    }
    if (!runner.availableEngines.includes(snapshot.engine)) throw new Error('The archived session requires VirtualBox, which is unavailable on this server.');
    const ids = new Set(), names = new Set(), switches = new Set(), macs = new Set(), ports = new Set();
    const expectedFiles = new Set(['session.json', ...(snapshot.positions.size ? ['layout.json'] : [])]);
    for (const sw of snapshot.switches) {
      if (!sw || typeof sw !== 'object') throw new Error('Invalid switch entry.');
      entityKind(sw.id, 'switch');
      if (ids.has(sw.id) || typeof sw.name !== 'string' || !sw.name.trim() || sw.name.length > 64 || /[\x00-\x1f\x7f]/.test(sw.name) || names.has(sw.name.toLowerCase())) throw new Error('Invalid or duplicate switch identity.');
      ids.add(sw.id); switches.add(sw.id); names.add(sw.name.toLowerCase());
      expectedFiles.add(`${sw.id}/switch.json`);
    }
    for (const host of snapshot.hosts) {
      if (!host || typeof host !== 'object') throw new Error('Invalid host entry.');
      if (Object.keys(host).some(key => !['schemaVersion', 'id', 'name', 'system', 'config', 'network', 'baseImages', 'disks'].includes(key)) ||
          !host.network || Object.keys(host.network).some(key => key !== 'interfaces')) throw new Error('Unknown host configuration keyword.');
      entityKind(host.id, 'host');
      if (ids.has(host.id) || typeof host.name !== 'string' || !host.name.trim() || host.name.length > 64 || /[\x00-\x1f\x7f]/.test(host.name) || names.has(host.name.toLowerCase())) throw new Error('Invalid or duplicate host identity.');
      ids.add(host.id); names.add(host.name.toLowerCase());
      expectedFiles.add(`${host.id}/host.json`);
      if (host.schemaVersion !== HOST_SCHEMA_VERSION || !imageById(host.system)) throw new Error(`Unknown system for ${host.name}.`);
      const profiles = Object.fromEntries(engines.map(engine => [engine, selectedProfile(readConfig(), host.system, engine)]));
      try { validateHostConfig(host.config, profiles); }
      catch (error) { throw new Error(`Invalid configuration of ${host.name}: ${error.message}`, {cause: error}); }
      // What the host would use on the session engine of the archive.
      const values = resolveHostConfig(host.config, profiles[snapshot.engine], snapshot.engine);
      validateLaunchSettings({memory: values.memory, cpus: values.cpus, clock: values.clock, serialPorts: values.serialPorts});
      if (typeof values.startupDiskEnabled !== 'boolean' || !Array.isArray(host.disks) ||
          !host.network || !Array.isArray(host.network.interfaces) || host.network.interfaces.length > 4) throw new Error(`Invalid host configuration: ${host.name}.`);
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
      if (values.startupDiskEnabled) validateStartupTemplate(media.script, host.network.interfaces, true);
      for (const kind of WORKING_DISKS) if (host.disks.includes(kind.format)) expectedFiles.add(`${host.id}/${kind.file}`);
    }
    const warnings = await archiveDisks.checkDisks(snapshot, stage, {discardDisks});
    for (const file of snapshot.files) {
      const match = /^(h-[0-9a-f]{8})\/startup\/(.+)$/.exec(file);
      if (match && ids.has(match[1])) { expectedFiles.add(file); continue; }
      if (!expectedFiles.has(file)) throw new Error(`Unexpected session archive file: ${file}`);
    }
    if (snapshot.files.length !== expectedFiles.size || snapshot.files.some(file => !expectedFiles.has(file))) throw new Error('Missing session archive files.');
    archiveDisks.verifyDisks(snapshot, stage);
    return warnings;
  }

  function installArchive(snapshot, stage) {
    if (session.nodes.size) throw new Error('Load requires an empty session.');
    const oldEngine = session.engine, moved = [], created = [];
    const entries = [...snapshot.switches, ...snapshot.hosts];
    for (const entry of entries) if (fs.existsSync(path.join(session.runtimeDir, entry.id))) throw new Error(`Runtime directory already exists: ${entry.id}.`);
    try {
      for (const entry of entries) {
        const source = path.join(stage, entry.id);
        fs.mkdirSync(source, {recursive: true});
        const target = path.join(session.runtimeDir, entry.id);
        fs.renameSync(source, target); moved.push({source, target});
      }
      session.engine = snapshot.engine;
      session.positions = new Map(snapshot.positions);
      for (const entry of snapshot.switches) {
        const item = createNode(entry.id, 'switch', {existingDir: true}); created.push(item);
        setNodeHostname(item, entry.name); item.lastMessage = 'VDE switch stopped';
        persistSwitchConfiguration(item);
      }
      for (const entry of snapshot.hosts) {
        const item = createNode(entry.id, 'host', {existingDir: true}); created.push(item);
        item.selectedImage = imageById(entry.system); item.engine = snapshot.engine;
        // The config keeps the settings of both engines; the node uses those of the session engine,
        // and the working disk of that engine (the other engine's disk stays in its directory).
        item.hostConfig = entry.config;
        runner.selectEngine(item, snapshot.engine);
        item.networkInterfaces = entry.network.interfaces;
        item.guestMedia = readStartupFiles(startupDirectory(item));
        setNodeHostname(item, entry.name);
        persistHostConfiguration(item);
      }
      // The session writes its own session.json and layout.json instead of copying the archive's.
      session.saveMetadata();
      session.saveLayout();
    } catch (error) {
      for (const item of created.reverse()) { try { removeHostnameAlias(item); } catch (_) {} session.nodes.delete(item.id); }
      for (const {source, target} of moved.reverse()) { try { fs.renameSync(target, source); } catch (_) {} }
      session.engine = oldEngine;
      session.positions = new Map();
      try { session.saveMetadata(oldEngine); session.saveLayout(); } catch (_) {}
      throw error;
    }
    emit('general-settings-changed', {sessionId: session.id, engine: session.engine});
    emit('nodes-changed', {nodeId: null});
    // The loaded layout replaces what the pages show.
    emit('graphic-layout', {positions: Object.fromEntries(session.positions)});
  }

  function archivedSessionFiles(stage, paths) {
    const metadata = JSON.parse(fs.readFileSync(path.join(stage, 'session.json'), 'utf8'));
    if (metadata.schemaVersion !== SESSION_SCHEMA_VERSION || !['qemu', 'vbox'].includes(metadata.engine) ||
        Object.keys(metadata).some(key => !['schemaVersion', 'engine', 'hosts', 'switches'].includes(key)) ||
        !Array.isArray(metadata.hosts) || !Array.isArray(metadata.switches)) {
      throw new Error('Invalid session.json in archive.');
    }
    const ids = [...metadata.hosts, ...metadata.switches];
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate node entity ID.');
    const readEntity = (id, kind) => {
      entityKind(id, kind);
      const file = path.join(stage, id, kind === 'host' ? 'host.json' : 'switch.json');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.id !== id || data.schemaVersion !== (kind === 'host' ? HOST_SCHEMA_VERSION : SWITCH_SCHEMA_VERSION)) throw new Error(`Invalid configuration for ${id}.`);
      if (kind === 'switch' && (data.kind !== 'vde' ||
          Object.keys(data).some(key => !['schemaVersion', 'id', 'name', 'kind'].includes(key)))) {
        throw new Error(`Invalid switch configuration for ${id}.`);
      }
      return data;
    };
    const hosts = metadata.hosts.map(id => {
      const data = readEntity(id, 'host');
      if (Object.hasOwn(data, 'disks')) throw new Error(`Invalid configuration for ${id}.`);
      return {...data, disks: WORKING_DISKS.filter(kind => paths.includes(`${id}/${kind.file}`)).map(kind => kind.format)};
    });
    const switches = metadata.switches.map(id => readEntity(id, 'switch'));
    // layout.json is optional: without it the loaded session has no position (automatic layout).
    const positions = paths.includes('layout.json')
      ? parseLayout(JSON.parse(fs.readFileSync(path.join(stage, 'layout.json'), 'utf8')), ids) : new Map();
    return {engine: metadata.engine, hosts, switches, positions, files: paths};
  }

  return {archiveSources, validateArchiveSession, installArchive, archivedSessionFiles};
}

module.exports = {createSessionSnapshot};
