// Traffic capture in the interface: the captures of each node (kept from the server's `captures`
// events and from the list route), the reasons a capture cannot start, and the capture section of
// Host Settings > Network. The server and the runner do the work (docs/architecture.md, "Traffic
// capture"); this module only asks for it.
import {machines} from './state.js';
import {jsonRequest, nodeUrl, requestJson} from './api.js';
import {holdingControl, observing} from './observe.js';

const POLL_MS = 2000;
// Captures per node, as the server's `captures` event sends them: {id, nodeId, interface, index,
// file, state, reason, message, startedAt, endedAt, bytes}.
const byNode = new Map();
let limits = {maxBytes: 100 * 1024 * 1024, maxPerNode: 4};
// The section of Host Settings being shown: {container, nodeId}, or null.
let panel = null;
let pollTimer = null;
const changeListeners = new Set();

export const capturesOf = nodeId => byNode.get(nodeId) || [];
export const isRecording = capture => capture.state !== 'stopped';
export const recordingOf = nodeId => capturesOf(nodeId).filter(isRecording);
export const onCapturesChanged = listener => changeListeners.add(listener);

// An observer may look but not capture; an administrator holding the control lock may.
export const canCapture = () => !observing || holdingControl();

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Why interface `index` of a host cannot be captured now, or null. `machine` is the live record
// of machines (state.js).
export function captureBlocker(machine, index) {
  if (!canCapture()) return 'Read-only observation: take control of the session to capture.';
  if (machine.engine !== 'qemu') return 'Capture is available for QEMU hosts only.';
  if (!machine.running) return 'The host is stopped: start it to capture.';
  if (machine.busy) return 'The host is busy.';
  if (machine.pendingRestart) return 'The host has pending changes: restart it first.';
  if (!machine.interfaces?.[index]) return 'This interface is not connected to a switch.';
  if (capturesOf(machine.id).some(item => item.index === index && isRecording(item))) return null;
  if (capturesOf(machine.id).length >= limits.maxPerNode) return `A host keeps at most ${limits.maxPerNode} captures: delete one first.`;
  return null;
}

function publishChange(nodeId) {
  for (const listener of changeListeners) listener(nodeId);
  renderPanel();
}

// The server's `captures` event ({nodeId, captures}).
export function setCaptures({nodeId, captures}) {
  if (!Array.isArray(captures)) return;
  if (captures.length) byNode.set(nodeId, captures); else byNode.delete(nodeId);
  publishChange(nodeId);
}

// Reads the captures of a node from the server. An observer without control gets none.
export async function loadCaptures(nodeId) {
  if (!canCapture()) return;
  try {
    const body = await requestJson(`${nodeUrl(nodeId, 'captures')}`, {cache: 'no-store'}, 'Cannot list the captures.');
    if (body.limits) limits = body.limits;
    setCaptures({nodeId, captures: body.captures});
    if (!body.captures.length) publishChange(nodeId);
  } catch (_) { /* The list stays as it was. */ }
}

const action = async (nodeId, captureId, verb, options) => requestJson(nodeUrl(nodeId, `captures${captureId ? `/${captureId}` : ''}${verb ? `/${verb}` : ''}`), options, 'Capture request failed.');

// The browser downloads straight from the server; an observing administrator needs the
// X-Observe header, so the file goes through a Blob.
async function download(nodeId, capture) {
  const url = nodeUrl(nodeId, `captures/${capture.id}/download`);
  const link = document.createElement('a');
  link.download = capture.file;
  if (!observing) link.href = url;
  else {
    const response = await fetch(url);
    if (!response.ok) throw new Error((await response.json()).error || 'Download failed.');
    link.href = URL.createObjectURL(await response.blob());
  }
  document.body.append(link);
  link.click();
  link.remove();
  if (observing) setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}

function button(text, title, onClick, disabled = false) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  element.title = title;
  element.disabled = disabled;
  element.addEventListener('click', onClick);
  return element;
}

function renderPanel() {
  clearTimeout(pollTimer);
  if (!panel || !panel.container.closest('dialog[open]')) { panel = null; return; }
  const {container, nodeId} = panel;
  const machine = machines.get(nodeId);
  const status = document.createElement('p');
  status.className = 'capture-status';
  status.setAttribute('role', 'status');
  const run = async work => {
    status.textContent = '';
    try { await work(); } catch (error) { status.textContent = error.message; }
  };
  const head = document.createElement('div');
  head.className = 'capture-head';
  head.innerHTML = '<strong>Traffic capture</strong><span>Records the frames of an interface, both directions, into a PCAP file for Wireshark.</span>';
  container.replaceChildren(head);
  if (!machine || machine.kind !== 'host') return;
  for (const [index, switchId] of (machine.interfaces || []).entries()) {
    const row = document.createElement('div');
    row.className = 'capture-row';
    const label = document.createElement('span');
    label.textContent = `Ethernet ${index}`;
    const current = capturesOf(nodeId).find(item => item.index === index && isRecording(item));
    const blocker = captureBlocker(machine, index);
    const note = document.createElement('span');
    note.className = 'capture-note';
    note.textContent = current ? `recording · ${formatBytes(current.bytes)}` : blocker || '';
    const toggle = current
      ? button('Stop', `Stop capturing eth${index}`, () => run(() => action(nodeId, current.id, 'stop', {method: 'POST'})), !canCapture())
      : button('Capture', blocker || `Start capturing eth${index}`, () => run(() => action(nodeId, '', '', jsonRequest('POST', {interface: `eth${index}`}))), !!blocker);
    toggle.classList.add(current ? 'capture-stop' : 'capture-start');
    row.append(label, note, toggle);
    container.append(row);
  }
  for (const capture of capturesOf(nodeId)) {
    const row = document.createElement('div');
    row.className = 'capture-row capture-file';
    const name = document.createElement('span');
    name.textContent = capture.file;
    const note = document.createElement('span');
    note.className = 'capture-note';
    note.textContent = `${capture.message} · ${formatBytes(capture.bytes)}`;
    const actions = document.createElement('span');
    actions.className = 'capture-actions';
    actions.append(
      button('Download', 'Download the PCAP file', () => run(() => download(nodeId, capture)), !canCapture() || capture.bytes <= 24),
      button('Delete', 'Delete the capture file', () => {
        if (confirm(`Delete ${capture.file}?`)) run(() => action(nodeId, capture.id, '', {method: 'DELETE'}));
      }, !canCapture() || isRecording(capture)));
    row.append(name, note, actions);
    container.append(row);
  }
  container.append(status);
  // The size of a running capture is not pushed: look again while one is recording.
  if (recordingOf(nodeId).length) pollTimer = setTimeout(() => loadCaptures(nodeId), POLL_MS);
}

// Shows the capture section of node `nodeId` in `container` (Host Settings > Network).
export function showHostCaptures(container, nodeId) {
  panel = {container, nodeId};
  renderPanel();
  loadCaptures(nodeId);
}

export function hideHostCaptures() {
  clearTimeout(pollTimer);
  panel = null;
}

// The host's state changed (started, stopped, switches connected): the reasons change with it.
export const refreshHostCaptures = () => renderPanel();
