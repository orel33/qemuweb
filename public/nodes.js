// Node model, server synchronization and host/switch lifecycle actions.
import {generalSettings, machines, store} from './state.js';
import {jsonRequest, nodeUrl, requestJson} from './api.js';
import {createWithNewIds, newNodeId as newId} from './node-ids.js';
import {isConsoleView, panes, selectPaneConsole, syncConsoleScroll} from './terminal.js';
import {activeMachine, consoleSessions, renderTabs, restoreSavedView, resetSessionButton, resumeAllButton, selectMachine, showPage, showStatusError, stopAllButton, updateControls} from './workspace.js';
import {imageSelect} from './node-dialogs.js';
import {qemuOptionsPanel, renderQemuOptions, settingsMachine} from './host-settings.js';
import {generalSettingsError, namingSchemeSelect, showGeneralSettings} from './general-settings.js';
import {renderGraphic} from './graphic-view.js';
import {observedLogin, refollow} from './observe.js';
import {resetSessionText, sessionPhrase} from './file-kinds.js';
import {parseStartErrors, showStartFailure} from './start-failure.js';
import {engineName, bindEngineSelect, unavailableHostsWarning, updateEngineSelect} from './engine-select.js';
import {refreshSystems} from './systems.js';

const confirmDialog = document.getElementById('confirm-dialog');
const restartChoiceDialog = document.getElementById('restart-choice-dialog');
const restartChoiceMessage = document.getElementById('restart-choice-message');
const confirmTitle = document.getElementById('confirm-title');
const confirmMessage = document.getElementById('confirm-message');
const confirmAccept = document.getElementById('confirm-accept');

export function nextMachineName(kind) {
  const used = new Set([...machines.values()].map(machine => machine.hostname.toLowerCase()));
  const scheme = store.namingSchemes?.[generalSettings.namingScheme];
  if (Array.isArray(scheme?.names) && scheme.names.length) {
    for (let round = 0; ; round++) {
      const available = scheme.names
        .map(name => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''))
        .filter(Boolean)
        .map(base => `${base}${round ? round + 1 : ''}`)
        .filter(candidate => !used.has(candidate));
      if (available.length) return available[Math.floor(Math.random() * available.length)];
    }
  }
  const prefix = scheme?.prefixes?.[kind] || (kind === 'host' ? 'h' : 's');
  const numberWidth = scheme?.numberWidth || 1;
  let number = 1;
  while (used.has(`${prefix}${String(number).padStart(numberWidth, '0')}`)) number++;
  return `${prefix}${String(number).padStart(numberWidth, '0')}`;
}

// A new host or switch ID, none of the nodes of this page.
export const newNodeId = kind => newId(kind, machines);

export async function addHost({id = newNodeId('host'), name, imageId, engine, interfaces, settings, guestMedia, startupDiskEnabled = false, select = true}) {
  const image = store.images.find(item => item.id === imageId);
  let body;
  ({id, body} = await createWithNewIds('host', id, nodeId => requestJson('/api/hosts', jsonRequest('POST', {id: nodeId, name, imageId, engine, interfaces, settings, guestMedia, startupDiskEnabled}), 'Cannot create host'), machines));
  const machine = {id, kind: 'host', hostname: body.name, osHint: image?.label || 'System', imageId: body.imageId, hasDifferentialDisk: !!image?.hasDifferentialDisk, engine: body.engine, interfaces: body.interfaces, networkInterfaces: body.networkInterfaces || [], settings: body.settings, settingsLoaded: !!body.settings, guestMedia: body.guestMedia, startupDiskEnabled: body.startupDiskEnabled, serialPorts: body.settings?.serialPorts ?? ['ttyS0'], running: false, hasLaunched: false, addresses: {}, message: 'Host ready to start', logs: [], serial: '', serial2: '', monitorOutput: ''};
  machines.set(id, machine);
  if (select) selectMachine(id);
  else renderGraphic();
  return machine;
}
export async function addSwitch({name, autostart}) {
  const {id, body} = await createWithNewIds('switch', newNodeId('switch'), nodeId => requestJson('/api/switches', jsonRequest('POST', {id: nodeId, name, autostart}), 'Cannot create switch'), machines);
  machines.set(id, {id, kind: 'switch', hostname: body.name, osHint: 'VDE switch', interfaces: [], running: body.running, hasLaunched: body.running, message: body.message, logs: [], serial: ''});
  selectMachine(id);
}

