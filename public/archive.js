// Session ZIP archive save and load dialogs.
import {graphicLayoutKey, machines, saveViewSettings, store} from './state.js';
import {jsonRequest, requestJson} from './api.js';
import {showStatusError} from './workspace.js';

const archiveDialog = document.getElementById('session-archive-dialog');
const archiveChoice = document.getElementById('include-working-disks');
const archiveWorkingDiskWarning = document.getElementById('archive-working-disk-warning');
const archiveIntro = document.getElementById('session-archive-intro');
const archiveEstimate = document.getElementById('session-archive-estimate');
const archiveProgress = document.getElementById('session-archive-progress');
const archiveProgressText = document.getElementById('session-archive-progress-text');
const archiveError = document.getElementById('session-archive-error');
const archiveConfirm = document.getElementById('confirm-session-archive');
const archiveFile = document.getElementById('session-archive-file');
const archiveLoadDialog = document.getElementById('session-archive-load-dialog');
const archiveLoadFileLabel = document.getElementById('session-archive-load-file');
const archiveLoadAutoStart = document.getElementById('session-archive-autostart');
const archiveLoadDiscardStaleDisks = document.getElementById('session-archive-discard-stale-disks');
// The discard option only applies to working disks whose base image changed.
let archiveLoadDiscardRelevant = false;
function setArchiveLoadDiscardRelevant(relevant) {
  archiveLoadDiscardRelevant = relevant;
  archiveLoadDiscardStaleDisks.checked = relevant;
  archiveLoadDiscardStaleDisks.disabled = !relevant;
}
const archiveLoadSteps = document.getElementById('session-archive-load-steps');
const archiveRestoreLabel = document.getElementById('session-archive-restore-label');
const stepStateText = {pending: 'Pending', running: 'In progress', done: 'Done', warning: 'Warning', error: 'Failed'};
const loadStepNames = ['read', 'check', 'upload', 'restore'];
// One line per stage of loading a session: a state icon (spinner, green tick, warning, error) and an optional detail.
function setLoadStep(name, state, detail = '') {
  const item = archiveLoadSteps.querySelector(`[data-step="${name}"]`);
  item.dataset.state = state;
  item.querySelector('.archive-step-state').textContent = stepStateText[state];
  const text = item.querySelector('.archive-step-detail');
  text.textContent = detail;
  text.hidden = !detail;
}
function resetLoadSteps(names = loadStepNames) { for (const name of names) setLoadStep(name, 'pending'); }
function updateRestoreLabel() {
  archiveRestoreLabel.textContent = archiveLoadAutoStart.checked ? 'Restore session and start hosts and switches' : 'Restore session';
}
const countLabel = (count, noun, plural = `${noun}s`) => `${count} ${count === 1 ? noun : plural}`;
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
async function readArchiveSummary(file) {
  const entries = await archiveEntries(file);
  const diskHosts = [...entries.keys()].map(name => /^(h-[0-9a-f]{16})\/disk\.qcow2$/.exec(name)?.[1]).filter(Boolean);
  const session = await archiveJson(file, entries.get('session.json'));
  return {entries, diskHosts, session};
}
function archiveSummaryText({session, diskHosts}) {
  const disks = diskHosts.length ? countLabel(diskHosts.length, 'working disk') : 'no working disk';
  return `${countLabel(session.hosts.length, 'host')} and ${countLabel(session.switches.length, 'switch', 'switches')}, ${disks} (qcow2)`;
}
// Warns before upload when a base image changed since the archive was saved.
async function checkArchiveBaseImages(file, {entries, diskHosts, session}) {
  const result = await requestJson('/api/session-archive/check', jsonRequest('POST', {engine: session.engine, baseImages: session.baseImages}), 'Cannot check base images.');
  const hosts = await Promise.all(diskHosts.map(id => archiveJson(file, entries.get(`${id}/host.json`))));
  const messages = [];
  let staleDisks = false;
  for (const id of result.changed) {
    const stale = hosts.filter(host => host.system === id).map(host => host.name);
    staleDisks ||= stale.length > 0;
    messages.push(stale.length
      ? `Base image ${id} changed since this session was saved. The working disks of ${stale.join(', ')} cannot be reused.`
      : `Base image ${id} changed since this session was saved. Its hosts will start from the current image.`);
  }
  return {messages, staleDisks};
}
// Uploads the ZIP with progress reporting, which fetch() cannot do.
function importArchive(file, {autoStart, discardStaleDisks}, onProgress, onUploaded) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/session-archive/import?autoStart=${autoStart}&discardStaleDisks=${discardStaleDisks}`);
    request.setRequestHeader('Content-Type', 'application/zip');
    request.upload.addEventListener('progress', event => { if (event.lengthComputable && event.total) onProgress(Math.floor(event.loaded * 100 / event.total)); });
    request.upload.addEventListener('load', onUploaded);
    request.addEventListener('load', () => {
      let data = {};
      try { data = JSON.parse(request.responseText); } catch (_) { /* Not JSON: use the generic message. */ }
      if (request.status >= 200 && request.status < 300) resolve(data);
      else reject(new Error(data.error || 'Cannot load session.'));
    });
    request.addEventListener('error', () => reject(new Error('Network error while uploading the archive.')));
    request.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
    request.send(file);
  });
}
const archiveLoadError = document.getElementById('session-archive-load-error');
const archiveLoadCancel = document.getElementById('cancel-session-archive-load');
const archiveLoadConfirm = document.getElementById('confirm-session-archive-load');
let selectedArchiveFile = null;
let archiveLoadBusy = false;
let archiveLoadImported = false;

let archiveEstimateRequest = 0;
async function updateArchiveEstimate() {
  const request = ++archiveEstimateRequest;
  archiveConfirm.disabled = true;
  archiveError.hidden = true;
  archiveEstimate.textContent = 'Estimating archive size…';
  try {
    const includeDisks = archiveChoice.checked;
    const response = await fetch(`/api/session-archive/estimate?includeDisks=${includeDisks}`, {cache: 'no-store'});
    const data = await response.json();
    if (request !== archiveEstimateRequest) return;
    if (!response.ok) throw new Error(data.error || 'Cannot estimate session archive.');
    archiveIntro.textContent = `Save your current session: ${data.hosts} ${data.hosts === 1 ? 'host' : 'hosts'} and ${data.switches} ${data.switches === 1 ? 'switch' : 'switches'}.`;
    archiveEstimate.textContent = `Estimated compressed ZIP: ${(data.bytes / 1e6).toFixed(2)} MB`;
    archiveConfirm.disabled = false;
  } catch (error) {
    if (request !== archiveEstimateRequest) return;
    archiveEstimate.textContent = ''; archiveError.textContent = error.message; archiveError.hidden = false;
  }
}

const archiveLoadBlockedDialog = document.getElementById('session-archive-load-blocked-dialog');
function showArchiveLoadBlockedWarning() {
  if (!archiveLoadBlockedDialog.open) archiveLoadBlockedDialog.showModal();
}

export function initArchive() {
  archiveLoadDialog.addEventListener('cancel', event => { if (archiveLoadBusy) event.preventDefault(); });
  archiveLoadDialog.addEventListener('close', () => {
    selectedArchiveFile = null;
    if (archiveLoadImported) location.reload();
  });
  document.getElementById('save-session-archive').addEventListener('click', () => {
    archiveChoice.checked = false;
    archiveWorkingDiskWarning.hidden = true;
    archiveIntro.textContent = 'Save your current session.';
    archiveProgress.hidden = true;
    archiveDialog.showModal();
    updateArchiveEstimate();
  });
  archiveChoice.addEventListener('change', () => {
    archiveWorkingDiskWarning.hidden = !archiveChoice.checked;
    updateArchiveEstimate();
  });
  document.getElementById('cancel-session-archive').addEventListener('click', () => archiveDialog.close());
  archiveConfirm.addEventListener('click', async () => {
    archiveConfirm.disabled = true;
    archiveError.hidden = true;
    let writable = null;
    try {
      const includeDisks = archiveChoice.checked;
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({suggestedName: 'qemuweb-session-v4.zip', types: [{description: 'QemuWeb session ZIP', accept: {'application/zip': ['.zip']}}]});
        writable = await handle.createWritable();
      }
      archiveProgressText.textContent = includeDisks ? 'Stopping session and creating archive…' : 'Creating archive…';
      archiveProgress.hidden = false;
      archiveDialog.setAttribute('aria-busy', 'true');
      const response = await fetch('/api/session-archive/export', jsonRequest('POST', {includeDisks}));
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Cannot save session.'); }
      archiveProgressText.textContent = 'Downloading ZIP…';
      if (writable) { await response.body.pipeTo(writable); writable = null; }
      else {
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a'); link.href = url; link.download = 'qemuweb-session-v4.zip'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      archiveDialog.close();
    } catch (error) {
      if (writable) await writable.abort().catch(() => {});
      await updateArchiveEstimate();
      archiveError.textContent = error.message; archiveError.hidden = false;
    } finally {
      archiveProgress.hidden = true;
      archiveDialog.removeAttribute('aria-busy');
    }
  });
  document.getElementById('load-session-archive').addEventListener('click', () => {
    if (machines.size) { showArchiveLoadBlockedWarning(); return; }
    archiveFile.click();
  });
  archiveFile.addEventListener('change', async () => {
    const file = archiveFile.files[0];
    archiveFile.value = '';
    if (!file) return;
    if (machines.size) { showArchiveLoadBlockedWarning(); return; }
    if (!/\.zip$/i.test(file.name)) { showStatusError('Choose a QemuWeb ZIP archive.'); return; }
    selectedArchiveFile = file;
    archiveLoadImported = false;
    archiveLoadFileLabel.textContent = file.name;
    archiveLoadAutoStart.checked = true;
    updateRestoreLabel();
    setArchiveLoadDiscardRelevant(false);
    resetLoadSteps();
    archiveLoadError.hidden = true;
    archiveLoadCancel.textContent = 'Cancel';
    archiveLoadConfirm.hidden = false;
    archiveLoadConfirm.disabled = true;
    archiveLoadDialog.showModal();
    // The first two steps only read the local file and ask the server about base images: nothing is uploaded yet.
    let summary = null;
    setLoadStep('read', 'running');
    try {
      summary = await readArchiveSummary(file);
      if (selectedArchiveFile !== file) return;
      setLoadStep('read', 'done', archiveSummaryText(summary));
    } catch (_) {
      if (selectedArchiveFile !== file) return;
      // The server validates the archive on load; offer the option if disks may be present.
      setLoadStep('read', 'warning', 'Cannot read the archive here; the server will validate it on load.');
    }
    try {
      if (!summary) {
        setLoadStep('check', 'warning', 'Skipped: the base images are checked on load.');
        setArchiveLoadDiscardRelevant(true);
      } else {
        setLoadStep('check', 'running');
        const check = await checkArchiveBaseImages(file, summary);
        if (selectedArchiveFile !== file) return;
        setLoadStep('check', check.messages.length ? 'warning' : 'done', check.messages.join('\n') || 'Base images are up to date');
        setArchiveLoadDiscardRelevant(check.staleDisks);
      }
    } catch (_) {
      if (selectedArchiveFile !== file) return;
      setLoadStep('check', 'warning', 'Cannot check base images; the server will validate them on load.');
      setArchiveLoadDiscardRelevant(true);
    } finally {
      if (selectedArchiveFile === file) archiveLoadConfirm.disabled = false;
    }
  });
  archiveLoadAutoStart.addEventListener('change', updateRestoreLabel);
  archiveLoadCancel.addEventListener('click', () => archiveLoadDialog.close());
  archiveLoadConfirm.addEventListener('click', async () => {
    if (!selectedArchiveFile || archiveLoadBusy) return;
    archiveLoadBusy = true;
    archiveLoadCancel.disabled = true;
    archiveLoadConfirm.disabled = true;
    archiveLoadAutoStart.disabled = true;
    archiveLoadDiscardStaleDisks.disabled = true;
    archiveLoadError.hidden = true;
    updateRestoreLabel();
    resetLoadSteps(['upload', 'restore']);
    archiveLoadDialog.setAttribute('aria-busy', 'true');
    let activeStep = 'upload';
    try {
      const autoStart = archiveLoadAutoStart.checked;
      const discardStaleDisks = archiveLoadDiscardRelevant && archiveLoadDiscardStaleDisks.checked;
      setLoadStep('upload', 'running', '0%');
      const result = await importArchive(selectedArchiveFile, {autoStart, discardStaleDisks},
        percent => setLoadStep('upload', 'running', `${percent}%`),
        () => { setLoadStep('upload', 'done'); activeStep = 'restore'; setLoadStep('restore', 'running'); });
      archiveLoadImported = true;
      store.graphicZoom = 1;
      saveViewSettings();
      localStorage.removeItem(graphicLayoutKey);
      if (result.startErrors?.length) {
        setLoadStep('restore', 'warning', `Session loaded, but some instances could not start:\n${result.startErrors.join('\n')}`);
        archiveLoadCancel.textContent = 'Close';
        archiveLoadConfirm.hidden = true;
      } else {
        setLoadStep('restore', 'done');
        // Leave the final tick visible for a moment before the page reloads.
        await new Promise(resolve => setTimeout(resolve, 700));
        archiveLoadDialog.close();
      }
    } catch (error) {
      setLoadStep(activeStep, 'error', error.message);
    } finally {
      archiveLoadBusy = false;
      archiveLoadCancel.disabled = false;
      archiveLoadConfirm.disabled = false;
      archiveLoadAutoStart.disabled = false;
      archiveLoadDiscardStaleDisks.disabled = !archiveLoadDiscardRelevant;
      archiveLoadDialog.removeAttribute('aria-busy');
    }
  });
}
