// Editing in the Graphic view: add a host or a switch where the canvas is clicked, connect a host
// interface to a switch, remove a link. It reuses the existing code and routes: the add dialogs
// of the bottom toolbar, and PUT /api/nodes/:nodeId/config of the Host Settings dialog (a host's
// interfaces are part of its configuration; the server assigns the switch port).
import {machines} from './state.js';
import {jsonRequest, nodeUrl, requestJson} from './api.js';
import {observing} from './observe.js';
import {captureBlocker, recordingOf, startCapture, stopCapture} from './captures.js';
import {chooseRestartTiming, scheduleSessionSync} from './nodes.js';
import {renderTabs, showStatusError} from './workspace.js';
import {graphicCanvas, graphicGraph, renderGraphic, screenPoint, selectedGraphicLink, selectGraphicLink, setGraphicPosition} from './graphic-view.js';

const MAX_INTERFACES = 4;
const addHostButton = document.getElementById('graphic-add-host');
const addSwitchButton = document.getElementById('graphic-add-switch');
const connectButton = document.getElementById('graphic-connect');
const createDialog = document.getElementById('create-dialog');
const hostDialog = document.getElementById('qemu-options-panel');

// null, 'host' / 'switch' (the next click on the background adds one there) or 'connect'.
let mode = null;
let source = null; // connect mode: {hostId, nic} and/or {switchId}
let placement = null; // {point, known}: where the node being created goes

const hint = document.createElement('div');
hint.className = 'graphic-hint';
hint.setAttribute('role', 'status');
hint.hidden = true;
const popover = document.createElement('div');
popover.className = 'graphic-popover';
popover.hidden = true;

const nameOf = id => machines.get(id)?.hostname || id;

export function cancelEditMode() {
  mode = null;
  source = null;
  popover.hidden = true;
  refreshEditTools();
}

function setMode(next) {
  mode = mode === next ? null : next;
  source = null;
  popover.hidden = true;
  selectGraphicLink(null);
  refreshEditTools();
}

function hintText() {
  if (mode === 'host' || mode === 'switch') return `Click where the new ${mode} goes (Esc to cancel).`;
  if (mode !== 'connect') return '';
  if (source?.hostId != null && source.nic != null) return `Click the switch to connect ${nameOf(source.hostId)} eth${source.nic} to (Esc to cancel).`;
  if (source?.switchId) return `Click the host to connect to ${nameOf(source.switchId)} (Esc to cancel).`;
  return 'Click a host (then a switch), or a switch (then a host) to connect (Esc to cancel).';
}

function showPopover(kind, wx, wy, title, items) {
  const at = screenPoint(wx, wy);
  const key = `${kind}:${title}:${items.map(item => `${item.label}${item.disabled ? '!' : ''}`).join('|')}`;
  const fresh = popover.dataset.key !== key || popover.hidden;
  popover.dataset.kind = kind;
  popover.dataset.key = key;
  if (fresh) buildPopover(title, items);
  popover.hidden = false;
  const rect = graphicCanvas.getBoundingClientRect();
  popover.style.left = `${Math.max(4, Math.min(at.x, rect.width - popover.offsetWidth - 4))}px`;
  popover.style.top = `${Math.max(4, Math.min(at.y, rect.height - popover.offsetHeight - 4))}px`;
  if (fresh) popover.querySelector('button')?.focus({preventScroll: true});
}

function buildPopover(title, items) {
  popover.replaceChildren();
  const heading = document.createElement('div');
  heading.className = 'popover-title';
  heading.textContent = title;
  popover.append(heading);
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    button.className = item.capture ? 'capture-action' : 'write-action';
    button.disabled = !!item.disabled;
    if (item.reason) button.title = item.reason;
    button.addEventListener('click', () => { popover.hidden = true; item.run(); });
    popover.append(button);
  }
}

// Sets interface `nic` of a host to a switch (null: not connected), through the host
// configuration route; a running host needs a restart, offered like in Host Settings.
async function setInterface(hostId, nic, switchId) {
  try {
    const data = await requestJson(nodeUrl(hostId, 'config'), {cache: 'no-store'}, 'Cannot load host configuration.');
    const interfaces = [...data.interfaces];
    if (nic > interfaces.length || nic >= MAX_INTERFACES) throw new Error('A host has at most four interfaces.');
    interfaces[nic] = switchId;
    let restartNow = false;
    if (data.running) {
      const choice = await chooseRestartTiming();
      if (choice === 'cancel') return;
      restartNow = choice === 'now';
    }
    const saved = await requestJson(nodeUrl(hostId, 'config'), jsonRequest('PUT', {name: data.name, systemId: data.systemId, engine: data.engine,
      settings: data.settings, interfaces, guestMedia: data.guestMedia, startupDiskEnabled: data.startupDiskEnabled}), 'Cannot save host configuration.');
    const machine = machines.get(hostId);
    if (machine) {
      Object.assign(machine, {hostname: saved.name, settings: saved.settings, settingsLoaded: true, interfaces: saved.interfaces,
        networkInterfaces: saved.networkInterfaces, guestMedia: saved.guestMedia, startupDiskEnabled: saved.startupDiskEnabled, pendingRestart: saved.pendingRestart});
    }
    renderTabs();
    if (restartNow) {
      const result = await requestJson(`${nodeUrl(hostId)}/reboot`, {method: 'POST'}, 'Restart failed');
      if (machine && result) machine.pendingRestart = false;
    }
    scheduleSessionSync();
  } catch (error) {
    showStatusError(error.message);
    scheduleSessionSync();
  }
}

