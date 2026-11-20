// Socket.IO wiring: per-pane console sockets and the shared notification socket.
import {generalSettings, machines, store} from './state.js';
import {appendLog, finishReplay, fitTerminal, panes, refreshLogViews, renderConsoleView, renderLogView, selectPaneConsole, syncConsoleScroll, updatePaneViewControls, viewChannel} from './terminal.js';
import {captureView, renderTabs, showPage, showStatusError, updateControls} from './workspace.js';
import {updateEngineSelect} from './engine-select.js';
import {followEngineChange, scheduleSessionSync, syncSessionsFromServer} from './nodes.js';
import {sessionLost} from './api.js';
import {liveConnectionLost, receiveLiveData, receiveLiveEnd} from './capture-live.js';
import {forgetCaptures, loadAllCaptures, refreshCaptureAccess, refreshCaptureRules, setCaptures} from './captures.js';
import {applyControl, controlledByAdmin, holdingControl, observationUnavailable, observing, socketOptions, viewReceived} from './observe.js';

let socket = null;

// Emits on the page's session socket (take-control, release-control).
export function emitOnSession(event, ...args) {
  if (socket?.connected) socket.emit(event, ...args);
  else args.find(arg => typeof arg === 'function')?.({error: 'Not connected to the server.'});
}

// The page tells the other side what it shows: its view state (captureView, public/view-state.js).
// One rule decides who drives:
//   - the owner's page publishes owner-view (followed by observers), except while an
//     administrator controls one of its consoles;
//   - an observer's page publishes controller-view (followed by the owner's page) only while it
//     holds control.
// So there is never a loop. Called by viewChanged() (workspace.js); sends only actual changes
// (force: send again, after a reconnection or when the driver changes).
let published = null;
export function publishView({force = false} = {}) {
  if (!socket?.connected) return;
  const event = observing ? (holdingControl() ? 'controller-view' : null) : (controlledByAdmin() ? null : 'owner-view');
  if (!event) return;
  const view = captureView();
  if (!force && published?.event === event && ViewState.sameView(published.view, view)) return;
  published = {event, view};
  socket.emit(event, view);
}

function socketConnectError(error) {
  if (error?.message === 'Authentication required.' && sessionLost() !== 'none') return;
  showStatusError('WebSocket unavailable');
  console.error(error);
}

// Whether the pane currently shows that console channel (view 'console' = 0, 'console2' = 1).
const isChannelView = (pane, channel) => (pane.view === 'console' || pane.view === 'console2') && viewChannel(pane.view) === channel;

function attachPaneSocket(pane) {
  const reselect = () => {
    if (!pane.machineId) return;
    const nodeId = pane.machineId;
    selectPaneConsole(pane, result => {
      if (result?.error && pane.machineId === nodeId) showStatusError(result.error);
    });
  };
  pane.socket.on('connect', reselect);
  // The runner of the session is back after a network cut: it kept the console output, so the
  // console is selected again to get the snapshot that covers the gap.
  pane.socket.on('runner-state', ({online}) => { if (online) reselect(); });
  pane.socket.on('node-snapshot', snapshot => {
    const machine = machines.get(ConsoleId.baseNodeId(snapshot.nodeId));
    if (!machine || pane.machineId !== machine.id || pane.token !== snapshot.token) return;
    const channel = ConsoleId.consoleChannel(snapshot.nodeId);
    machine.running = snapshot.state.running;
    machine.hasLaunched = snapshot.state.hasLaunched;
    machine.message = snapshot.state.message;
    machine.error = /^Start failed:|^QEMU error|^VDE error|^VDE terminal stopped|^Serial console disconnected|^QEMU stopped \((?!0)\)|^VDE stopped \((?!0)\)/.test(machine.message || '') ? machine.message : null;
    machine.logs = snapshot.logs || [];
    if (channel === 1) machine.serial2 = snapshot.serial || '';
    else machine.serial = snapshot.serial || '';
    if (isChannelView(pane, channel)) renderConsoleView(pane);
    if (pane.view === 'log') renderLogView(pane);
    if (machine.id === store.activeId) updateControls();
    renderTabs();
    requestAnimationFrame(() => fitTerminal(pane));
  });
  pane.socket.on('serial-reset', event => {
    const machine = machines.get(ConsoleId.baseNodeId(event.nodeId));
    if (!machine || pane.machineId !== machine.id) return;
    const channel = ConsoleId.consoleChannel(event.nodeId);
    if (channel === 1) machine.serial2 = event.serial || '';
    else machine.serial = event.serial || '';
    if (!isChannelView(pane, channel)) return;
    const generation = ++pane.replayGeneration;
    pane.replaying = true;
    pane.replayPending = '';
    pane.terminal.write('', () => {
      if (generation !== pane.replayGeneration || machine.id !== pane.machineId || !isChannelView(pane, channel)) return;
      pane.terminal.reset();
      if (event.preserveLine && event.serial) pane.terminal.write(event.serial, () => finishReplay(pane, generation, machine.id));
      else finishReplay(pane, generation, machine.id);
    });
  });
  pane.socket.on('serial', event => {
    const machine = machines.get(ConsoleId.baseNodeId(event.nodeId));
    if (!machine || pane.machineId !== machine.id) return;
    const channel = ConsoleId.consoleChannel(event.nodeId);
    if (channel === 1) machine.serial2 = (machine.serial2 + event.data).slice(-262144);
    else machine.serial = (machine.serial + event.data).slice(-262144);
    if (!isChannelView(pane, channel)) return;
    if (pane.replaying) pane.replayPending += event.data;
    else pane.terminal.write(event.data, () => syncConsoleScroll(pane));
  });
  pane.socket.on('log', event => {
    const machine = machines.get(event.nodeId);
    if (!machine || pane.machineId !== event.nodeId) return;
    const earlierConnectedPane = panes.some(other => other.index < pane.index && other.machineId === event.nodeId && other.socket.connected);
    if (!earlierConnectedPane) appendLog(machine, event.line);
  });
  pane.socket.on('logs-reset', event => {
    const machine = machines.get(event.nodeId);
    if (!machine || pane.machineId !== event.nodeId) return;
    SessionLog.reset(machine);
    refreshLogViews(machine);
  });
  pane.socket.on('state', event => {
    const machine = machines.get(event.nodeId);
    if (!machine || pane.machineId !== event.nodeId) return;
    machine.running = event.running;
    if (event.hasLaunched !== undefined) machine.hasLaunched = event.hasLaunched;
    if (event.pendingRestart !== undefined) machine.pendingRestart = event.pendingRestart;
    if (event.serialPorts !== undefined) machine.serialPorts = event.serialPorts;
    machine.message = event.message;
    machine.error = /^Start failed:|^QEMU error|^VDE error|^VDE terminal stopped|^Serial console disconnected|^QEMU stopped \((?!0)\)|^VDE stopped \((?!0)\)/.test(event.message || '') ? machine.message : null;
    renderTabs();
    updateEngineSelect();
    if (machine.id === store.activeId) updateControls();
    updatePaneViewControls();
  });
  pane.socket.on('node-error', showStatusError);
  pane.socket.on('connect_error', socketConnectError);
}

