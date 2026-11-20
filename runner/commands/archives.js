'use strict';

// Session ZIP archive commands: size estimate, export, base image check and import. Each
// command receives {session, runner, commands, emit, io} (runner/service.js) and the request
// arguments. The ZIP travels as a protocol stream, never as a path: io.outgoing() sends the
// export to the control plane, io.incoming(id) receives the uploaded archive.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {Transform} = require('stream');
const {pipeline} = require('stream/promises');
const {writeJsonAtomic} = require('../../common/json-file');
const {writeArchive, readArchive} = require('../archive-zip');
const {createSessionSnapshot} = require('../archive-snapshot');
const {statusError} = require('./errors');

const MAX_SESSION_ARCHIVE = 0xffffffff;
const ARCHIVE_NAME = 'qemuweb-session.zip';

const snapshotOf = ({session, runner, commands, emit}) => createSessionSnapshot({session, runner, commands, emit});

const commands = {
  'archive.estimate': (context, {includeDisks}) => {
    const {hosts, switches, logicalBytes, allocatedBytes, estimatedBytes: bytes, runningHosts} = snapshotOf(context).archiveSources(includeDisks, includeDisks);
    return {bytes, logicalBytes, allocatedBytes, hosts: hosts.length, switches: switches.length, includeDisks, runningHosts,
      hasWorkingDisks: hosts.some(item => item.disks.length), format: ARCHIVE_NAME,
      // How many hosts carry a disk of each engine (the Save dialog says which engines' disks go in).
      workingDisks: {qemu: hosts.filter(item => item.disks.includes('raw')).length, vbox: hosts.filter(item => item.disks.includes('vdi')).length}};
  },

  // Builds the archive in the session directory, then sends it on a new stream once the
  // response {stream, size} is out. The temporary files go when the stream ends.
  'archive.export': async (context, {includeDisks}) => {
    const {session, runner, io} = context;
    const {archiveSources} = snapshotOf(context);
    const exportName = `.session-export-${crypto.randomBytes(8).toString('hex')}`;
    const archive = path.join(session.runtimeDir, `${exportName}.zip`);
    const exportFiles = [archive];
    const cleanup = () => { for (const file of exportFiles) fs.rmSync(file, {force: true}); };
    try {
      const prepared = archiveSources(includeDisks, includeDisks);
      if (includeDisks) {
        for (const host of session.nodes.values()) if (host.kind === 'host' && host.machine) {
          try { await runner.stop(host, {forceOnTimeout: false}); }
          catch (error) { throw new Error(`Cannot power off ${host.hostname}: ${error.message}. Hosts already stopped remain stopped.`); }
        }
        for (const sw of session.nodes.values()) if (sw.kind === 'switch' && sw.machine) {
          try { await runner.stopSwitch(sw); }
          catch (error) { throw new Error(`Cannot stop ${sw.hostname}: ${error.message}. Instances already stopped remain stopped.`); }
        }
      }
      const {sources, hosts} = includeDisks ? archiveSources(includeDisks) : prepared;
      // session.json is the definition of the session, as it is: nothing in it is specific to the live session.
      session.saveMetadata();
      // A host with working disks records, in its host.json, the identity of the base image each disk
      // depends on (raw for disk.qcow2, vdi for disk.vdi).
      const exportSources = [];
      for (const item of sources) {
        const host = hosts.find(entry => item.name === `${entry.id}/host.json`);
        if (host?.disks.length) {
          const file = path.join(session.runtimeDir, `${exportName}.${host.id}.json`);
          exportFiles.push(file);
          const baseImages = {};
          for (const format of host.disks) {
            const {size, sha256} = await runner.fileSha256Async(runner.imagePath(runner.imageById(host.system).images[format]));
            baseImages[format] = {size, sha256};
          }
          writeJsonAtomic(file, {...JSON.parse(fs.readFileSync(item.file, 'utf8')), baseImages});
          exportSources.push({...item, file});
        } else exportSources.push(item);
      }
      await writeArchive(archive, exportSources);
      const size = fs.statSync(archive).size;
      const {id, stream} = io.outgoing();
      io.afterResponse(() => pipeline(fs.createReadStream(archive), stream).catch(() => {}).finally(cleanup));
      return {stream: id, size};
    } catch (error) {
      cleanup();
      throw new Error(error.code === 'ENOSPC' ? 'Insufficient disk space to save session archive.' : error.message);
    }
  },

  // Lets the load dialog warn before upload: returns the systems for which a current base image
  // differs from the identity recorded for it (by the hosts that have a working disk).
  // body.baseImages: {<system>: {raw?: {size, sha256}, vdi?: {size, sha256}}}.
  'archive.check': async ({runner}, {body}) => {
    const {baseImages} = body || {};
    if (!baseImages || typeof baseImages !== 'object' || Array.isArray(baseImages)) throw new Error('Invalid archived session.');
    const changed = [];
    for (const [id, formats] of Object.entries(baseImages)) {
      const image = runner.imageById(id);
      if (!image || !formats || typeof formats !== 'object' || Array.isArray(formats) || Object.keys(formats).some(format => !['raw', 'vdi'].includes(format))) { changed.push(id); continue; }
      for (const [format, expected] of Object.entries(formats)) {
        let actual = null;
        try { actual = await runner.fileSha256Async(runner.imagePath(image.images[format])); } catch (_) { /* not installed */ }
        if (!expected || !actual || actual.size !== expected.size || actual.sha256 !== expected.sha256) { changed.push(id); break; }
      }
    }
    return {changed};
  },

  // Receives the uploaded ZIP on stream `stream` (query options and the declared size and
  // type of the HTTP upload are passed as they came), installs it into the empty session and
  // optionally starts it.
  'archive.import': async (context, {stream: streamId, query = {}, contentType, declaredBytes}) => {
    const {session, runner, io} = context;
    const upload = path.join(session.runtimeDir, `.session-upload-${crypto.randomBytes(8).toString('hex')}.zip`);
    const incoming = io.incoming(streamId);
    let stage;
    try {
      const autoStart = query.autoStart === 'true';
      if (query.autoStart !== undefined && !['true', 'false'].includes(query.autoStart)) throw new Error('Invalid automatic start option.');
      const discardDisks = query.discardDisks === 'true';
      if (query.discardDisks !== undefined && !['true', 'false'].includes(query.discardDisks)) throw new Error('Invalid working disk option.');
      stage = fs.mkdtempSync(path.join(session.runtimeDir, '.session-import-'));
      if (session.nodes.size) throw statusError('Load requires an empty session.', 409);
      if (contentType !== 'application/zip') throw new Error('Choose a QemuWeb ZIP archive.');
      const available = fs.statfsSync(session.runtimeDir);
      const declared = Number(declaredBytes);
      if (Number.isFinite(declared) && declared > 0 && declared + 64 * 1024 * 1024 > available.bavail * available.bsize) throw new Error('Insufficient disk space for session archive upload.');
      let size = 0;
      const limit = new Transform({transform(chunk, _encoding, callback) {
        size += chunk.length;
        callback(size > MAX_SESSION_ARCHIVE ? new Error('Session archive exceeds ZIP total size limit (4 GiB).') : null, chunk);
      }});
      await pipeline(incoming, limit, fs.createWriteStream(upload, {flags: 'wx', mode: 0o600}));
      if (session.nodes.size) throw statusError('Load requires an empty session.', 409);
      const {archivedSessionFiles, validateArchiveSession, installArchive} = snapshotOf(context);
      const files = await readArchive(upload, stage);
      const snapshot = archivedSessionFiles(stage, files);
      const warnings = await validateArchiveSession(snapshot, stage, {discardDisks});
      installArchive(snapshot, stage);
      // The session was empty: the loaded nodes are all of its nodes (same start as Resume all).
      const {startErrors} = autoStart ? await runner.startAllNodes() : {startErrors: []};
      // Log after automatic starts, which reset the run log of fresh hosts.
      for (const warning of warnings) {
        for (const id of warning.hosts) { const node = session.nodes.get(id); if (node) runner.appendLog(node, `# Warning: ${warning.message}`); }
      }
      return {ok: true, hosts: snapshot.hosts.length, switches: snapshot.switches.length, startErrors,
        warnings: warnings.map(warning => warning.message)};
    } catch (error) {
      throw statusError(error.code === 'ENOSPC' ? 'Insufficient disk space to load session archive.' : error.message, error.status || 400);
    } finally {
      if (!incoming.readableEnded) incoming.destroy();
      fs.rmSync(upload, {force: true});
      if (stage) fs.rmSync(stage, {recursive: true, force: true});
    }
  }
};

module.exports = {commands};