function chooseInterface(host, node) {
  const items = (host.interfaces || []).map((switchId, nic) => ({
    label: `eth${nic} · ${switchId ? `connected to ${nameOf(switchId)}` : 'not connected'}`,
    run: () => { source = {...source, hostId: host.id, nic}; afterPick(); }
  }));
  if (items.length < MAX_INTERFACES) {
    items.push({label: '+ New interface', run: () => { source = {...source, hostId: host.id, nic: items.length}; afterPick(); }});
  }
  showPopover('pick', node.x + 130, node.y - 50, `${host.hostname}: which interface?`, items);
}

function afterPick() {
  if (source?.hostId != null && source.nic != null && source.switchId) {
    const {hostId, nic, switchId} = source;
    cancelEditMode();
    setInterface(hostId, nic, switchId);
  } else refreshEditTools();
}

// Called by the Graphic view for a click on a node (`nodeId`) or on the background (`point`, in
// world coordinates). Returns true when an editing mode used the click.
export function handleEditClick({nodeId, point}) {
  if (mode === 'host' || mode === 'switch') {
    if (!point) return false;
    const kind = mode;
    placement = {point, known: new Set(machines.keys())};
    cancelEditMode();
    document.getElementById(kind === 'host' ? 'new-host' : 'new-switch').click();
    return true;
  }
  if (mode !== 'connect') return false;
  if (!nodeId) return true;
  const machine = machines.get(nodeId);
  const node = graphicGraph?.nodes.find(item => item.id === nodeId);
  if (!machine || !node) return true;
  popover.hidden = true;
  if (machine.kind === 'switch') { source = {...source, switchId: nodeId}; afterPick(); }
  else chooseInterface(machine, node);
  return true;
}

// Called after each drawing: tool states, hint, link popover, and the position of a node just
// created from a click.
export function refreshEditTools() {
  if (placement) {
    const created = [...machines.keys()].find(id => !placement.known.has(id));
    if (created) { setGraphicPosition(created, placement.point); placement = null; renderGraphic(); return; }
  }
  const unavailable = id => document.getElementById(id).disabled;
  addHostButton.disabled = unavailable('new-host');
  addSwitchButton.disabled = unavailable('new-switch');
  connectButton.disabled = !graphicGraph?.hosts || !graphicGraph?.switches;
  for (const [button, name] of [[addHostButton, 'host'], [addSwitchButton, 'switch'], [connectButton, 'connect']]) button.setAttribute('aria-pressed', String(mode === name));
  graphicCanvas.dataset.mode = mode || '';
  hint.textContent = hintText();
  hint.hidden = !mode;
  const id = selectedGraphicLink();
  const link = id && graphicGraph?.links.find(item => `${item.hostId}:${item.nicIndex}` === id);
  if (mode || !link || observing) { if (popover.dataset.kind === 'link') popover.hidden = true; return; }
  const portText = link.port == null ? '' : ` port ${link.port}`;
  const host = machines.get(link.hostId);
  const recording = recordingOf(link.hostId).find(capture => capture.index === link.nicIndex);
  const blocker = host && captureBlocker(host, link.nicIndex);
  const report = work => work.catch(error => showStatusError(error.message));
  const capture = recording
    ? {label: 'Stop capture', capture: true, run: () => report(stopCapture(link.hostId, recording.id))}
    : {label: 'Capture', capture: true, disabled: !!blocker, reason: blocker, run: () => report(startCapture(link.hostId, link.nicIndex))};
  showPopover('link', (link.x1 + link.x2) / 2, (link.y1 + link.y2) / 2, `${nameOf(link.hostId)} eth${link.nicIndex} ↔ ${nameOf(link.switchId)}${portText}`, [
    capture,
    {label: 'Captures…', capture: true, run: () => document.getElementById('show-captures').click()},
    {label: 'Remove link', run: () => { selectGraphicLink(null); setInterface(link.hostId, link.nicIndex, null); }}
  ]);
}

export function initGraphicEdit() {
  graphicCanvas.append(hint, popover);
  addHostButton.addEventListener('click', () => setMode('host'));
  addSwitchButton.addEventListener('click', () => setMode('switch'));
  connectButton.addEventListener('click', () => setMode('connect'));
  // A placement waits for the node its dialog creates; a dialog closed without one ends it.
  for (const dialog of [createDialog, hostDialog]) dialog.addEventListener('close', () => { placement = null; });
  popover.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); cancelEditMode(); selectGraphicLink(null); } });
}