export function initSockets() {
  socket = io(socketOptions({main: true}));
  panes.forEach(attachPaneSocket);
  socket.on('nodes-changed', event => {
    const machine = event && machines.get(event.nodeId);
    if (!machine) { scheduleSessionSync(); return; }
    machine.running = event.running;
    if (event.hasLaunched !== undefined) machine.hasLaunched = event.hasLaunched;
    if (event.pendingRestart !== undefined) machine.pendingRestart = event.pendingRestart;
    if (event.serialPorts !== undefined) machine.serialPorts = event.serialPorts;
    machine.message = event.message;
    machine.error = /^Start failed:|^QEMU error|^VDE error|^VDE terminal stopped|^Serial console disconnected|^QEMU stopped \((?!0\))|^VDE stopped \((?!0\))/.test(event.message || '') ? event.message : null;
    renderTabs();
    if (machine.id === store.activeId) updateControls();
    updatePaneViewControls();
    if (store.graphicVisible) scheduleSessionSync();
    refreshCaptureRules();
  });
  socket.on('captures', setCaptures);
  socket.on('capture-live-data', receiveLiveData);
  socket.on('capture-live-end', receiveLiveEnd);
  socket.on('disconnect', liveConnectionLost);
  socket.on('connect', () => { syncSessionsFromServer(); publishView({force: true}); loadAllCaptures(); });
  // The runner of the session is offline (a network cut; the machines keep running) or back.
  socket.on('runner-state', ({online}) => {
    if (!online) showStatusError('Runner offline, reconnecting…');
    else { syncSessionsFromServer(); publishView({force: true}); }
  });
  socket.on('general-settings-changed', event => {
    if (event?.engine && ['qemu', 'vbox'].includes(event.engine)) {
      followEngineChange(event.engine)
        .then(warning => { if (warning) showStatusError(warning); })
        .catch(error => showStatusError(`System list unavailable: ${error.message}`));
    }
  });
  socket.on('node-renamed', event => { const machine = machines.get(event.nodeId); if (machine) { machine.hostname = event.name; renderTabs(); if (machine.id === store.activeId) updateControls(); } });
  socket.on('nodes-removed', event => {
    for (const id of event.ids || []) machines.delete(id);
    forgetCaptures(event.ids || []);
    showPage();
  });
  socket.on('node-error', showStatusError);
  // The session was deleted (here or in another tab): reload into the new, empty one. An
  // observed session is gone: say so, with a link back to the Admin page.
  socket.on('session-deleted', () => { if (observing) observationUnavailable('deleted'); else location.reload(); });
  socket.on('observe-unavailable', () => observationUnavailable());
  socket.on('console-control', event => { applyControl(event); refreshCaptureAccess(); });
  socket.on('owner-view', view => viewReceived('owner', view));
  socket.on('controller-view', view => viewReceived('controller', view));
  socket.on('connect_error', socketConnectError);
}
