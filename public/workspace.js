// Pane layout, paging, node tabs, pane state badges and resource metrics.
import {machines, saveViewSettings, store} from './state.js';
import {jsonRequest, nodeUrl} from './api.js';
import {fitTerminal, fitTerminals, panes, updatePaneViewControls} from './terminal.js';
import {closeMachine} from './nodes.js';
import {createDialog, engineSelect, imageSelect} from './node-dialogs.js';
import {renderQemuOptions} from './host-settings.js';
import {renderGraphic} from './topology.js';

let workspaceError = null;
const resourceMetrics = new Map();
let resourceRequestPending = false;

export const workspace = document.getElementById('console-workspace');

export const exitAllButton = document.getElementById('exit-all');
export const cloneButton = document.getElementById('clone-machine');

const tabs = document.getElementById('machine-tabs');

const toggleConsoleColumns = document.getElementById('toggle-console-columns');
const toggleSwitchConsoles = document.getElementById('toggle-switch-consoles');
const layoutCount = document.getElementById('layout-count');
const previousPage = document.getElementById('previous-page');
const nextPage = document.getElementById('next-page');
const pagePosition = document.getElementById('page-position');

export function activeMachine() { return store.activeId ? machines.get(store.activeId) : null; }

function updatePaneActionMenu(pane, machine) {
  pane.actionMenu.hidden = !machine;
  if (!machine) { pane.actionMenu.open = false; return; }
  const busy = !!machine.busy;
  const isSwitch = machine.kind === 'switch';
  pane.actionMenu.querySelector('summary').setAttribute('aria-label', `Actions for ${machine.hostname}`);
  pane.actionButtons.play.querySelector('span').textContent = machine.hasLaunched ? 'Resume' : 'Play';
  pane.actionButtons.play.disabled = machine.running || busy || (!isSwitch && !store.images.length);
  pane.actionButtons.stop.disabled = !machine.running || busy;
  pane.actionButtons.reboot.hidden = isSwitch;
  pane.actionButtons.reboot.disabled = isSwitch || !machine.running || busy;
  pane.actionButtons.reset.hidden = isSwitch;
  pane.actionButtons.reset.disabled = isSwitch || !machine.hasLaunched || busy;
  pane.actionButtons.remove.disabled = busy;
}
function updatePaneStates() {
  for (const pane of panes) {
    const machine = pane.machineId && machines.get(pane.machineId);
    updatePaneActionMenu(pane, machine);
    pane.settingsButton.hidden = !machine || machine.kind !== 'host';
    pane.clearButton.hidden = !machine;
    pane.clearButton.disabled = !machine || pane.view !== 'console';
    pane.expandButton.hidden = !machine || (store.layoutSize === 1 && store.expandedPaneIndex === null);
    for (const button of pane.fontButtons) button.hidden = !machine;
    const state = machine
      ? machine.error ? 'error' : machine.busy ? (machine.operation || 'starting') : machine.running ? 'running' : 'stopped'
      : workspaceError && pane.index === store.activePaneIndex ? 'error' : 'empty';
    pane.state.dataset.state = state;
    pane.state.hidden = state === 'empty';
    pane.state.textContent = state.toUpperCase();
    pane.state.title = machine ? (machine.error || machine.message || '') : (state === 'error' ? workspaceError : '');
    pane.metrics.hidden = !machine || machine.kind !== 'host';
    if (!pane.metrics.hidden) {
      const sample = machine.running ? resourceMetrics.get(machine.id) : null;
      const cpu = Number.isFinite(sample?.cpuPercent) ? `${sample.cpuPercent.toFixed(1)}%` : '—';
      const ram = Number.isFinite(sample?.ramBytes) ? `${Math.round(sample.ramBytes / 1e6)} MB` : '—';
      pane.metrics.textContent = `CPU ${cpu} · RAM ${ram}`;
      pane.metrics.dataset.status = sample?.status || 'unavailable';
      pane.metrics.title = 'Host VM process: CPU (100% = one logical CPU), resident RAM (RSS). — means unavailable.';
    }
  }
}
async function refreshResourceMetrics() {
  if (resourceRequestPending) return;
  resourceRequestPending = true;
  try {
    const response = await fetch('/api/metrics', {cache: 'no-store'});
    if (!response.ok) throw new Error(`Metrics HTTP ${response.status}`);
    const samples = await response.json();
    resourceMetrics.clear();
    for (const [id, sample] of Object.entries(samples)) resourceMetrics.set(id, sample);
  } catch (_) { resourceMetrics.clear(); }
  finally { resourceRequestPending = false; updatePaneStates(); }
}

