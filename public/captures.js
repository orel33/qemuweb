// Traffic capture in the interface: the captures of each node (kept from the server's `captures`
// events and from the list route), the reasons a capture cannot start, the interface labels and the
// state of the pane button, and the requests. The Capture dialog (capture-dialog.js) and the pane
// button (capture-button.js) show them. The server and the runner do the work (docs/architecture.md,
// "Traffic capture"); this module only asks for it.
import {machines} from './state.js';
import {jsonRequest, nodeUrl, requestJson} from './api.js';
import {canWrite, controllingAdmin, observing} from './observe.js';

// Captures per node, as the server's `captures` event sends them: {id, nodeId, interface, index,
// file, state, reason, message, startedAt, endedAt, bytes}.
const byNode = new Map();
export const nameOf = nodeId => machines.get(nodeId)?.hostname || nodeId;
let limits = {maxBytes: 100 * 1024 * 1024, maxPerNode: 4};
const changeListeners = new Set();

export const capturesOf = nodeId => byNode.get(nodeId) || [];
export const isRecording = capture => capture.state !== 'stopped';
export const recordingOf = nodeId => capturesOf(nodeId).filter(isRecording);
export const onCapturesChanged = listener => changeListeners.add(listener);

// An observer may look but not capture; an administrator holding the control lock may, and the
// owner may not meanwhile (one driver at a time).
export const canCapture = () => canWrite();
function captureRefusal() {
  return observing ? 'Read-only observation: take control of the session to capture.' : `${controllingAdmin()} controls your session.`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Why a host cannot be captured at all (whatever the interface), or null.
function hostCaptureBlocker(machine) {
  if (!canCapture()) return captureRefusal();
  if (machine.engine !== 'qemu') return 'Capture is available for QEMU hosts only.';
  return null;
}

// Why interface `index` of a host cannot be captured now, or null. `machine` is the live record
// of machines (state.js).
export function captureBlocker(machine, index) {
  const hostBlocker = hostCaptureBlocker(machine);
  if (hostBlocker) return hostBlocker;
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
}

// How an interface of a host is named in the Capture dialog: "Ethernet 0 · to switch lan".
// `switchName` is the name of the switch it is connected to, empty when it is not connected.
export function interfaceLabel(index, switchName) {
  return `Ethernet ${index} · ${switchName ? `to switch ${switchName}` : 'not connected'}`;
}

// The interface the Capture dialog selects first: the one being recorded, else the first
// connected one (the only one, usually), else Ethernet 0 (its reason is then shown).
export function preselectInterface(machine, captures) {
  const recording = captures.find(item => item.state !== 'stopped');
  if (recording) return recording.index;
  const connected = (machine.interfaces || []).findIndex(Boolean);
  return connected < 0 ? 0 : connected;
}

// The Capture button of a console pane: {hidden, disabled, recording, title}. A switch or an empty
// pane has none; a host always has one (stopped hosts keep their files), disabled with the reason
// when capture is out of reach (observer, VirtualBox).
export function captureButtonState(machine, captures) {
  const recording = captures.filter(item => item.state !== 'stopped').length;
  if (!machine || machine.kind !== 'host') return {hidden: true, disabled: true, recording: 0, title: ''};
  const blocker = hostCaptureBlocker(machine);
  if (blocker) return {hidden: false, disabled: true, recording, title: blocker};
  const title = recording ? `Capture: recording ${recording} ${recording === 1 ? 'interface' : 'interfaces'}` : 'Capture the traffic of this host';
  return {hidden: false, disabled: false, recording, title};
}

// The three buttons of the Capture dialog for interface `index` of a host: Play (start), Stop and
// Download. Each blocker is null when the button is enabled, else the reason it is disabled (also its
// tooltip). `captures` are the host's captures; `owner(capture)` says 'mine', 'other' or 'free'
// (captureOwnership). `file` is the capture Download gives: the latest of this interface that this
// dialog or another tab holds (nothing from a leftover), also while it records: the runner cuts the
// download after its last whole packet.
export function captureControls(machine, captures, index, owner) {
  const here = captures.filter(item => item.index === index);
  const recording = here.find(item => item.state !== 'stopped') || null;
  const elsewhere = !!recording && owner(recording) === 'other';
  const files = here.filter(item => owner(item) !== 'free').sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const file = files.at(-1) || null;
  const rights = canCapture() ? null : captureRefusal();
  let play = null;
  if (recording) play = elsewhere ? 'This capture belongs to another window.' : 'This interface is already being captured.';
  else play = captureBlocker(machine, index);
  let stop = null;
  if (!recording) stop = 'Nothing is recording on this interface.';
  else if (rights) stop = rights;
  else if (elsewhere) stop = 'This capture belongs to another window: only that window can stop it.';
  let download = null;
  if (rights) download = rights;
  else if (!file) download = 'No capture file yet: start a capture.';
  else if (file.bytes <= 24) download = 'Nothing was captured yet.';
  return {recording, elsewhere, file, play, stop, download};
}

// A capture that ended is saved through the browser's download once, when it holds a packet (a
// PCAP header alone is 24 bytes). `saved` is the set of the capture IDs already saved.
export function shouldAutoDownload(capture, saved) {
  return capture.state === 'stopped' && capture.bytes > 24 && !saved.has(capture.id);
}

// Whose a capture is, for the Capture dialog: 'mine' (this dialog started it), 'other' (another
// tab holds its lease, or it started a few seconds ago and its tab has not leased it yet) or 'free'
// (nobody: a leftover of a crashed tab). `mine` and `leased` are sets of capture IDs; `leased`
// holds the leases of the other tabs (server/capture-lease.js).
export function captureOwnership(capture, mine, leased, now) {
  if (mine.has(capture.id)) return 'mine';
  if (leased.has(capture.id)) return 'other';
  return capture.state !== 'stopped' && now - Date.parse(capture.startedAt) < 10000 ? 'other' : 'free';
}

// Finished captures nobody leases: the leftovers deleted when the Capture dialog opens. A recording
// capture, and the file another tab has not yet saved, are never touched.
export function staleCaptures(captures, leased) {
  return captures.filter(item => item.state === 'stopped' && !leased.has(item.id));
}

// What closing the Capture dialog does to a host's captures: the recording ones started by this
// dialog (`mine`, a set of IDs) are stopped; they, and the finished files nobody else leases, are
// deleted. A capture of another tab is left alone. Nothing is saved at close: Stop saves.
export function closePlan(captures, mine, leased) {
  return {
    stop: captures.filter(item => item.state !== 'stopped' && mine.has(item.id)),
    remove: captures.filter(item => mine.has(item.id) || (item.state === 'stopped' && !leased.has(item.id)))
  };
}

// The host's state changed (started, stopped, switches connected): the reasons change with it.
export const refreshCaptureRules = () => publishChange(null);

// Nodes were removed: their captures went with them.
export function forgetCaptures(nodeIds) {
  for (const id of nodeIds) { byNode.delete(id); publishChange(id); }
}

// Every capture of the session (the list dialog, the indicators after a page load).
export async function loadAllCaptures() {
  if (!canCapture()) return;
  try {
    const body = await requestJson('/api/captures', {cache: 'no-store'}, 'Cannot list the captures.');
    if (body.limits) limits = body.limits;
    const nodes = new Set([...byNode.keys(), ...body.captures.map(item => item.nodeId)]);
    for (const nodeId of nodes) {
      const own = body.captures.filter(item => item.nodeId === nodeId);
      if (own.length) byNode.set(nodeId, own); else byNode.delete(nodeId);
      publishChange(nodeId);
    }
  } catch (_) { /* The lists stay as they were. */ }
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
  } catch (_) { /* The list stays as it was. */ }
}

const captureAction = async (nodeId, captureId, verb, options) => requestJson(nodeUrl(nodeId, `captures${captureId ? `/${captureId}` : ''}${verb ? `/${verb}` : ''}`), options, 'Capture request failed.');

export const startCapture = (nodeId, index) => captureAction(nodeId, '', '', jsonRequest('POST', {interface: `eth${index}`}));
export const stopCapture = (nodeId, captureId) => captureAction(nodeId, captureId, 'stop', {method: 'POST'});
export const deleteCapture = (nodeId, captureId) => captureAction(nodeId, captureId, '', {method: 'DELETE'});

// The browser downloads straight from the server; an observing administrator needs the
// X-Observe header, so the file goes through a Blob.
export async function downloadCapture(nodeId, capture) {
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

// The right to capture may have changed (an administrator took or released control).
export function refreshCaptureAccess() {
  publishChange(null);
  loadAllCaptures();
}
