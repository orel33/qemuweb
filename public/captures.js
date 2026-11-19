// Traffic capture in the interface: the captures of each node (kept from the server's `captures`
// events and from the list route), the reasons a capture cannot start, the interface labels and the
// state of the pane button, and the requests. The Capture dialog (capture-dialog.js) and the pane
// button (capture-button.js) show them. The server and the runner do the work (docs/architecture.md,
// "Traffic capture"); this module only asks for it.
import {machines} from './state.js';
import {jsonRequest, nodeUrl, requestJson} from './api.js';
import {holdingControl, observing} from './observe.js';

// Captures per node, as the server's `captures` event sends them: {id, nodeId, interface, index,
// file, state, reason, message, startedAt, endedAt, bytes}.
const byNode = new Map();
export const nameOf = nodeId => machines.get(nodeId)?.hostname || nodeId;
let limits = {maxBytes: 100 * 1024 * 1024, maxPerNode: 4};
const changeListeners = new Set();

export const capturesOf = nodeId => byNode.get(nodeId) || [];
export const isRecording = capture => capture.state !== 'stopped';
export const recordingOf = nodeId => capturesOf(nodeId).filter(isRecording);
export const allCaptures = () => [...byNode.values()].flat();
export const onCapturesChanged = listener => changeListeners.add(listener);

// An observer may look but not capture; an administrator holding the control lock may.
export const canCapture = () => !observing || holdingControl();

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Why a host cannot be captured at all (whatever the interface), or null.
function hostCaptureBlocker(machine) {
  if (!canCapture()) return 'Read-only observation: take control of the session to capture.';
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

export const captureAction = async (nodeId, captureId, verb, options) => requestJson(nodeUrl(nodeId, `captures${captureId ? `/${captureId}` : ''}${verb ? `/${verb}` : ''}`), options, 'Capture request failed.');

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