export function confirmAction(title, message, action) {
  if (confirmDialog.open) return Promise.resolve(false);
  confirmTitle.textContent = `QemuWeb · ${title}`;
  confirmMessage.textContent = message;
  confirmAccept.textContent = action;
  confirmDialog.returnValue = '';
  return new Promise(resolve => {
    confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'confirm'), {once: true});
    confirmDialog.showModal();
  });
}
export function chooseRestartTiming() {
  if (restartChoiceDialog.open) return Promise.resolve('cancel');
  restartChoiceMessage.textContent = 'These changes need a restart to take effect. Restart now after saving, or later?';
  restartChoiceDialog.returnValue = '';
  return new Promise(resolve => {
    restartChoiceDialog.addEventListener('close', () => {
      resolve(['now', 'later'].includes(restartChoiceDialog.returnValue) ? restartChoiceDialog.returnValue : 'cancel');
    }, {once: true});
    restartChoiceDialog.showModal();
  });
}
export async function closeMachine(id) {
  const machine = machines.get(id);
  if (!machine || machine.busy) return;
  const title = machine.kind === 'switch' ? 'Remove switch' : 'Remove host';
  const message = machine.kind === 'switch'
    ? `Remove ${machine.hostname}? The switch will stop and its tab will close. Connected host tabs must be closed first.`
    : machine.hasLaunched
      ? `Remove ${machine.hostname}? This host will stop, its current disk will be deleted, and all changes made in this host will be lost.`
      : `Remove ${machine.hostname} from this session?`;
  if (!await confirmAction(title, message, title)) return;
  if (machines.get(id) !== machine || machine.busy) return;
  try {
    await requestJson(nodeUrl(id), {method: 'DELETE'}, 'Failed to remove host or switch');
    machines.delete(id);
    showPage(store.activeId !== id ? store.activeId : null);
  } catch (error) { showStatusError(`Cannot remove host or switch: ${error.message}`); }
}

