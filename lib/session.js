'use strict';

// All state belonging to one workspace: its engine, its nodes (hosts and switches),
// and its runtime directory (runtime/sessions/<id>/ with session.json). The server owns a
// single instance for now. The runner receives this object by injection and uses its
// nodes, engine, runtimeDir, resource caches and saveMetadata().
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {writeJsonAtomic} = require('../common/json-file');

class Session {
  constructor({runtimeRoot, id = crypto.randomBytes(8).toString('hex'), engine = 'qemu', ephemeral = false}) {
    this.runtimeRoot = runtimeRoot;
    this.sessionsDir = path.join(runtimeRoot, 'sessions');
    this.currentLink = path.join(runtimeRoot, 'current');
    this.ephemeral = ephemeral;
    this.id = id;
    this.runtimeDir = path.join(this.sessionsDir, id);
    this.engine = engine;
    this.nodes = new Map();
    this.archiveBusy = false;
    this.resourceSamples = new Map();
    this.previousProcessSamples = new Map();
    this.vboxMetricSetup = new Map();
  }

  get metadataFile() { return path.join(this.runtimeDir, 'session.json'); }

  saveMetadata(engine = this.engine) {
    writeJsonAtomic(this.metadataFile, this.metadata(engine));
  }

  metadata(engine = this.engine) {
    const ids = kind => [...this.nodes.values()]
      .filter(node => node.kind === kind && node.hostname && (kind === 'switch' || node.selectedImage))
      .map(node => node.id).sort();
    return {schemaVersion: 4, engine, hosts: ids('host'), switches: ids('switch'), baseImages: {}};
  }

  pointCurrentSession(id) {
    const temporary = path.join(this.runtimeRoot, `.current-${this.id}`);
    try {
      fs.symlinkSync(path.join('sessions', id), temporary, 'dir');
      fs.renameSync(temporary, this.currentLink);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch (_) {}
      console.warn(`Cannot update runtime/current: ${error.message}`);
    }
  }

  linkCurrentSession() {
    if (!this.ephemeral) this.pointCurrentSession(this.id);
  }

  liveServerSessions() {
    const live = new Map();
    for (const name of fs.readdirSync(this.runtimeRoot)) {
      const match = /^server-(\d+)\.session$/.exec(name);
      if (!match) continue;
      try {
        const [id, kind] = fs.readFileSync(path.join(this.runtimeRoot, name), 'utf8').trimEnd().split('\n');
        if (!/^[0-9a-f]{16}$/.test(id) || !['regular', 'test'].includes(kind)) continue;
        const pid = Number(fs.readFileSync(path.join(this.runtimeRoot, `server-${match[1]}.pid`), 'utf8').trim());
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        process.kill(pid, 0);
        live.set(id, {pid, ephemeral: kind === 'test'});
      } catch (_) { /* Ignore stale or incomplete server records. */ }
    }
    return live;
  }

  removeCurrentSessionLink() {
    if (this.ephemeral) return;
    try {
      if (fs.readlinkSync(this.currentLink) !== path.join('sessions', this.id)) return;
      const live = this.liveServerSessions();
      const fallback = fs.readdirSync(this.sessionsDir).filter(name => /^[0-9a-f]{16}$/.test(name) && name !== this.id && live.has(name) && !live.get(name).ephemeral)
        .map(name => {
          try {
            return {name, started: fs.statSync(path.join(this.sessionsDir, name)).birthtimeMs};
          } catch (_) { return null; }
        }).filter(Boolean).sort((a, b) => b.started - a.started)[0];
      if (fallback) this.pointCurrentSession(fallback.name);
      else fs.unlinkSync(this.currentLink);
    } catch (error) { if (error.code !== 'ENOENT') console.warn(`Cannot remove runtime/current: ${error.message}`); }
  }

  removeEmptyRuntimeSession() {
    if (this.nodes.size) return;
    try {
      for (const name of ['hosts', 'switches']) {
        try { fs.rmdirSync(path.join(this.runtimeDir, name)); }
        catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
      }
      if (fs.readdirSync(this.runtimeDir).some(name => name !== 'session.json')) return;
      const saved = JSON.parse(fs.readFileSync(this.metadataFile, 'utf8'));
      if (!Array.isArray(saved.hosts) || saved.hosts.length || !Array.isArray(saved.switches) || saved.switches.length) return;
      fs.unlinkSync(this.metadataFile);
      fs.rmdirSync(this.runtimeDir);
    } catch (_) { /* Keep incomplete sessions for inspection or later recovery. */ }
  }

  pruneEmptyRuntimeSessions() {
    const liveSessions = this.liveServerSessions();
    let removed = 0;
    for (const name of fs.readdirSync(this.sessionsDir)) {
      if (!/^[0-9a-f]{16}$/.test(name)) continue;
      const directory = path.join(this.sessionsDir, name);
      try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs < 30000) continue;
        if (fs.readdirSync(directory).join() !== 'session.json') continue;
        const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'session.json'), 'utf8'));
        if (metadata.schemaVersion !== 4) continue;
        if (!Array.isArray(metadata.hosts) || metadata.hosts.length || !Array.isArray(metadata.switches) || metadata.switches.length) continue;
        if (liveSessions.has(name)) continue;
        fs.unlinkSync(path.join(directory, 'session.json'));
        fs.rmdirSync(directory);
        removed++;
      } catch (_) { /* Preserve unexpected runtime contents. */ }
    }
    if (removed) console.log(`Removed ${removed} empty runtime session${removed === 1 ? '' : 's'}.`);
  }
}

module.exports = {Session};
