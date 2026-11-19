// The Capture dialog: opened from the Capture button of a console pane (capture-button.js) or from
// the Graphic view link popover. It chooses an interface, starts and stops its capture, saves the
// PCAP through the browser's download as soon as the capture ends, and shows the packets in a live
// area. A capture lives only while the dialog is open: closing it stops and discards the captures
// it started (the server does the same when the tab's socket closes: server/capture-lease.js).
// The rules and the requests are those of captures.js; nothing is decided here.
import {machines} from './state.js';
import {canCapture, captureBlocker, captureOwnership, capturesOf, closePlan, deleteCapture, downloadCapture, formatBytes, interfaceLabel, isRecording, loadCaptures, nameOf, onCapturesChanged, preselectInterface, shouldAutoDownload, staleCaptures, startCapture, stopCapture} from './captures.js';
import {addLiveNote, clearLive, startLive, stopLive} from './capture-live.js';
import {emitOnSession} from './socket.js';

const POLL_MS = 2000;
const byId = id => document.getElementById(id);
const dialog = byId('capture-dialog');
const title = byId('capture-dialog-title');
const select = byId('capture-interface');
const filter = byId('capture-filter');
const toggle = byId('capture-toggle');
const stateLine = byId('capture-state');
const note = byId('capture-note');
const savedLine = byId('capture-saved');
const savedName = byId('capture-saved-name');
const status = byId('capture-status');
const confirmRow = byId('capture-confirm');

// The host, the selected interface, and what this dialog session knows: the captures it started
// (`mine`, stopped and deleted at close), the ones the other tabs lease (`leased`, left alone), the
// ones it saw recording (`watched`, saved when they end), the ones already saved, and the last
// saved file ("Download again").
const freshSession = (nodeId, index) => ({nodeId, index, mine: new Set(), leased: new Set(), watched: new Set(), saved: new Set(), lastSaved: null});
let current = freshSession(null, 0);
let optionsSignature = '';
let timer = null;
let cleaning = Promise.resolve();

async function run(work) {
  status.textContent = '';
  try { await work(); } catch (error) { status.textContent = error.message; }
}

// The IDs of the captures of host `nodeId` that other tabs lease, or null when the server cannot
// say (nothing is then deleted on that basis).
function queryLeases(nodeId) {
  return new Promise(resolve => emitOnSession('capture-leased', {nodeId}, result => resolve(result?.leased ? new Set(result.leased) : null)));
}

// Takes note of the leases of the other tabs; the dialog is drawn again when they changed.
async function refreshLeases() {
  const nodeId = current.nodeId;
  const leased = await queryLeases(nodeId);
  if (!leased || nodeId !== current.nodeId || !dialog.open) return;
  const same = leased.size === current.leased.size && [...leased].every(id => current.leased.has(id));
  current.leased = leased;
  if (!same) refresh();
}

const ownerOf = capture => captureOwnership(capture, current.mine, current.leased, Date.now());

// Saves the file through the browser's own download (the download manager does the rest).
function save(capture) {
  current.saved.add(capture.id);
  current.lastSaved = capture;
  run(() => downloadCapture(capture.nodeId, capture));
}

// What the dialog does on its own as the captures change: it follows a recording of the selected
// interface with the live view, and saves a capture that ended (Stop, size limit, host stopped).
function sync() {
  const captures = capturesOf(current.nodeId);
  for (const capture of captures) {
    if (!isRecording(capture) || ownerOf(capture) !== 'free') continue;
    // A recording nobody leases (its tab died): this dialog takes it over, so that closing ends it.
    current.mine.add(capture.id);
    emitOnSession('capture-lease', {nodeId: current.nodeId, captureId: capture.id});
  }
  for (const capture of captures) if (isRecording(capture) && current.mine.has(capture.id)) current.watched.add(capture.id);
  for (const capture of captures) {
    if (!current.watched.has(capture.id) || current.saved.has(capture.id) || isRecording(capture)) continue;
    if (shouldAutoDownload(capture, current.saved)) save(capture);
    else { current.saved.add(capture.id); status.textContent = 'Nothing was captured: no file to save.'; }
  }
  const recording = captures.find(item => item.index === current.index && isRecording(item));
  if (recording) startLive(current.nodeId, recording.id, filter.value.trim()); else stopLive();
}

// The interface selector is rebuilt only when its text changes, so an open list is not closed.
function renderInterfaces(machine, captures) {
  const interfaces = machine.interfaces || [];
  const options = interfaces.map((switchId, index) => {
    const recording = captures.some(item => item.index === index && isRecording(item));
    const label = interfaceLabel(index, switchId ? nameOf(switchId) : '');
    return {text: recording ? `${label} · recording` : label, disabled: !switchId && !recording};
  });
  if (!options.length) options.push({text: 'No network interface', disabled: true});
  const signature = JSON.stringify(options);
  if (signature !== optionsSignature) {
    optionsSignature = signature;
    select.replaceChildren(...options.map((item, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = item.text;
      option.disabled = item.disabled;
      return option;
    }));
  }
  select.disabled = !interfaces.length;
  select.value = String(current.index);
}