function machineFromSession(session) {
  const image = store.images.find(item => item.id === session.imageId);
  return {
    id: session.id, kind: session.kind || 'host', hostname: session.hostname,
    osHint: session.kind === 'switch' ? 'VDE switch' : (image?.label || 'Unknown system'),
    imageId: image ? image.id : (store.images[0]?.id || ''),
    settings: session.settings || null, settingsLoaded: !!session.settings,
    hasDifferentialDisk: session.hasDifferentialDisk ?? !!image?.hasDifferentialDisk,
    engine: session.engine || generalSettings.engine,
    interfaces: (session.networkInterfaces || []).map(nic => nic.switchId),
    networkInterfaces: session.networkInterfaces || [],
    running: session.running, hasLaunched: session.hasLaunched, pendingRestart: !!session.pendingRestart,
    addresses: session.addresses || {},
    serialPorts: session.serialPorts ?? ['ttyS0'],
    message: session.message,
    error: /^QEMU error|^VDE error|^VDE terminal stopped|^Serial console disconnected|^QEMU stopped \((?!0)\)|^VDE stopped \((?!0)\)/.test(session.message || '') ? session.message : null,
    logs: [], serial: '', serial2: '', monitorOutput: ''
  };
}
function mergeSession(session) {
  if (!session.hostname) return;
  const current = machines.get(session.id);
  if (!current) { machines.set(session.id, machineFromSession(session)); return; }
  current.hostname = session.hostname;
  current.running = session.running;
  current.hasLaunched = session.hasLaunched;
  current.pendingRestart = !!session.pendingRestart;
  current.addresses = session.addresses || {};
  current.serialPorts = session.serialPorts ?? ['ttyS0'];
  current.message = session.message;
  current.error = /^Start failed:|^QEMU error|^VDE error|^VDE terminal stopped|^Serial console disconnected|^QEMU stopped \((?!0)\)|^VDE stopped \((?!0)\)/.test(session.message || '') ? session.message : null;
  current.networkInterfaces = session.networkInterfaces || [];
  current.hasDifferentialDisk = session.hasDifferentialDisk ?? current.hasDifferentialDisk;
  if (session.kind === 'host' && session.settings) { current.settings = session.settings; current.settingsLoaded = true; }
  if (!(qemuOptionsPanel.open && settingsMachine()?.id === session.id)) {
    const image = store.images.find(item => item.id === session.imageId);
    current.imageId = image ? image.id : (session.imageId || store.images[0]?.id || '');
    current.osHint = session.kind === 'switch' ? 'VDE switch' : (image?.label || 'Unknown system');
    current.engine = session.engine || generalSettings.engine;
    current.interfaces = current.networkInterfaces.map(nic => nic.switchId);
  }
}
let sessionSyncTimer = null;
export function scheduleSessionSync() {
  if (sessionSyncTimer) return;
  sessionSyncTimer = setTimeout(() => { sessionSyncTimer = null; syncSessionsFromServer(); }, 100);
}
export async function syncSessionsFromServer() {
  try {
    const current = await requestJson('/api/nodes', {cache: 'no-store'}, 'Cannot refresh sessions');
    const currentIds = new Set(current.map(session => session.id));
    for (const id of machines.keys()) if (!currentIds.has(id)) machines.delete(id);
    for (const session of current) mergeSession(session);
    const index = consoleSessions().findIndex(machine => machine.id === store.activeId);
    if (index >= 0) store.pageIndex = Math.floor(index / store.layoutSize);
    showPage(index >= 0 ? store.activeId : null);
    refollow();
  } catch (error) { showStatusError(error.message); }
}

export async function startActiveMachine() {
  const machine = activeMachine();
  if (!machine || machine.running || machine.busy) return;
  const pane = panes[store.activePaneIndex];
  if (machine.kind === 'switch') {
    machine.busy = true; machine.operation = 'starting'; machine.error = null; updateControls();
    try {
      await requestJson(nodeUrl(machine.id, 'start'), {method: 'POST'}, 'Cannot start switch');
      machine.running = true; machine.hasLaunched = true;
      pane.socket.emit('terminal-resize', {id: machine.id, cols: pane.terminal.cols, rows: pane.terminal.rows});
      pane.terminal.focus();
    } catch (error) { machine.error = error.message; machine.message = error.message; }
    finally { machine.busy = false; updateControls(); renderTabs(); }
    return;
  }
  machine.busy = true;
  machine.operation = 'starting';
  machine.error = null;
  const image = store.images.find(item => item.id === machine.imageId);
  machine.osHint = image?.label || 'System';
  machine.hasDifferentialDisk = !!image?.hasDifferentialDisk;
  machine.message = 'Starting…';
  updateControls();
  renderQemuOptions();
  renderTabs();
  if (isConsoleView(pane.view)) {
    pane.replaying = true;
    pane.replayPending = '';
    pane.terminal.reset();
    syncConsoleScroll(pane);
    pane.terminal.write(`${machine.hasLaunched ? 'Resuming' : 'Starting'} ${machine.imageId} (${machine.osHint})…\r\n`, () => syncConsoleScroll(pane));
  }
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Console connection unavailable.')), 5000);
      selectPaneConsole(pane, result => { clearTimeout(timeout); if (result && result.error) reject(new Error(result.error)); else resolve(); });
    });
    const config = await requestJson(nodeUrl(machine.id, 'config'), {cache: 'no-store'}, 'Cannot load host configuration.');
    machine.settings = config.settings;
    machine.settingsLoaded = true;
    machine.interfaces = config.interfaces;
    machine.networkInterfaces = config.networkInterfaces;
    machine.guestMedia = config.guestMedia;
    machine.startupDiskEnabled = config.startupDiskEnabled;
    const body = await requestJson(nodeUrl(machine.id, 'start'), jsonRequest('POST', {engine: machine.engine, imageId: machine.imageId}), 'Failed to start');
    machine.hostname = body.name;
    machine.hasLaunched = true;
    machine.running = true;
    scheduleSessionSync();
    renderQemuOptions();
    if (isConsoleView(pane.view)) pane.terminal.focus();
  } catch (error) {
    machine.running = false;
    machine.message = error.message;
    machine.error = error.message;
    showStartFailure([{host: machine.hostname, message: error.message}]);
  } finally {
    machine.busy = false;
    updateControls();
    renderTabs();
  }
}
export async function stopActiveMachine() {
  const machine = activeMachine();
  if (!machine || !machine.running) return;
  machine.busy = true;
  machine.operation = 'stopping';
  machine.error = null;
  machine.message = 'Stopping…';
  updateControls();
  try {
    const route = nodeUrl(machine.id, 'stop');
    await requestJson(route, {method: 'POST'}, 'Failed to stop');
    machine.running = false;
    machine.message = machine.kind === 'switch' ? 'VDE switch stopped' : 'Host stopped; current disk kept';
  } catch (error) { machine.message = error.message; machine.error = error.message; }
  finally { machine.busy = false; updateControls(); }
}
export function removeActiveMachine() { if (store.activeId) return closeMachine(store.activeId); }

