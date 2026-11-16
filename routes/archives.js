'use strict';

// Session ZIP archive: size estimate, export, base image check and import.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {writeJsonAtomic} = require('../common/json-file');
const {writeArchive, readArchive} = require('../lib/session-archive');
const {createSessionSnapshot} = require('../lib/session-snapshot');

function register({app, session, runner, commands, emit}) {
  const {imageById, imagePath, fileSha256Async, stop, stopSwitch, startSwitch, start, publishState, appendLog} = runner;
  const {archiveSources, validateArchiveSession, installArchive, archivedSessionFiles} = createSessionSnapshot({session, runner, commands, emit});

  const MAX_SESSION_ARCHIVE = 0xffffffff;
  app.get('/api/session-archive/estimate', (req, res) => {
    try {
      const includeDisks = req.query.includeDisks === 'true';
      const {hosts, switches, logicalBytes, allocatedBytes, estimatedBytes: bytes, runningHosts} = archiveSources(includeDisks, includeDisks);
      res.set('Cache-Control', 'no-store');
      res.json({bytes, logicalBytes, allocatedBytes, hosts: hosts.length, switches: switches.length, includeDisks, runningHosts,
        hasWorkingDisks: hosts.some(item => item.disk), format: 'qemuweb-session-v4.zip'});
    } catch (error) { res.status(400).json({error: error.message}); }
  });
  app.post('/api/session-archive/export', async (req, res) => {
    session.archiveBusy = true;
    const exportName = `.session-export-${crypto.randomBytes(8).toString('hex')}`;
    const archive = path.join(session.runtimeDir, `${exportName}.zip`);
    const exportFiles = [];
    try {
      const includeDisks = req.body?.includeDisks;
      const prepared = archiveSources(includeDisks, includeDisks);
      if (includeDisks) {
        for (const host of session.nodes.values()) if (host.kind === 'host' && host.machine) {
          try { await stop(host, {forceOnTimeout: false}); }
          catch (error) { throw new Error(`Cannot power off ${host.hostname}: ${error.message}. Hosts already stopped remain stopped.`); }
        }
        for (const sw of session.nodes.values()) if (sw.kind === 'switch' && sw.machine) {
          try { await stopSwitch(sw); }
          catch (error) { throw new Error(`Cannot stop ${sw.hostname}: ${error.message}. Instances already stopped remain stopped.`); }
        }
      }
      const {sources, hosts} = includeDisks ? archiveSources(includeDisks) : prepared;
      // session.json is the definition of the session, as it is: nothing in it is specific to the live session.
      session.saveMetadata();
      // A host with a working disk records the identity of the base image that disk depends on, in its host.json.
      const format = session.engine === 'vbox' ? 'vdi' : 'raw';
      const exportSources = [];
      for (const item of sources) {
        const host = hosts.find(entry => item.name === `${entry.id}/host.json`);
        if (host?.disk) {
          const file = path.join(session.runtimeDir, `${exportName}.${host.id}.json`);
          exportFiles.push(file);
          const baseImage = {format, ...await fileSha256Async(imagePath(imageById(host.system).images[format]))};
          writeJsonAtomic(file, {...JSON.parse(fs.readFileSync(item.file, 'utf8')), baseImage});
          exportSources.push({...item, file});
        } else exportSources.push(item);
      }
      await writeArchive(archive, exportSources);
      res.set('Cache-Control', 'no-store');
      // The temporary archive is dot-prefixed; sendFile ignores dotfiles by default.
      res.download(archive, 'qemuweb-session-v4.zip', {dotfiles: 'allow'}, error => {
        session.archiveBusy = false;
        fs.rmSync(archive, {force: true});
        for (const file of exportFiles) fs.rmSync(file, {force: true});
        if (error && !res.headersSent) res.status(500).json({error: error.message});
      });
    } catch (error) { session.archiveBusy = false; fs.rmSync(archive, {force: true}); for (const file of exportFiles) fs.rmSync(file, {force: true}); res.status(400).json({error: error.code === 'ENOSPC' ? 'Insufficient disk space to save session archive.' : error.message}); }
  });
  // Lets the load dialog warn before upload: returns the systems whose current base image
  // differs from the identity recorded for them (by the hosts that have a working disk).
  app.post('/api/session-archive/check', async (req, res) => {
    try {
      const {engine, baseImages} = req.body || {};
      if (!['qemu', 'vbox'].includes(engine) || !baseImages || typeof baseImages !== 'object' || Array.isArray(baseImages)) throw new Error('Invalid archived session.');
      const format = engine === 'vbox' ? 'vdi' : 'raw', changed = [];
      for (const [id, expected] of Object.entries(baseImages)) {
        const image = imageById(id);
        if (!image || !expected || expected.format !== format) { changed.push(id); continue; }
        const actual = await fileSha256Async(imagePath(image.images[format]));
        if (actual.size !== expected.size || actual.sha256 !== expected.sha256) changed.push(id);
      }
      res.set('Cache-Control', 'no-store');
      res.json({changed});
    } catch (error) { res.status(400).json({error: error.message}); }
  });
  app.post('/api/session-archive/import', async (req, res) => {
    session.archiveBusy = true;
    const upload = path.join(session.runtimeDir, `.session-upload-${crypto.randomBytes(8).toString('hex')}.zip`);
    let stage;
    try {
      const autoStart = req.query.autoStart === 'true';
      if (req.query.autoStart !== undefined && !['true', 'false'].includes(req.query.autoStart)) throw new Error('Invalid automatic start option.');
      const discardStaleDisks = req.query.discardStaleDisks === 'true';
      if (req.query.discardStaleDisks !== undefined && !['true', 'false'].includes(req.query.discardStaleDisks)) throw new Error('Invalid working disk option.');
      stage = fs.mkdtempSync(path.join(session.runtimeDir, '.session-import-'));
      if (session.nodes.size) throw new Error('Load requires an empty session.');
      if (req.headers['content-type'] !== 'application/zip') throw new Error('Choose a QemuWeb ZIP archive.');
      const available = fs.statfsSync(session.runtimeDir);
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > 0 && declared + 64 * 1024 * 1024 > available.bavail * available.bsize) throw new Error('Insufficient disk space for session archive upload.');
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(upload, {flags: 'wx', mode: 0o600});
        let size = 0;
        req.on('data', chunk => { size += chunk.length; if (size > MAX_SESSION_ARCHIVE) req.destroy(new Error('Session archive exceeds ZIP total size limit (4 GiB).')); });
        req.on('error', reject); out.on('error', reject); out.on('finish', resolve); req.pipe(out);
      });
      if (session.nodes.size) throw new Error('Load requires an empty session.');
      const files = await readArchive(upload, stage);
      const snapshot = archivedSessionFiles(stage, files);
      const warnings = await validateArchiveSession(snapshot, stage, {discardStaleDisks});
      installArchive(snapshot, stage);
      const startErrors = [];
      if (autoStart) {
        for (const entry of [...snapshot.switches, ...snapshot.hosts]) {
          const node = session.nodes.get(entry.id);
          try {
            if (node.kind === 'switch') await startSwitch(node);
            else start(node.id, node.engine, node.selectedImage.id, {
              interfaces: node.networkInterfaces.map(nic => nic.switchId)
            });
          } catch (error) {
            const message = `Start failed: ${error.message}`;
            startErrors.push(`${node.hostname}: ${error.message}`);
            publishState(node, message);
          }
        }
      }
      // Log after automatic starts, which reset the run log of fresh hosts.
      for (const warning of warnings) {
        for (const id of warning.hosts) { const node = session.nodes.get(id); if (node) appendLog(node, `# Warning: ${warning.message}`); }
      }
      res.json({ok: true, hosts: snapshot.hosts.length, switches: snapshot.switches.length, startErrors,
        warnings: warnings.map(warning => warning.message)});
    } catch (error) { res.status(error.message === 'Load requires an empty session.' ? 409 : 400).json({error: error.code === 'ENOSPC' ? 'Insufficient disk space to load session archive.' : error.message}); }
    finally { session.archiveBusy = false; fs.rmSync(upload, {force: true}); if (stage) fs.rmSync(stage, {recursive: true, force: true}); }
  });
}

module.exports = {register};
