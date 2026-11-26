// Reading a session ZIP in the browser, without uploading it (summary, working disks, base images check), and sending it
// to the server (upload, or a file of the server's examples). Used by the Load Session dialog (public/load-dialog.js).
import {jsonRequest, sessionLost, requestJson} from './api.js';
import {archiveDisksPhrase, countPhrase} from './file-kinds.js';

// Reads the ZIP central directory. QemuWeb archives always end with a 32-bit
// end-of-central-directory record, so only the file tail is read.
async function archiveEntries(file) {
  const tailStart = Math.max(0, file.size - 65557);
  const tail = new DataView(await file.slice(tailStart).arrayBuffer());
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('No ZIP central directory.');
  const size = tail.getUint32(end + 12, true), offset = tail.getUint32(end + 16, true);
  const directory = new DataView(await file.slice(offset, offset + size).arrayBuffer());
  const decoder = new TextDecoder(), entries = new Map();
  for (let at = 0; at + 46 <= directory.byteLength && directory.getUint32(at, true) === 0x02014b50;) {
    const nameLength = directory.getUint16(at + 28, true);
    const name = decoder.decode(new Uint8Array(directory.buffer, at + 46, nameLength));
    entries.set(name, {method: directory.getUint16(at + 10, true), size: directory.getUint32(at + 20, true),
      offset: directory.getUint32(at + 42, true)});
    at += 46 + nameLength + directory.getUint16(at + 30, true) + directory.getUint16(at + 32, true);
  }
  return entries;
}
// Reads a small JSON entry; QemuWeb stores every file except disks uncompressed.
async function archiveJson(file, entry) {
  if (!entry || entry.method !== 0) throw new Error('Unsupported ZIP entry.');
  const header = new DataView(await file.slice(entry.offset, entry.offset + 30).arrayBuffer());
  const start = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  return JSON.parse(await file.slice(start, start + entry.size).text());
}
// Reads session.json and the list of working disks from the ZIP, without uploading it.
export async function readArchiveSummary(file) {
  const entries = await archiveEntries(file);
  // Host and switch IDs have 8 hex characters; earlier versions used 16 (runner/archive-zip.js refuses them too).
  if ([...entries.keys()].some(name => /^[hs]-[0-9a-f]{16}\//.test(name))) throw Object.assign(new Error('This session archive comes from an earlier version of QemuWeb (16-character host and switch IDs): it cannot be loaded.'), {earlierVersion: true});
  // The hosts that carry a working disk, and how many disks of each engine (disk.qcow2, disk.vdi).
  const diskNames = [...entries.keys()].map(name => /^(h-[0-9a-f]{8})\/disk\.(qcow2|vdi)$/.exec(name)).filter(Boolean);
  const diskHosts = [...new Set(diskNames.map(match => match[1]))];
  const diskCounts = {qemu: diskNames.filter(match => match[2] === 'qcow2').length, vbox: diskNames.filter(match => match[2] === 'vdi').length};
  const session = await archiveJson(file, entries.get('session.json'));
  const hosts = await Promise.all(session.hosts.map(id => archiveJson(file, entries.get(`${id}/host.json`))));
  return {entries, diskHosts, diskCounts, session, startupDisks: countStartupDisks(hosts, [...entries.keys()])};
}
// host.json only records startupDiskEnabled when it differs from the system profile, which the browser
// does not know: an absent value counts as a startup disk when the host has startup files in the archive.
function countStartupDisks(hosts, names) {
  return hosts.filter(host => typeof host.config?.startupDiskEnabled === 'boolean'
    ? host.config.startupDiskEnabled : names.some(name => name.startsWith(`${host.id}/startup/`))).length;
}
export function archiveSummaryText({session, diskCounts, startupDisks}) {
  const disks = archiveDisksPhrase(diskCounts);
  return [`${countPhrase(session.hosts.length, 'host')} and ${countPhrase(session.switches.length, 'switch', 'switches')}`,
    `${startupDisks} with startup disk`, disks].join(' · ');
}
// Warns before upload when a working disk depends on a base image that changed since the archive was
// saved. Only hosts with a working disk record the images (host.json "baseImages", one per disk format);
// without disks nothing depends on the images.
export async function checkArchiveBaseImages(file, {entries, diskHosts}) {
  if (!diskHosts.length) return {messages: [], staleDisks: false, changed: false, noDisks: true};
  const hosts = await Promise.all(diskHosts.map(id => archiveJson(file, entries.get(`${id}/host.json`))));
  const baseImages = {};
  for (const host of hosts) {
    for (const [format, identity] of Object.entries(host.baseImages || {})) {
      baseImages[host.system] ||= {};
      baseImages[host.system][format] ||= identity;
    }
  }
  const result = await requestJson('/api/session-archive/check', jsonRequest('POST', {baseImages}), 'Cannot check base images.');
  const messages = [];
  let staleDisks = false;
  for (const id of result.changed) {
    const stale = hosts.filter(host => host.system === id).map(host => host.name);
    staleDisks ||= stale.length > 0;
    if (stale.length) messages.push(`Base image ${id} changed since this session was saved. The working disks of ${stale.join(', ')} cannot be reused.`);
  }
  return {messages, staleDisks, changed: result.changed.length > 0};
}
// Uploads the ZIP with progress reporting, which fetch() cannot do.
export function importArchive(file, {autoStart, discardDisks}, onProgress, onUploaded) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/session-archive/import?autoStart=${autoStart}&discardDisks=${discardDisks}`);
    request.setRequestHeader('Content-Type', 'application/zip');
    request.upload.addEventListener('progress', event => { if (event.lengthComputable && event.total) onProgress(Math.floor(event.loaded * 100 / event.total)); });
    request.upload.addEventListener('load', onUploaded);
    request.addEventListener('load', () => {
      let data = {};
      try { data = JSON.parse(request.responseText); } catch (_) { /* Not JSON: use the generic message. */ }
      if (request.status === 401) sessionLost();
      if (request.status >= 200 && request.status < 300) resolve(data);
      else reject(new Error(data.error || 'Cannot load session.'));
    });
    request.addEventListener('error', () => reject(new Error('Network error while uploading the archive.')));
    request.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
    request.send(file);
  });
}
// Loads a ZIP of the server's examples from the server's disk: no upload, the server feeds the file to the same import.
export async function importExample(name, {autoStart, discardDisks}, onUploaded) {
  onUploaded();
  return requestJson('/api/examples/load', jsonRequest('POST', {name, autoStart, discardDisks}), 'Cannot load session.');
}
