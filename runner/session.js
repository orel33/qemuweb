'use strict';

// One session as the runner holds it: its engine, its nodes (hosts and switches) and its
// runtime directory (runtime/sessions/<id>/). The runner is the source of truth for all of
// it; the control plane only knows the session ID, its owner and its creation date, sent in
// session.create.
//
// Two files describe the session in its runtime directory:
//   session.json  the definition (engine, host and switch IDs), identical to the one in a ZIP archive;
//   meta.json     what only a live session has: its owner (the login) and its creation date.
// Archives never contain meta.json.
const fs = require('fs');
const path = require('path');
const {writeJsonAtomic} = require('../common/json-file');

const SESSION_ID = /^[0-9a-f]{16}$/;

class Session {
  constructor({runtimeRoot, id, engine = 'qemu', owner = null, createdAt = new Date().toISOString()}) {
    if (!SESSION_ID.test(id)) throw new Error('Invalid session ID.');
    this.runtimeRoot = runtimeRoot;
    this.id = id;
    this.owner = owner;
    this.createdAt = createdAt;
    this.runtimeDir = path.join(runtimeRoot, 'sessions', id);
    this.engine = engine;
    this.nodes = new Map();
    this.resourceSamples = new Map();
    this.previousProcessSamples = new Map();
    this.vboxMetricSetup = new Map();
  }

  get metadataFile() { return path.join(this.runtimeDir, 'session.json'); }

  get metaFile() { return path.join(this.runtimeDir, 'meta.json'); }

  saveMeta() {
    writeJsonAtomic(this.metaFile, {schemaVersion: 1, ...(this.owner ? {owner: this.owner} : {}), createdAt: this.createdAt});
  }

  saveMetadata(engine = this.engine) {
    writeJsonAtomic(this.metadataFile, this.metadata(engine));
  }

  // The definition of the session, as written to session.json.
  metadata(engine = this.engine) {
    const ids = kind => [...this.nodes.values()]
      .filter(node => node.kind === kind && node.hostname && (kind === 'switch' || node.selectedImage))
      .map(node => node.id).sort();
    return {schemaVersion: 4, engine, hosts: ids('host'), switches: ids('switch')};
  }

  // Removes the runtime directory when the session holds no node, keeping anything unexpected.
  removeIfEmpty() {
    if (this.nodes.size) return;
    try {
      for (const name of ['hosts', 'switches']) {
        try { fs.rmdirSync(path.join(this.runtimeDir, name)); }
        catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
      }
      if (fs.readdirSync(this.runtimeDir).some(name => !['session.json', 'meta.json'].includes(name))) return;
      const saved = JSON.parse(fs.readFileSync(this.metadataFile, 'utf8'));
      if (!Array.isArray(saved.hosts) || saved.hosts.length || !Array.isArray(saved.switches) || saved.switches.length) return;
      fs.rmSync(this.metaFile, {force: true});
      fs.unlinkSync(this.metadataFile);
      fs.rmdirSync(this.runtimeDir);
    } catch (_) { /* Keep incomplete sessions for inspection or later recovery. */ }
  }
}

module.exports = {Session, SESSION_ID};
