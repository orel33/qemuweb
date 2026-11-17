'use strict';

// Session snapshot logic behind ZIP archive export and import: what to archive,
// validation of an archive before it is installed, and installation into an empty session.
// ZIP reading and writing live in runner/archive-zip.js. Node operations go through the session
// runner (runner/session-runner.js).
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const {entityKind} = require('../common/node-id');
const {validateLaunchSettings} = require('../common/launch-settings');
const {selectedProfile, profileHash, validateOverrides} = require('../common/system-config');

// session: runner/session.js Session; runner: runner/session-runner.js; commands: resolved executables;
// emit(event, payload): send to every browser of this session.
function createSessionSnapshot({session, runner, commands, emit}) {
  const {createNode, tempFile, startupDirectory, hostConfiguration, setNodeHostname, removeHostnameAlias,
    persistSwitchConfiguration, persistHostConfiguration, imageById, readConfig, imagePath, qemuOptionsFor, fileSha256Async} = runner;
  const {readStartupFiles, validateStartupTemplate} = runner.media;

  function archiveSources(includeDisks, allowRunning = false) {
    if (typeof includeDisks !== 'boolean') throw new Error('Invalid working disk option.');
    if (includeDisks && session.engine === 'vbox') throw new Error('VirtualBox working disk archives are not supported.');
    const runningHosts = [...session.nodes.values()].filter(item => item.kind === 'host' && item.machine);
    if (includeDisks && [...session.nodes.values()].some(item => item.kind === 'host' && item.action)) {
      throw new Error('Wait for the current host action to finish before saving working disks.');
    }
    if (includeDisks && !allowRunning && runningHosts.length) {
      throw new Error('Stop every host before saving working disks.');
    }
    const all = [...session.nodes.values()];
    const sources = [{name: 'session.json', file: session.metadataFile}];
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
      const disk = includeDisks && !!item.runDisk && fs.existsSync(item.runDisk);
      if (disk) {
        if (!item.engine.startsWith('qemu')) throw new Error('VirtualBox working disk archives are not supported.');
        sources.push({name: `${item.id}/disk.qcow2`, file: item.runDisk});
      }
      return {...hostConfiguration(item), disk};
    });
    let logicalBytes = 0, allocatedBytes = 0, estimatedBytes = 8192;
    for (const item of sources) {
      const stat = fs.lstatSync(item.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular archive file: ${item.name}`);
      if (item.name.endsWith('/disk.qcow2') && stat.size > 64 * 1024 * 1024 * 1024) throw new Error('QCOW2 logical size exceeds 64 GiB limit.');
      logicalBytes += stat.size;
      allocatedBytes += stat.blocks * 512;
      estimatedBytes += item.name.endsWith('/disk.qcow2')
        ? Math.ceil(stat.blocks * 512 * 1.05 + stat.size / 800)
        : stat.size;
      estimatedBytes += 200 + Buffer.byteLength(item.name);
    }
    if (logicalBytes > 256 * 1024 * 1024 * 1024) throw new Error('Session archive logical size exceeds 256 GiB limit.');
    return {sources, hosts, switches, logicalBytes, allocatedBytes, estimatedBytes, runningHosts: runningHosts.length};
  }

  async function validateArchiveSession(snapshot, stage, {discardDisks = false} = {}) {
    const warnings = [];
    if (!['qemu', 'vbox'].includes(snapshot.engine) ||
        !Array.isArray(snapshot.hosts) || !Array.isArray(snapshot.switches)) {
      throw new Error('Invalid archived session.');
    }
    if (!runner.availableEngines.includes(snapshot.engine)) throw new Error('The archived session requires VirtualBox, which is unavailable on this server.');
    const ids = new Set(), names = new Set(), switches = new Set(), macs = new Set(), ports = new Set();
    const expectedFiles = new Set(['session.json']);
    for (const sw of snapshot.switches) {
      if (!sw || typeof sw !== 'object') throw new Error('Invalid switch entry.');
      entityKind(sw.id, 'switch');
      if (ids.has(sw.id) || typeof sw.name !== 'string' || !sw.name.trim() || sw.name.length > 64 || /[\x00-\x1f\x7f]/.test(sw.name) || names.has(sw.name.toLowerCase())) throw new Error('Invalid or duplicate switch identity.');
      ids.add(sw.id); switches.add(sw.id); names.add(sw.name.toLowerCase());
      expectedFiles.add(`${sw.id}/switch.json`);
    }
    for (const host of snapshot.hosts) {
      if (!host || typeof host !== 'object') throw new Error('Invalid host entry.');
      if (Object.keys(host).some(key => !['schemaVersion', 'id', 'name', 'system', 'engine', 'profileHash', 'config', 'network', 'disk', 'baseImage'].includes(key)) ||
          !host.network || Object.keys(host.network).some(key => key !== 'interfaces')) throw new Error('Unknown host configuration keyword.');
      entityKind(host.id, 'host');
      if (ids.has(host.id) || typeof host.name !== 'string' || !host.name.trim() || host.name.length > 64 || /[\x00-\x1f\x7f]/.test(host.name) || names.has(host.name.toLowerCase())) throw new Error('Invalid or duplicate host identity.');
      ids.add(host.id); names.add(host.name.toLowerCase());
      expectedFiles.add(`${host.id}/host.json`);
      if (host.schemaVersion !== 3 || host.engine !== snapshot.engine || !imageById(host.system)) throw new Error(`Unknown system or engine for ${host.name}.`);
      const profile = selectedProfile(readConfig(), host.system, host.engine);
      if (host.profileHash !== profileHash(profile)) throw new Error(`System profile changed for ${host.name}; restore its original config.json or recreate the host.`);
      validateOverrides(host.config);
      if (Object.keys(host.config).some(key => host.config[key] === profile[key])) throw new Error(`Redundant host override for ${host.name}.`);
      validateLaunchSettings({memory: host.config.memory ?? profile.memory,
        cpus: host.config.cpus ?? profile.cpus, clock: host.config.clock ?? profile.clock});
      if (typeof (host.config.startupDiskEnabled ?? profile.startupDiskEnabled) !== 'boolean' || typeof host.disk !== 'boolean' ||
          !host.network || !Array.isArray(host.network.interfaces) || host.network.interfaces.length > 4 ||
          (host.disk && !snapshot.engine.startsWith('qemu'))) throw new Error(`Invalid host configuration: ${host.name}.`);
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
      if (host.config.startupDiskEnabled ?? profile.startupDiskEnabled) validateStartupTemplate(media.script, host.network.interfaces, true);
      if (host.disk) expectedFiles.add(`${host.id}/disk.qcow2`);
    }
    // discardDisks ignores every working disk of the archive: the hosts start from the current base images.
    if (discardDisks) {
      const withDisk = snapshot.hosts.filter(host => host.disk);
      for (const host of withDisk) {
        host.disk = false;
        fs.rmSync(path.join(stage, host.id, 'disk.qcow2'), {force: true});
      }
      if (withDisk.length) {
        warnings.push({hosts: withDisk.map(host => host.id),
          message: `Working disks of ${withDisk.map(host => host.name).join(', ')} were discarded and these hosts will start from the current base images.`});
      }
    }
    // A working disk only stores differences from the base image it was created on, so only hosts
    // with a disk carry that image's identity (their host.json "baseImage"). Hosts without a
    // working disk start from the current image, whatever the image the session was saved with:
    // base image builds are not reproducible, so a ZIP saved on another machine records another hash.
    const format = snapshot.engine === 'vbox' ? 'vdi' : 'raw';
    const identities = new Map();
    for (const host of snapshot.hosts.filter(item => item.disk)) {
      const expected = host.baseImage;
      if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
          Object.keys(expected).some(key => !['format', 'size', 'sha256'].includes(key)) ||
          !Number.isSafeInteger(expected.size) || !/^[0-9a-f]{64}$/.test(expected.sha256)) throw new Error(`Invalid base image identity for ${host.name}.`);
      if (expected.format !== format) throw new Error(`Base image format incompatible: ${host.system}.`);
      identities.set(host.id, expected);
    }
    const actualImages = new Map();
    for (const id of new Set(snapshot.hosts.filter(item => item.disk).map(item => item.system))) {
      actualImages.set(id, await fileSha256Async(imagePath(imageById(id).images[format])));
    }
    for (const id of actualImages.keys()) {
      const actual = actualImages.get(id);
      const stale = snapshot.hosts.filter(host => {
        const expected = host.system === id && host.disk && identities.get(host.id);
        return expected && (expected.size !== actual.size || expected.sha256 !== actual.sha256);
      });
      if (!stale.length) continue;
      if (!discardDisks) {
        throw new Error(`Base image ${id} changed since this session was saved; working disks of ${stale.map(host => host.name).join(', ')} cannot be reused. Enable "Discard working disks" to load the session without them.`);
      }
      for (const host of stale) {
        host.disk = false;
        fs.rmSync(path.join(stage, host.id, 'disk.qcow2'), {force: true});
      }
      warnings.push({system: id, hosts: snapshot.hosts.filter(host => host.system === id).map(host => host.id),
        message: `Base image ${id} changed since this session was saved; working disks of ${stale.map(host => host.name).join(', ')} were discarded and these hosts will start from the current image.`});
    }
    for (const file of snapshot.files) {
      const match = /^(h-[0-9a-f]{16})\/startup\/(.+)$/.exec(file);
      if (match && ids.has(match[1])) { expectedFiles.add(file); continue; }
      if (!expectedFiles.has(file)) throw new Error(`Unexpected session archive file: ${file}`);
    }
    if (snapshot.files.length !== expectedFiles.size || snapshot.files.some(file => !expectedFiles.has(file))) throw new Error('Missing session archive files.');
    for (const host of snapshot.hosts.filter(item => item.disk)) {
      const disk = path.join(stage, host.id, 'disk.qcow2');
      const info = JSON.parse(execFileSync(commands.QEMU_IMG, ['info', '--output=json', disk], {encoding: 'utf8', maxBuffer: 1024 * 1024}));
      const image = imageById(host.system);
      if (info.format !== 'qcow2' || info.encrypted || info['data-file'] || info['format-specific']?.data?.['data-file'] || info['format-specific']?.data?.['data-file-raw'] || info['backing-filename-format'] !== 'raw' ||
          !info['backing-filename'] || info['virtual-size'] !== identities.get(host.id).size) throw new Error(`Incompatible QCOW2 overlay for ${host.name}.`);
      execFileSync(commands.QEMU_IMG, ['rebase', '-u', '-f', 'qcow2', '-F', 'raw', '-b', imagePath(image.images.raw), disk], {maxBuffer: 1024 * 1024});
      execFileSync(commands.QEMU_IMG, ['check', '-f', 'qcow2', disk], {maxBuffer: 1024 * 1024});
    }
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
      for (const entry of snapshot.switches) {
        const item = createNode(entry.id, 'switch', {existingDir: true}); created.push(item);
        setNodeHostname(item, entry.name); item.lastMessage = 'VDE switch stopped';
        persistSwitchConfiguration(item);
      }
      for (const entry of snapshot.hosts) {
        const item = createNode(entry.id, 'host', {existingDir: true}); created.push(item);
        item.selectedImage = imageById(entry.system); item.engine = snapshot.engine;
        item.profileHash = entry.profileHash;
        const profile = selectedProfile(readConfig(), entry.system, entry.engine);
        item.launchSettings = validateLaunchSettings({memory: entry.config.memory ?? profile.memory,
          cpus: entry.config.cpus ?? profile.cpus, clock: entry.config.clock ?? profile.clock});
        item.networkInterfaces = entry.network.interfaces;
        item.guestIsoAttached = entry.config.startupDiskEnabled ?? profile.startupDiskEnabled;
        item.guestMedia = readStartupFiles(startupDirectory(item));
        item.runDisk = entry.disk ? tempFile(item, 'disk.qcow2') : null;
        item.everStarted = entry.disk;
        item.qemuOptions = entry.disk ? qemuOptionsFor(entry.system, item.launchSettings) : null;
        setNodeHostname(item, entry.name); item.lastMessage = entry.disk ? 'Host stopped; current disk kept' : 'Host stopped; ready to start';
        persistHostConfiguration(item);
      }
      // The session writes its own session.json instead of copying the archive's.
      session.saveMetadata();
    } catch (error) {
      for (const item of created.reverse()) { try { removeHostnameAlias(item); } catch (_) {} session.nodes.delete(item.id); }
      for (const {source, target} of moved.reverse()) { try { fs.renameSync(target, source); } catch (_) {} }
      session.engine = oldEngine;
      try { session.saveMetadata(oldEngine); } catch (_) {}
      throw error;
    }
    emit('general-settings-changed', {sessionId: session.id, engine: session.engine});
    emit('nodes-changed', {nodeId: null});
  }

  function archivedSessionFiles(stage, paths) {
    const metadata = JSON.parse(fs.readFileSync(path.join(stage, 'session.json'), 'utf8'));
    if (metadata.schemaVersion !== 4 || !['qemu', 'vbox'].includes(metadata.engine) ||
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
      if (data.id !== id || data.schemaVersion !== (kind === 'host' ? 3 : 2)) throw new Error(`Invalid configuration for ${id}.`);
      if (kind === 'switch' && (data.kind !== 'vde' ||
          Object.keys(data).some(key => !['schemaVersion', 'id', 'name', 'kind'].includes(key)))) {
        throw new Error(`Invalid switch configuration for ${id}.`);
      }
      return data;
    };
    const hosts = metadata.hosts.map(id => {
      const data = readEntity(id, 'host');
      return {...data, disk: paths.includes(`${id}/disk.qcow2`)};
    });
    const switches = metadata.switches.map(id => readEntity(id, 'switch'));
    return {engine: metadata.engine, hosts, switches, files: paths};
  }

  return {archiveSources, validateArchiveSession, installArchive, archivedSessionFiles};
}

module.exports = {createSessionSnapshot};
