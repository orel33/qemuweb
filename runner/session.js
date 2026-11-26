'use strict';

// One session as the runner holds it: its engine, its nodes (hosts and switches) and its
// runtime directory (runtime/sessions/<id>/). The runner is the source of truth for all of
// it; the control plane only knows the session ID, its owner and its creation date, sent in
// session.create.
//
// Two files describe the session in its runtime directory:
//   session.json  the definition (engine, host and switch IDs), identical to the one in a ZIP archive;
//   meta.json     what only a live session has: its owner (the login) and its creation date;
//   layout.json   the node positions of the Graphic view (common/graphic-layout.js), only
//                 while one is set; carried by the archive like session.json.
// Archives never contain meta.json.
const fs = require('fs');
const path = require('path');
const {writeJsonAtomic} = require('../common/json-file');
const {SESSION_SCHEMA_VERSION} = require('../common/schema-versions');
const {layoutFile} = require('../common/graphic-layout');

const SESSION_ID = /^[0-9a-f]{8}$/;

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
    // nodeId -> {x, y}, mirrored in layout.json: positions of existing nodes only.
    this.positions = new Map();
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

  get layoutFile() { return path.join(this.runtimeDir, 'layout.json'); }

  // Writes layout.json from the positions, or removes it when there is none.
  saveLayout() {
    if (this.positions.size) writeJsonAtomic(this.layoutFile, layoutFile(this.positions));
    else fs.rmSync(this.layoutFile, {force: true});
  }

  // The position of a node of the session (already normalized).
  setPosition(nodeId, position) {
    if (!this.nodes.has(nodeId)) throw new Error('Unknown node.');
    this.positions.set(nodeId, position);
    this.saveLayout();
  }

  // Forgets the positions of nodes that no longer exist.
  prunePositions() {
    const before = this.positions.size;
    for (const id of this.positions.keys()) if (!this.nodes.has(id)) this.positions.delete(id);
    if (this.positions.size !== before) this.saveLayout();
  }

  // The definition of the session, as written to session.json.
  metadata(engine = this.engine) {
    const ids = kind => [...this.nodes.values()]
      .filter(node => node.kind === kind && node.hostname && (kind === 'switch' || node.selectedImage))
      .map(node => node.id).sort();
    return {schemaVersion: SESSION_SCHEMA_VERSION, engine, hosts: ids('host'), switches: ids('switch')};
  }

  // Removes the runtime directory when the session holds no node, keeping anything unexpected.
  removeIfEmpty() {
    if (!this.nodes.size) removeEmptySessionDirectory(this.runtimeDir);
  }
}

// Removes a session directory that holds nothing: no file at all, or only the definition of a session without host or
// switch (session.json, meta.json, layout.json and empty hosts/ and switches/ directories). Anything else is kept. Returns whether
// the directory was removed.
function removeEmptySessionDirectory(directory) {
  try {
    for (const name of ['hosts', 'switches']) {
      try { fs.rmdirSync(path.join(directory, name)); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
    }
    const files = fs.readdirSync(directory);
    if (!files.length) { fs.rmdirSync(directory); return true; }
    if (!files.includes('session.json') || files.some(name => !['session.json', 'meta.json', 'layout.json'].includes(name))) return false;
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'session.json'), 'utf8'));
    if (saved.schemaVersion !== SESSION_SCHEMA_VERSION) return false;
    if (!Array.isArray(saved.hosts) || saved.hosts.length || !Array.isArray(saved.switches) || saved.switches.length) return false;
    fs.rmSync(path.join(directory, 'meta.json'), {force: true});
    fs.rmSync(path.join(directory, 'layout.json'), {force: true});
    fs.unlinkSync(path.join(directory, 'session.json'));
    fs.rmdirSync(directory);
    return true;
  } catch (_) { return false; /* Keep incomplete sessions for inspection or later recovery. */ }
}

module.exports = {Session, SESSION_ID, removeEmptySessionDirectory};