export async function rebootActiveMachine() {
  const machine = activeMachine();
  if (!machine || !machine.running || machine.busy) return;
  machine.busy = true;
  machine.operation = 'rebooting';
  machine.error = null;
  machine.message = 'Rebooting…';
  updateControls();
  try {
    await requestJson(nodeUrl(machine.id, 'reboot'), {method: 'POST'}, 'Failed to reboot');
  } catch (error) { machine.message = error.message; machine.error = error.message; showStartFailure([{host: machine.hostname, message: error.message}]); }
  finally { machine.busy = false; updateControls(); }
}
export async function resetActiveMachine() {
  const machine = activeMachine();
  if (!machine || !machine.hasLaunched || machine.busy) return;
  if (!await confirmAction('Reset host', `Reset ${machine.hostname}?\n\nThis host will restart from its base image. Its current ${engineName(machine.engine)} disk will be deleted, so all changes made in this host with this engine will be lost. The disk of the other engine, if any, is kept.\n\nOther hosts will not be affected.`, 'Reset host')) return;
  if (machines.get(machine.id) !== machine || machine.busy) return;
  machine.busy = true;
  machine.operation = 'resetting';
  machine.error = null;
  machine.message = 'Resetting from base image…';
  updateControls();
  try {
    await requestJson(nodeUrl(machine.id, 'reset'), {method: 'POST'}, 'Failed to reset');
    machine.hasLaunched = true;
    machine.running = true;
  } catch (error) { machine.message = error.message; machine.error = error.message; }
  finally { machine.busy = false; updateControls(); }
}

// Resets the session: every host and switch stops and is removed, the session stays, empty (the Reset session button,
// and the Load dialog before a load replaces the current nodes); throws the server's error message.
export async function resetSession() {
  store.sessionBusy = true; updateControls();
  try {
    await requestJson('/api/session/reset', {method: 'POST'}, 'Cannot reset the session');
    machines.clear();
    showPage();
  } finally { store.sessionBusy = false; updateControls(); }
}

// The page follows a change of the session engine (made here or in another tab): the system list,
// the hosts (settings and disk state of the new engine) and the select are read again. Returns
// the warning about the hosts that cannot start with the new engine ('' if none).
export async function followEngineChange(engine = generalSettings.engine) {
  generalSettings.engine = engine;
  const [, settings, existing] = await Promise.all([
    refreshSystems(),
    requestJson('/api/general-settings', {cache: 'no-store'}, 'Session settings unavailable'),
    requestJson('/api/nodes', {cache: 'no-store'}, 'Cannot read the hosts')
  ]);
  store.availableEngines = settings.availableEngines || [];
  for (const session of existing) mergeSession(session);
  renderTabs();
  updateControls();
  updateEngineSelect();
  return unavailableHostsWarning(settings.unavailableHosts);
}