function render() {
  clearTimeout(timer);
  if (!dialog.open) return;
  const machine = machines.get(current.nodeId);
  if (!machine) { dialog.close(); return; }
  title.textContent = `Traffic capture · ${nameOf(machine.id)}`;
  const captures = capturesOf(machine.id);
  if (current.index >= (machine.interfaces || []).length) current.index = preselectInterface(machine, captures);
  renderInterfaces(machine, captures);
  const recording = captures.find(item => item.index === current.index && isRecording(item));
  const blocker = captureBlocker(machine, current.index);
  toggle.textContent = recording ? 'Stop capture' : 'Start capture';
  toggle.dataset.recording = String(!!recording);
  const elsewhere = !!recording && ownerOf(recording) === 'other';
  toggle.disabled = elsewhere || (recording ? !!(blocker && /Read-only/.test(blocker)) : !!blocker);
  toggle.title = elsewhere ? 'This capture belongs to another window: only that window can stop it' : recording ? 'Stop capturing and save the file' : blocker || 'Start capturing this interface';
  stateLine.textContent = recording ? `Recording${elsewhere ? ' in another tab' : ''} · ${formatBytes(recording.bytes)}` : blocker || 'Not recording';
  note.textContent = captures.some(item => isRecording(item) && current.mine.has(item.id))
    ? 'Closing the window stops and discards the capture. Press Stop first to save it.'
    : 'Records what this interface sends and receives. Pressing Stop saves the file: open it in Wireshark.';
  savedLine.hidden = !current.lastSaved;
  if (current.lastSaved) savedName.textContent = `Saved: ${current.lastSaved.file}`;
  // The size of a running capture is not pushed: look again while one is recording.
  if (captures.some(isRecording)) timer = setTimeout(() => loadCaptures(machine.id), POLL_MS);
}

function refresh() {
  if (!dialog.open) return;
  sync();
  render();
}
const refreshAll = () => { refresh(); refreshLeases(); };

// Leftover finished files (a crashed tab, a previous capture) would count against the limit of
// four: they are deleted before anything else. A recording capture is never touched.
async function deleteFinished(nodeId) {
  const leased = await queryLeases(nodeId);
  if (!leased) return;
  current.leased = leased;
  await Promise.all(staleCaptures(capturesOf(nodeId), leased).map(capture => deleteCapture(nodeId, capture.id).catch(() => {})));
}

// Opens the dialog for host `nodeId`; `index` selects an interface, by default the one being
// recorded or the connected one.
export function openCaptureDialog(nodeId, {index = null} = {}) {
  const machine = machines.get(nodeId);
  if (!machine || machine.kind !== 'host' || !canCapture() || dialog.open) return;
  current = freshSession(nodeId, index ?? preselectInterface(machine, capturesOf(nodeId)));
  optionsSignature = '';
  status.textContent = '';
  confirmRow.hidden = true;
  clearLive();
  dialog.showModal();
  render();
  cleaning = cleaning.then(() => loadCaptures(nodeId)).then(() => deleteFinished(nodeId)).then(refresh);
}

// Closes the dialog, asking first when a capture of this window is recording: it would be lost.
function requestClose() {
  if (closePlan(capturesOf(current.nodeId), current.mine, current.leased).stop.length) {
    confirmRow.hidden = false;
    byId('capture-confirm-cancel').focus();
  } else dialog.close();
}

// The dialog closed: the captures it started are stopped and deleted, the saved file too.
function discard() {
  clearTimeout(timer);
  stopLive();
  const {nodeId, mine} = current;
  cleaning = cleaning.then(async () => {
    const leased = (await queryLeases(nodeId)) || current.leased;
    for (const capture of closePlan(capturesOf(nodeId), mine, leased).stop) await stopCapture(nodeId, capture.id).catch(() => {});
    await loadCaptures(nodeId);
    for (const capture of closePlan(capturesOf(nodeId), mine, leased).remove) await deleteCapture(nodeId, capture.id).catch(() => {});
    for (const id of mine) emitOnSession('capture-unlease', {nodeId, captureId: id});
  });
}

async function toggleCapture() {
  const {nodeId, index} = current;
  const recording = capturesOf(nodeId).find(item => item.index === index && isRecording(item));
  toggle.disabled = true;
  await run(async () => {
    if (recording) { await stopCapture(nodeId, recording.id); return; }
    await deleteFinished(nodeId);
    current.lastSaved = null;
    const capture = await startCapture(nodeId, index);
    current.mine.add(capture.id);
    current.watched.add(capture.id);
    clearLive();
    emitOnSession('capture-lease', {nodeId, captureId: capture.id}, result => { if (result?.error) addLiveNote(result.error); });
  });
  refresh();
}

export function initCaptureDialog() {
  select.addEventListener('change', () => { current.index = Number(select.value); refresh(); });
  filter.addEventListener('change', refresh);
  filter.addEventListener('keydown', event => { if (event.key === 'Enter') refresh(); });
  toggle.addEventListener('click', toggleCapture);
  byId('capture-download-again').addEventListener('click', () => { if (current.lastSaved) run(() => downloadCapture(current.nodeId, current.lastSaved)); });
  byId('capture-live-clear').addEventListener('click', clearLive);
  byId('capture-confirm-cancel').addEventListener('click', () => { confirmRow.hidden = true; toggle.focus(); });
  byId('capture-confirm-close').addEventListener('click', () => dialog.close());
  byId('close-capture-dialog').addEventListener('click', requestClose);
  // Esc and a click outside ask the same question as the Close button.
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener('click', event => {
    const box = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) requestClose();
  });
  dialog.addEventListener('close', discard);
  onCapturesChanged(refreshAll);
}
