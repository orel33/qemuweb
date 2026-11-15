// Socket.IO wiring: per-pane console sockets and the shared notification socket.
import {generalSettings, machines, store} from './state.js';
import {appendLog, finishReplay, fitTerminal, panes, refreshLogViews, renderConsoleView, renderLogView, syncConsoleScroll} from './terminal.js';
import {renderTabs, showPage, showStatusError, updateControls} from './workspace.js';
import {scheduleSessionSync, syncSessionsFromServer} from './nodes.js';
import {defaultEngineSelect} from './general-settings.js';

let socket = null;

function attachPaneSocket(pane) {
  pane.socket.on('connect', () => {
    if (!pane.machineId) return;
    pane.token = ++store.selectionToken;
    const nodeId = pane.machineId;
    pane.socket.emit('select-node', nodeId, pane.token, result => {
      if (result?.error && pane.machineId === nodeId) showStatusError(result.error);
    });
  });
  pane.socket.on('node-snapshot', snapshot => {
    const machine = machines.get(snapshot.nodeId);
    if (!machine || pane.machineId !== snapshot.nodeId || pane.token !== snapshot.token) return;
    machine.running = snapshot.state.running;
    machine.hasLaunched = snapshot.state.hasLaunched;
    machine.message = snapshot.state.message;
    machine.error = /^Start failed:|^QEMU error|^VDE error|^VDE terminal stopped|^Serial console disconnected|^QEMU stopped \((?!0)\)|^VDE stopped \((?!0)\)/.test(machine.message || '') ? machine.message : null;
    machine.logs = snapshot.logs || [];
    machine.serial = snapshot.serial || '';
    if (pane.view === 'console') renderConsoleView(pane);
    if (pane.view === 'log') renderLogView(pane);
    if (machine.id === store.activeId) updateControls();
    renderTabs();
    requestAnimationFrame(() => fitTerminal(pane));
  });
  pane.socket.on('serial-reset', event => {
    const machine = machines.get(event.nodeId);
    if (!machine || pane.machineId !== event.nodeId) return;
    machine.serial = event.serial || '';
    if (pane.view !== 'console') return;
    const generation = ++pane.replayGeneration;
    pane.replaying = true;
    pane.replayPending = '';
    pane.terminal.write('', () => {
      if (generation !== pane.replayGeneration || machine.id !== pane.machineId || pane.view !== 'console') return;
      pane.terminal.reset();
      if (event.preserveLine && event.serial) pane.terminal.write(event.serial, () => finishReplay(pane, generation, machine.id));
      else finishReplay(pane, generation, machine.id);
    });
  });
  pane.socket.on('serial', event => {
    const machine = machines.get(event.nodeId);
    if (!machine || pane.machineId !== event.nodeId) return;
    machine.serial = (machine.serial + event.data).slice(-262144);
    if (pane.view !== 'console') return;
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
    machine.message = event.message;
    machine.error = /^Start failed:|^QEMU error|^VDE error|^VDE terminal stopped|^Serial console disconnected|^QEMU stopped \((?!0)\)|^VDE stopped \((?!0)\)/.test(event.message || '') ? machine.message : null;
    renderTabs();
    if (machine.id === store.activeId) updateControls();
  });
  pane.socket.on('node-error', showStatusError);
  pane.socket.on('connect_error', error => { showStatusError('WebSocket unavailable'); console.error(error); });
}

export function initSockets() {
  socket = io({transports: ['websocket', 'polling']});
  panes.forEach(attachPaneSocket);
  socket.on('nodes-changed', event => {
    const machine = event && machines.get(event.nodeId);
    if (!machine) { scheduleSessionSync(); return; }
    machine.running = event.running;
    if (event.hasLaunched !== undefined) machine.hasLaunched = event.hasLaunched;
    if (event.pendingRestart !== undefined) machine.pendingRestart = event.pendingRestart;
    machine.message = event.message;
    machine.error = /^Start failed:|^QEMU error|^VDE error|^VDE terminal stopped|^Serial console disconnected|^QEMU stopped \((?!0\))|^VDE stopped \((?!0\))/.test(event.message || '') ? event.message : null;
    renderTabs();
    if (machine.id === store.activeId) updateControls();
    if (store.graphicVisible) scheduleSessionSync();
  });
  socket.on('connect', syncSessionsFromServer);
  socket.on('general-settings-changed', event => {
    if (event?.engine && ['qemu', 'vbox'].includes(event.engine)) {
      generalSettings.engine = event.engine;
      defaultEngineSelect.value = event.engine;
    }
  });
  socket.on('node-renamed', event => { const machine = machines.get(event.nodeId); if (machine) { machine.hostname = event.name; renderTabs(); if (machine.id === store.activeId) updateControls(); } });
  socket.on('nodes-removed', event => {
    for (const id of event.ids || []) machines.delete(id);
    showPage();
  });
  socket.on('node-error', showStatusError);
  socket.on('connect_error', error => { showStatusError('WebSocket unavailable'); console.error(error); });
}
