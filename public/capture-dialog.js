// The Capture dialog: opened from the Capture button of a console pane (capture-button.js) or from
// the Graphic view link popover. "This host" chooses an interface, starts or stops its capture and
// lists the host's files (Download, Delete, Open live view); "All captures of the session" lists
// the files of every host. The rules and the requests are those of captures.js; nothing is decided
// here.
import {machines} from './state.js';
import {allCaptures, canCapture, captureBlocker, capturesOf, deleteCapture, downloadCapture, formatBytes, interfaceLabel, isRecording, loadAllCaptures, loadCaptures, nameOf, onCapturesChanged, preselectInterface, startCapture, stopCapture} from './captures.js';
import {setPaneView} from './terminal.js';
import {chooseLiveCapture} from './capture-live.js';

const POLL_MS = 2000;
const byId = id => document.getElementById(id);
const dialog = byId('capture-dialog');
const title = byId('capture-dialog-title');
const tabs = {host: byId('capture-tab-host'), all: byId('capture-tab-all')};
const panels = {host: byId('capture-panel-host'), all: byId('capture-panel-all')};
const select = byId('capture-interface');
const toggle = byId('capture-toggle');
const stateLine = byId('capture-state');
const hint = byId('capture-hint');
const files = byId('capture-files');
const allFiles = byId('capture-all-files');
const status = byId('capture-status');

// What the dialog shows: the host, the pane that opened it (it can switch to the Capture view; null
// from the Graphic view), the selected interface and the tab.
let current = {nodeId: null, pane: null, index: 0, tab: 'host'};
let optionsSignature = '';
let timer = null;

async function run(work) {
  status.textContent = '';
  try { await work(); } catch (error) { status.textContent = error.message; }
}

function button(text, label, key, onClick, disabled = false) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  element.title = label;
  element.dataset.key = key;
  element.disabled = disabled;
  element.addEventListener('click', onClick);
  return element;
}

// One capture file: name, state, size and time, then Stop (while recording), Open live view (when
// a pane opened the dialog), Download and Delete.
function fileRow(capture, {withHost = false} = {}) {
  const nodeId = capture.nodeId;
  const allowed = canCapture();
  const recording = isRecording(capture);
  const row = document.createElement('div');
  row.className = 'capture-row capture-file';
  const name = document.createElement('span');
  name.textContent = withHost ? `${nameOf(nodeId)} · ${capture.file}` : capture.file;
  name.title = capture.file;
  const note = document.createElement('span');
  note.className = 'capture-note';
  note.textContent = `${capture.message} · ${formatBytes(capture.bytes)} · ${new Date(capture.startedAt).toLocaleTimeString()}`;
  const actions = document.createElement('span');
  actions.className = 'capture-actions';
  const pane = !withHost && current.pane?.machineId === nodeId ? current.pane : null;
  const liveSupported = MonitorTerminal.isSupported(machines.get(nodeId));
  actions.append(
    ...(recording ? [button('Stop', 'Stop this capture', `${capture.id}:stop`, () => run(() => stopCapture(nodeId, capture.id)), !allowed)] : []),
    ...(pane ? [button('Open live view', 'Show the packets of this capture in this pane', `${capture.id}:live`, () => openLiveView(pane, capture), !allowed || !liveSupported)] : []),
    button('Download', capture.bytes <= 24 ? 'Nothing was captured yet' : 'Download the PCAP file', `${capture.id}:download`, () => run(() => downloadCapture(nodeId, capture)), !allowed || capture.bytes <= 24),
    button('Delete', recording ? 'Stop the capture first' : 'Delete the capture file', `${capture.id}:delete`, () => {
      if (confirm(`Delete ${capture.file}?`)) run(() => deleteCapture(nodeId, capture.id));
    }, !allowed || recording));
  row.append(name, note, actions);
  return row;
}

// The pane that opened the dialog shows the Capture view with this capture selected.
function openLiveView(pane, capture) {
  if (pane.machineId !== capture.nodeId) return;
  dialog.close();
  setPaneView(pane, 'capture');
  chooseLiveCapture(pane, capture.id);
}