function renderPaneTitles() {
  for (const pane of panes) {
    const machine = pane.machineId && machines.get(pane.machineId);
    const title = machine ? `${machine.hostname} · ${machine.kind === 'switch' ? 'VDE switch' : machine.osHint}` : machines.size ? 'Unused terminal' : 'Add a host or switch';
    pane.title.textContent = title;
    pane.title.title = title;
    pane.title.dataset.empty = String(!machine);
    pane.element.dataset.empty = String(!machine);
    pane.title.hidden = !!machine;
    pane.sessionMenu.hidden = !machine;
    if (machine) {
      pane.sessionLabel.textContent = title;
      pane.sessionToggle.title = `Select another ${machine.kind === 'switch' ? 'switch' : 'host'}`;
      pane.sessionToggle.setAttribute('aria-label', `${title} · select another ${machine.kind === 'switch' ? 'switch' : 'host'}`);
    } else pane.sessionMenu.open = false;
    pane.element.dataset.active = String(pane.index === store.activePaneIndex);
  }
  updatePaneViewControls();
  updatePaneStates();
}
export function renderPaneSessionOptions(pane) {
  const machine = pane.machineId && machines.get(pane.machineId);
  if (!machine) { pane.sessionList.replaceChildren(); return; }
  pane.sessionList.setAttribute('aria-label', machine.kind === 'switch' ? 'Switches' : 'Hosts');
  pane.sessionList.replaceChildren(...[...machines.values()].filter(item => item.kind === machine.kind).map(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${item.hostname} · ${item.kind === 'switch' ? 'VDE switch' : item.osHint}`;
    button.setAttribute('aria-current', String(item.id === machine.id));
    button.addEventListener('click', () => {
      pane.sessionMenu.open = false;
      swapPaneSession(pane, item.id);
    });
    return button;
  }));
}
function swapPaneSession(pane, selectedId) {
  const current = machines.get(pane.machineId);
  const selected = machines.get(selectedId);
  if (!current || !selected || current.kind !== selected.kind) return;
  if (current.id === selected.id) { focusPane(pane.index); return; }
  const entries = [...machines.entries()];
  const currentIndex = entries.findIndex(([id]) => id === current.id);
  const selectedIndex = entries.findIndex(([id]) => id === selected.id);
  [entries[currentIndex], entries[selectedIndex]] = [entries[selectedIndex], entries[currentIndex]];
  machines.clear();
  for (const [id, machine] of entries) machines.set(id, machine);
  showPage(selected.id, true);
}
export function consoleSessions() {
  return [...machines.values()].filter(machine => store.showSwitchConsoles || machine.kind !== 'switch');
}
function updateSwitchConsoleToggle() {
  const label = store.showSwitchConsoles ? 'Hide switch consoles' : 'Show switch consoles';
  toggleSwitchConsoles.setAttribute('aria-pressed', String(store.showSwitchConsoles));
  toggleSwitchConsoles.setAttribute('aria-label', label);
  toggleSwitchConsoles.title = label;
  toggleSwitchConsoles.querySelector('svg').innerHTML = store.showSwitchConsoles
    ? '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'
    : '<path d="m3 3 18 18"/><path d="M10.6 5.1A11.8 11.8 0 0 1 12 5c6.5 0 10 7 10 7a16.7 16.7 0 0 1-3.1 3.8M6.2 6.2C3.5 8 2 12 2 12s3.5 7 10 7c1.4 0 2.7-.3 3.8-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>';
}

function updateWorkspaceLayout() {
  workspace.dataset.columns = String(store.expandedPaneIndex === null ? store.layoutSize : 1);
  const nextSize = store.layoutSize === 1 ? 2 : store.layoutSize === 2 ? 4 : 1;
  toggleConsoleColumns.title = store.expandedPaneIndex === null
    ? `Layout: ${store.layoutSize} pane${store.layoutSize === 1 ? '' : 's'}; click for ${nextSize}`
    : `Restore the ${store.layoutSize}-pane layout using the terminal button`;
  toggleConsoleColumns.setAttribute('aria-label', toggleConsoleColumns.title);
  toggleConsoleColumns.disabled = store.expandedPaneIndex !== null;
  layoutCount.textContent = String(store.layoutSize);
  for (const pane of panes) {
    pane.element.hidden = pane.index >= store.layoutSize || (store.expandedPaneIndex !== null && pane.index !== store.expandedPaneIndex);
    const expanded = pane.index === store.expandedPaneIndex;
    const label = expanded ? `Restore ${store.layoutSize}-terminal layout` : 'Show only this terminal';
    pane.expandButton.title = label;
    pane.expandButton.setAttribute('aria-label', label);
    pane.expandButton.setAttribute('aria-pressed', String(expanded));
    if (pane.expandButton.dataset.expanded !== String(expanded)) {
      pane.expandButton.dataset.expanded = String(expanded);
      pane.expandButton.innerHTML = expanded
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
    }
  }
  const pages = Math.ceil(consoleSessions().length / store.layoutSize);
  previousPage.disabled = store.pageIndex === 0;
  nextPage.disabled = store.pageIndex >= pages - 1;
  pagePosition.textContent = pages ? `${store.pageIndex + 1} / ${pages}` : '0 / 0';
  fitTerminals();
  requestAnimationFrame(fitTerminals);
}

export function togglePaneExpansion(pane) {
  if (!pane.machineId || (store.layoutSize === 1 && store.expandedPaneIndex === null)) return;
  store.expandedPaneIndex = store.expandedPaneIndex === pane.index ? null : pane.index;
  focusPane(pane.index);
  requestAnimationFrame(() => { fitTerminals(); pane.terminal.focus(); });
}
function setPaneSessions(ids, activeIndex = 0, preserveExpansion = false) {
  const before = panes.map(pane => pane.machineId);
  panes.forEach((pane, index) => { pane.machineId = ids[index] || null; });
  if (!preserveExpansion && store.expandedPaneIndex !== null && before[store.expandedPaneIndex] !== panes[store.expandedPaneIndex].machineId) store.expandedPaneIndex = null;
  panes.forEach(pane => {
    if (before[pane.index] === pane.machineId) return;
    pane.actionMenu.open = false;
    pane.sessionMenu.open = false;
    pane.view = 'console';
    pane.monitorInput = '';
    pane.monitorAvailable = false;
    pane.replayGeneration++;
    pane.replayPending = '';
    pane.replaying = !!pane.machineId;
    pane.cursorReportDeadline = 0;
    pane.terminal.reset();
  });
  store.activePaneIndex = activeIndex;
  store.activeId = panes[activeIndex].machineId;
  if (store.activeId) workspaceError = null;
  updateWorkspaceLayout();
  renderTabs();
  updateControls();
  const machine = activeMachine();
  if (machine) {
    renderQemuOptions();
  }
  panes.forEach(pane => {
    if (!pane.machineId || before[pane.index] === pane.machineId) return;
    pane.token = ++store.selectionToken;
    const nodeId = pane.machineId;
    pane.socket.emit('select-node', nodeId, pane.token, result => {
      if (result?.error && pane.machineId === nodeId) showStatusError(result.error);
    });
  });
  panes.forEach(pane => {
    if (before[pane.index] && !pane.machineId) pane.socket.emit('leave-node', before[pane.index]);
  });
  requestAnimationFrame(fitTerminals);
}
export function showPage(preferredId = null, preserveExpansion = false) {
  const sessions = consoleSessions();
  const pages = Math.ceil(sessions.length / store.layoutSize);
  store.pageIndex = Math.max(0, Math.min(store.pageIndex, Math.max(0, pages - 1)));
  const ids = sessions.slice(store.pageIndex * store.layoutSize, (store.pageIndex + 1) * store.layoutSize).map(machine => machine.id);
  const preferredIndex = preferredId ? ids.indexOf(preferredId) : -1;
  const activeIndex = preferredIndex >= 0 ? preferredIndex : Math.min(store.activePaneIndex, Math.max(0, ids.length - 1));
  setPaneSessions(ids, activeIndex, preserveExpansion);
}
export function focusPane(index) {
  if (store.expandedPaneIndex !== null && store.expandedPaneIndex !== index) store.expandedPaneIndex = null;
  store.activePaneIndex = index;
  const pane = panes[index];
  store.activeId = pane.machineId;
  panes.forEach(item => item.element.dataset.active = String(item.index === index));
  updateWorkspaceLayout();
  tabs.querySelectorAll('.machine-tab').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.nodeId === store.activeId)));
  updateControls();
  const machine = activeMachine();
  if (machine) {
    renderQemuOptions();
  }
  requestAnimationFrame(() => fitTerminal(pane));
}
export function showStatusError(message) {
  const machine = activeMachine();
  if (machine) { machine.error = String(message); updateControls(); }
  else { workspaceError = String(message); updatePaneStates(); }
}

export function renderTabs() {
  tabs.querySelectorAll('.machine-tab').forEach(tab => tab.remove());
  for (const machine of machines.values()) {
    const tab = document.createElement('div');
    tab.className = 'machine-tab';
    tab.dataset.nodeId = machine.id;
    tab.setAttribute('aria-selected', String(machine.id === store.activeId));
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'machine-name';
    select.textContent = machine.hostname;
    select.title = machine.osHint;
    select.onclick = () => { if (machine.id !== store.activeId) selectMachine(machine.id); };
    select.ondblclick = async () => {
      if (machine.kind === 'switch' || !machine.hasLaunched) return;
      const name = window.prompt('Display name for this host:', machine.hostname);
      if (name === null || !name.trim()) return;
      try {
        const response = await fetch(nodeUrl(machine.id), jsonRequest('PATCH', {name}));
        const body = await response.json();
        if (!response.ok) throw new Error(body.error);
      } catch (error) { showStatusError(error.message); }
    };
    select.title = machine.kind === 'switch' ? 'VDE switch management console' : machine.hasLaunched ? `${machine.osHint} · double-click to rename` : `New host · ${machine.osHint}`;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'machine-close';
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    close.title = machine.kind === 'switch' ? 'Remove switch' : 'Remove host and delete its working disk';
    close.setAttribute('aria-label', `${machine.kind === 'switch' ? 'Remove switch' : 'Remove host'} ${machine.hostname}`);
    close.onclick = () => closeMachine(machine.id);
    if (machine.kind === 'host' && machine.pendingRestart) {
      const badge = document.createElement('span');
      badge.className = 'pending-badge';
      badge.textContent = 'Restart pending';
      tab.append(select, badge, close);
    } else tab.append(select, close);
    tabs.insertBefore(tab, tabs.querySelector('.page-controls'));
  }
  renderPaneTitles();
  renderGraphic();
}
export function updateControls() {
  renderGraphic();
  const machine = activeMachine();
  exitAllButton.disabled = store.exitAllBusy || !machines.size || [...machines.values()].some(item => item.busy);
  updatePaneStates();
  updatePaneViewControls();
  if (!machine) {
    cloneButton.disabled = true;
    return;
  }
  const busy = !!machine.busy;
  const isSwitch = machine.kind === 'switch';
  cloneButton.disabled = busy;
  cloneButton.title = isSwitch ? 'Clone selected switch' : 'Clone selected host from its base image';
  cloneButton.setAttribute('aria-label', isSwitch ? 'Clone selected switch' : 'Clone selected host');
  if (!isSwitch && !createDialog.open) {
    imageSelect.value = machine.imageId;
    engineSelect.value = machine.engine;
  }
}

export function selectMachine(id) {
  const machine = machines.get(id);
  if (machine?.kind === 'switch' && !store.showSwitchConsoles) {
    store.showSwitchConsoles = true;
    updateSwitchConsoleToggle();
    saveViewSettings();
  }
  const index = consoleSessions().findIndex(item => item.id === id);
  if (index < 0) return;
  const targetPage = Math.floor(index / store.layoutSize);
  if (targetPage === store.pageIndex) {
    const assigned = panes.slice(0, store.layoutSize).find(pane => pane.machineId === id);
    if (assigned) { focusPane(assigned.index); return; }
  }
  store.pageIndex = targetPage;
  showPage(id);
}

export function initWorkspace() {
  for (const [id, type] of [['new-host', 'host'], ['new-switch', 'switch']]) {
    const button = document.getElementById(id);
    button.style.color = NetworkNodeIcons.styles[type].color;
    NetworkNodeIcons.applyAdd(button.querySelector('svg'), type);
  }
  refreshResourceMetrics();
  setInterval(refreshResourceMetrics, 2000);
  updateSwitchConsoleToggle();
  updateWorkspaceLayout();
  toggleConsoleColumns.addEventListener('click', () => {
    const selected = store.activeId;
    store.layoutSize = store.layoutSize === 1 ? 2 : store.layoutSize === 2 ? 4 : 1;
    saveViewSettings();
    const index = consoleSessions().findIndex(machine => machine.id === selected);
    store.pageIndex = index >= 0 ? Math.floor(index / store.layoutSize) : 0;
    showPage(selected);
  });
  previousPage.addEventListener('click', () => { if (store.pageIndex > 0) { store.pageIndex--; showPage(); } });
  nextPage.addEventListener('click', () => { if ((store.pageIndex + 1) * store.layoutSize < consoleSessions().length) { store.pageIndex++; showPage(); } });
  toggleSwitchConsoles.addEventListener('click', () => {
    const selected = store.activeId;
    store.showSwitchConsoles = !store.showSwitchConsoles;
    updateSwitchConsoleToggle();
    saveViewSettings();
    const index = consoleSessions().findIndex(machine => machine.id === selected);
    store.pageIndex = index >= 0 ? Math.floor(index / store.layoutSize) : Math.min(store.pageIndex, Math.max(0, Math.ceil(consoleSessions().length / store.layoutSize) - 1));
    showPage(index >= 0 ? selected : null);
  });
}