export function initNodes() {
  bindEngineSelect({
    onChanged: async body => {
      const warning = await followEngineChange(body.engine);
      if (warning) showStatusError(warning);
    },
    onError: message => showStatusError(`Cannot change the session engine: ${message}`)
  });
  Promise.all([
    fetch('/api/systems').then(response => response.json()),
    fetch('/api/general-settings').then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Session settings unavailable'); return body; }),
    fetch('/api/nodes').then(response => response.json()),
    fetch('/resources/naming-schemes.json').then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }).catch(error => ({error: error.message}))
  ]).then(([items, sessionSettings, existing, schemes]) => {
    generalSettings.engine = sessionSettings.engine;
    store.availableEngines = sessionSettings.availableEngines || [];
    store.images = items;
    store.namingSchemes = schemes?.classic?.prefixes ? schemes : {classic: {label: 'Classic (h1, s1, ...)', prefixes: {host: 'h', switch: 's'}}};
    if (schemes?.error || !schemes?.classic?.prefixes) {
      generalSettingsError.textContent = `Naming schemes unavailable: ${schemes?.error || 'invalid resource file'}. Classic naming is available.`;
      generalSettingsError.hidden = false;
    }
    namingSchemeSelect.replaceChildren(...Object.entries(store.namingSchemes).map(([id, scheme]) => new Option(scheme.label, id)));
    if (!store.namingSchemes[generalSettings.namingScheme]) generalSettings.namingScheme = store.namingSchemes.classicLong ? 'classicLong' : 'classic';
    namingSchemeSelect.value = generalSettings.namingScheme;
    showGeneralSettings.disabled = false;
    document.getElementById('new-switch').disabled = false;
    imageSelect.replaceChildren(...items.map(image => { const option = document.createElement('option'); option.value = image.id; option.textContent = image.label; return option; }));
    document.getElementById('new-host').disabled = !items.length;
    for (const session of existing) mergeSession(session);
    showPage();
    updateEngineSelect();
    restoreSavedView();
    refollow();
    const warning = unavailableHostsWarning(sessionSettings.unavailableHosts);
    if (warning) showStatusError(warning);
  }).catch(error => { restoreSavedView(); showStatusError(`System list unavailable: ${error.message}`); });
  // Starts every stopped switch, then every stopped host (no confirmation); the state events
  // refresh the UI, and a node that cannot start shows its "Start failed" state.
  resumeAllButton.onclick = async () => {
    if (resumeAllButton.disabled) return;
    store.sessionBusy = true; updateControls();
    try {
      const {startErrors} = await requestJson('/api/nodes/resume-all', {method: 'POST'}, 'Failed to resume all hosts and switches');
      if (startErrors.length) {
        showStatusError(`Some nodes could not start: ${startErrors.join('; ')}`);
        showStartFailure(parseStartErrors(startErrors));
      }
    } catch (error) { showStatusError(`Cannot resume all hosts and switches: ${error.message}`); }
    finally { store.sessionBusy = false; updateControls(); }
  };
  // Stops every host and switch of the session and keeps them; the state events refresh the UI.
  stopAllButton.onclick = async () => {
    if (stopAllButton.disabled) return;
    if (!await confirmAction('Stop all hosts and switches', `Stop every running host and switch of ${sessionPhrase(observedLogin)}?\n\nThe hosts are shut down; their disks and the nodes are kept.`, 'Stop all')) return;
    store.sessionBusy = true; updateControls();
    try { await requestJson('/api/nodes/stop-all', {method: 'POST'}, 'Failed to stop all hosts and switches'); }
    catch (error) { showStatusError(`Cannot stop all hosts and switches: ${error.message}`); }
    finally { store.sessionBusy = false; updateControls(); }
  };
  resetSessionButton.onclick = async () => {
    if (resetSessionButton.disabled) return;
    if (!await confirmAction('Reset session', resetSessionText(observedLogin), 'Reset session')) return;
    try { await resetSession(); }
    catch (error) { showStatusError(`Cannot reset the session: ${error.message}`); }
  };
}