// The lists are rebuilt as captures change: the button that had the focus keeps it.
function replaceList(container, nodes, empty) {
  const key = container.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  if (!nodes.length) {
    const message = document.createElement('p');
    message.className = 'capture-empty';
    message.textContent = empty;
    nodes = [message];
  }
  container.replaceChildren(...nodes);
  if (key) container.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
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

function renderHost(machine) {
  const captures = capturesOf(machine.id);
  if (current.index >= (machine.interfaces || []).length) current.index = preselectInterface(machine, captures);
  renderInterfaces(machine, captures);
  const recording = captures.find(item => item.index === current.index && isRecording(item));
  const blocker = captureBlocker(machine, current.index);
  toggle.textContent = recording ? 'Stop capture' : 'Start capture';
  toggle.dataset.recording = String(!!recording);
  toggle.disabled = recording ? !canCapture() : !!blocker;
  toggle.title = recording ? 'Stop capturing this interface' : blocker || 'Start capturing this interface';
  stateLine.textContent = recording ? `Recording · ${formatBytes(recording.bytes)}` : blocker || 'Not recording';
  hint.hidden = captures.length > 0;
  replaceList(files, captures.map(capture => fileRow(capture)), 'No capture file for this host yet.');
}

function render() {
  clearTimeout(timer);
  if (!dialog.open) return;
  const machine = machines.get(current.nodeId);
  if (!machine) { dialog.close(); return; }
  title.textContent = `Traffic capture · ${nameOf(machine.id)}`;
  for (const name of ['host', 'all']) {
    tabs[name].setAttribute('aria-selected', String(current.tab === name));
    tabs[name].tabIndex = current.tab === name ? 0 : -1;
    panels[name].hidden = current.tab !== name;
  }
  if (current.tab === 'host') renderHost(machine);
  else replaceList(allFiles, allCaptures().map(capture => fileRow(capture, {withHost: true})), 'No capture yet. Start one from the Capture button of a host.');
  // The size of a running capture is not pushed: look again while one is recording.
  if (current.tab === 'host' ? capturesOf(machine.id).some(isRecording) : allCaptures().some(isRecording)) {
    timer = setTimeout(() => (current.tab === 'host' ? loadCaptures(machine.id) : loadAllCaptures()), POLL_MS);
  }
}

function showTab(name) {
  current.tab = name;
  status.textContent = '';
  render();
  if (name === 'all') loadAllCaptures(); else loadCaptures(current.nodeId);
}

// Opens the dialog for host `nodeId`. `pane` is the console pane that asks (it can show the live
// view); `index` selects an interface, by default the one being recorded or the connected one.
export function openCaptureDialog(nodeId, {pane = null, index = null} = {}) {
  const machine = machines.get(nodeId);
  if (!machine || machine.kind !== 'host' || !canCapture()) return;
  current = {nodeId, pane, index: index ?? preselectInterface(machine, capturesOf(nodeId)), tab: 'host'};
  optionsSignature = '';
  status.textContent = '';
  if (!dialog.open) dialog.showModal();
  render();
  loadCaptures(nodeId);
}

export function initCaptureDialog() {
  select.addEventListener('change', () => { current.index = Number(select.value); render(); });
  toggle.addEventListener('click', () => {
    const recording = capturesOf(current.nodeId).find(item => item.index === current.index && isRecording(item));
    toggle.disabled = true;
    run(() => (recording ? stopCapture(current.nodeId, recording.id) : startCapture(current.nodeId, current.index))).finally(render);
  });
  for (const name of ['host', 'all']) tabs[name].addEventListener('click', () => showTab(name));
  byId('capture-dialog').querySelector('[role="tablist"]').addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const name = current.tab === 'host' ? 'all' : 'host';
    showTab(name);
    tabs[name].focus();
  });
  byId('close-capture-dialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { clearTimeout(timer); current.pane = null; });
  onCapturesChanged(render);
}
