'use strict';

// One workspace: its engine, its nodes (hosts and switches), and its runtime directory
// (runtime/sessions/<id>/ with session.json). Each user owns one session, created and
// tracked by lib/session-manager.js. The runner receives this object by injection and uses
// its id, nodes, engine, runtimeDir, resource caches and saveMetadata().
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {writeJsonAtomic} = require('../common/json-file');

class Session {
  constructor({runtimeRoot, id = crypto.randomBytes(8).toString('hex'), engine = 'qemu', owner = null}) {
    this.runtimeRoot = runtimeRoot;
    this.sessionsDir = path.join(runtimeRoot, 'sessions');
    this.id = id;
    this.owner = owner;
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

  // session.json of the runtime directory. `owner` (the login) exists only there: archive
  // exports strip it (see lib/session-snapshot.js).
  metadata(engine = this.engine) {
    const ids = kind => [...this.nodes.values()]
      .filter(node => node.kind === kind && node.hostname && (kind === 'switch' || node.selectedImage))
      .map(node => node.id).sort();
    return {schemaVersion: 4, engine, hosts: ids('host'), switches: ids('switch'),
      ...(this.owner ? {owner: this.owner} : {})};
  }

  // Removes the runtime directory when the session holds no node, keeping anything unexpected.
  removeIfEmpty() {
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
}

module.exports = {Session};
