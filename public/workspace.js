// Pane layout, paging, node tabs, pane state badges and resource metrics.
import {machines, saveViewSettings, savedView, store} from './state.js';
import {jsonRequest, nodeUrl} from './api.js';
import {leaveCaptureView} from './capture-live.js';
import {fitTerminal, fitTerminals, isConsoleView, panes, selectPaneConsole, setPaneView, updatePaneViewControls, usablePaneView} from './terminal.js';
import {closeMachine} from './nodes.js';
import {createDialog, engineSelect, imageSelect} from './node-dialogs.js';
import {renderQemuOptions} from './host-settings.js';
import {renderGraphic, setGraphicView} from './graphic-view.js';
import {controlChanged, markDisabledControls, observedLogin, observing} from './observe.js';
import {publishView} from './socket.js';

let workspaceError = null;
const resourceMetrics = new Map();
let resourceRequestPending = false;

export const workspace = document.getElementById('console-workspace');

export const exitAllButton = document.getElementById('exit-all');
export const resumeAllButton = document.getElementById('resume-all');
export const stopAllButton = document.getElementById('stop-all');
export const cloneButton = document.getElementById('clone-machine');

const tabs = document.getElementById('machine-tabs');

const toggleConsoleColumns = document.getElementById('toggle-console-columns');
const toggleSwitchConsoles = document.getElementById('toggle-switch-consoles');
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
    pane.clearButton.disabled = !machine || !isConsoleView(pane.view);
    for (const button of pane.fontButtons) button.hidden = !machine;
    pane.fontSizeLabel.hidden = !machine;
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
    const title = machine ? `${machine.hostname} · ${machine.kind === 'switch' ? 'VDE switch' : machine.osHint}` : machines.size ? 'Unused terminal'
      : observing ? `The session of ${observedLogin} has no host or switch yet` : 'Add a host or switch';
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
  showPage(selected.id);
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
  workspace.dataset.layout = store.layout;
  const current = LAYOUTS.find(layout => layout.id === store.layout);
  toggleConsoleColumns.innerHTML = layoutIcon(current);
  toggleConsoleColumns.title = `Layout: ${current.label}`;
  toggleConsoleColumns.setAttribute('aria-label', toggleConsoleColumns.title);
  for (const pane of panes) pane.element.hidden = pane.index >= store.layoutSize;
  const pages = Math.ceil(consoleSessions().length / store.layoutSize);
  previousPage.disabled = store.pageIndex === 0;
  nextPage.disabled = store.pageIndex >= pages - 1;
  pagePosition.textContent = pages ? `${store.pageIndex + 1} / ${pages}` : '0 / 0';
  fitTerminals();
  requestAnimationFrame(fitTerminals);
}

// The Layout menu of the bottom toolbar: a menu button opening upward, in a layer above the
// toolbar (which scrolls horizontally and would clip it). Keyboard: Enter/Space/arrows open,
// arrows/Home/End move, Enter/Space choose, Escape/Tab close; a click outside closes.
const LAYOUT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const LAYOUTS = [
  {id: 'single', label: '1 terminal', icon: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>'},
  {id: 'columns-2', label: '2 terminals, side by side', icon: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>'},
  {id: 'rows-2', label: '2 terminals, stacked', icon: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 12h18"/>'},
  {id: 'grid-4', label: '4 terminals', icon: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>'}
].filter(layout => ViewState.paneCount(layout.id));
const layoutIcon = layout => `${LAYOUT_SVG}${layout.icon}</svg>`;
const layoutMenu = document.createElement('div');

function setLayout(id) {
  const selected = store.activeId;
  store.layout = id;
  const index = consoleSessions().findIndex(machine => machine.id === selected);
  store.pageIndex = index >= 0 ? Math.floor(index / store.layoutSize) : 0;
  showPage(selected);
}

function layoutItems() { return [...layoutMenu.querySelectorAll('[role="menuitemradio"]')]; }

function openLayoutMenu(focusLast = false) {
  for (const item of layoutItems()) item.setAttribute('aria-checked', String(item.dataset.layout === store.layout));
  layoutMenu.hidden = false;
  const rect = toggleConsoleColumns.getBoundingClientRect();
  layoutMenu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - layoutMenu.offsetWidth - 8))}px`;
  layoutMenu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  toggleConsoleColumns.setAttribute('aria-expanded', 'true');
  const items = layoutItems();
  (focusLast ? items.at(-1) : items.find(item => item.dataset.layout === store.layout) || items[0]).focus();
}

export function closeLayoutMenu(returnFocus = false) {
  if (layoutMenu.hidden) return;
  layoutMenu.hidden = true;
  toggleConsoleColumns.setAttribute('aria-expanded', 'false');
  if (returnFocus) toggleConsoleColumns.focus();
}

function initLayoutMenu() {
  layoutMenu.className = 'layout-menu';
  layoutMenu.id = 'layout-menu';
  layoutMenu.setAttribute('role', 'menu');
  layoutMenu.setAttribute('aria-label', 'Console layout');
  layoutMenu.hidden = true;
  for (const layout of LAYOUTS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitemradio');
    item.dataset.layout = layout.id;
    item.tabIndex = -1;
    item.innerHTML = `${layoutIcon(layout)}<span>${layout.label}</span>`;
    item.addEventListener('click', () => { closeLayoutMenu(true); setLayout(layout.id); });
    layoutMenu.append(item);
  }
  document.body.append(layoutMenu);
  toggleConsoleColumns.setAttribute('aria-haspopup', 'menu');
  toggleConsoleColumns.setAttribute('aria-controls', layoutMenu.id);
  toggleConsoleColumns.setAttribute('aria-expanded', 'false');
  toggleConsoleColumns.addEventListener('click', () => (layoutMenu.hidden ? openLayoutMenu() : closeLayoutMenu()));
  toggleConsoleColumns.addEventListener('keydown', event => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); openLayoutMenu(event.key === 'ArrowUp'); }
  });
  layoutMenu.addEventListener('keydown', event => {
    const items = layoutItems();
    const index = items.indexOf(document.activeElement);
    const move = {ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1}[event.key];
    if (move !== undefined) { event.preventDefault(); items[(move + items.length) % items.length].focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); closeLayoutMenu(true); }
    else if (event.key === 'Tab') closeLayoutMenu();
  });
  document.addEventListener('pointerdown', event => {
    if (!layoutMenu.contains(event.target) && !toggleConsoleColumns.contains(event.target)) closeLayoutMenu();
  });
  window.addEventListener('resize', () => closeLayoutMenu());
}

// The view state of this page (public/view-state.js): the only way the view is read for
// publishing and saving.
export function captureView() {
  return {mode: store.graphicVisible ? 'graphic' : 'terminals', layout: store.layout,
    panes: panes.slice(0, store.layoutSize).map(pane => pane.machineId || null),
    views: panes.slice(0, store.layoutSize).map(pane => (pane.machineId ? pane.view : 'console')),
    switches: store.showSwitchConsoles, active: store.activeId || null};
}

// Shows a view state (already normalized against this page's nodes; unknown nodes are left
// out): the only way a view is applied, for Follow, for the owner's page under control and to
// restore the saved view. It is not saved here, and only the panes whose node changes attach
// their console. The console page is derived from the first pane's node.
let applying = false;
export function applyView(view) {
  applying = true;
  try {
    closeLayoutMenu();
    store.layout = view.layout;
    store.showSwitchConsoles = view.switches;
    updateSwitchConsoleToggle();
    const ids = view.panes.map(id => (id && machines.has(id) ? id : null));
    const first = consoleSessions().findIndex(machine => ids.includes(machine.id));
    store.pageIndex = first >= 0 ? Math.floor(first / store.layoutSize) : 0;
    setPaneSessions(ids, Math.max(0, ids.indexOf(view.active)));
    view.views.forEach((wanted, index) => {
      const pane = panes[index];
      const shown = usablePaneView(pane, wanted);
      if (pane.machineId && pane.view !== shown) setPaneView(pane, shown);
    });
    if (view.active && machines.has(view.active)) store.activeId = view.active;
    if ((view.mode === 'graphic') !== store.graphicVisible) setGraphicView(view.mode === 'graphic');
  } finally { applying = false; }
}

// Called after every change of the view (showPage/setPaneSessions, focusPane, setGraphicView):
// publishes the view state (socket.js decides whether this page publishes) and saves it, except
// while a received view is applied and before the saved view was restored.
let viewRestored = false;
export function viewChanged() {
  if (applying) return;
  publishView();
  if (viewRestored) saveViewSettings(captureView());
}

// Once the node list is loaded: restores the view saved in this browser (its nodes that still
// exist), then the view is saved on each change. An observation tab restores nothing.
export function restoreSavedView() {
  if (viewRestored) return;
  viewRestored = true;
  if (observing || !savedView) return;
  const view = ViewState.normalizeView(savedView, machines);
  if (view && view.panes.some(Boolean)) applyView(view);
  publishView();
}

function setPaneSessions(ids, activeIndex = 0) {
  const before = panes.map(pane => pane.machineId);
  panes.forEach((pane, index) => { pane.machineId = ids[index] || null; });
  panes.forEach(pane => {
    if (before[pane.index] === pane.machineId) return;
    pane.actionMenu.open = false;
    pane.sessionMenu.open = false;
    leaveCaptureView(pane);
    pane.view = 'console';
    pane.monitorInput = '';
    pane.monitorAvailable = false;
    pane.replayGeneration++;
    pane.replayPending = '';
    pane.replaying = !!pane.machineId;
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
    const nodeId = pane.machineId;
    selectPaneConsole(pane, result => {
      if (result?.error && pane.machineId === nodeId) showStatusError(result.error);
    });
  });
  panes.forEach(pane => {
    if (before[pane.index] && !pane.machineId) {
      pane.socket.emit('leave-node', pane.selectedConsoleId || before[pane.index]);
      pane.selectedConsoleId = null;
    }
  });
  requestAnimationFrame(fitTerminals);
  viewChanged();
}
export function showPage(preferredId = null) {
  const sessions = consoleSessions();
  const pages = Math.ceil(sessions.length / store.layoutSize);
  store.pageIndex = Math.max(0, Math.min(store.pageIndex, Math.max(0, pages - 1)));
  const ids = sessions.slice(store.pageIndex * store.layoutSize, (store.pageIndex + 1) * store.layoutSize).map(machine => machine.id);
  const preferredIndex = preferredId ? ids.indexOf(preferredId) : -1;
  const activeIndex = preferredIndex >= 0 ? preferredIndex : Math.min(store.activePaneIndex, Math.max(0, ids.length - 1));
  setPaneSessions(ids, activeIndex);
}
export function focusPane(index) {
  store.activePaneIndex = index;
  const pane = panes[index];
  store.activeId = pane.machineId;
  panes.forEach(item => item.element.dataset.active = String(item.index === index));
  updateWorkspaceLayout();
  tabs.querySelectorAll('.machine-tab').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.nodeId === store.activeId)));
  viewChanged();
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
    select.className = 'machine-name view-control';
    select.textContent = machine.hostname;
    select.title = machine.osHint;
    select.onclick = () => { if (machine.id !== store.activeId) selectMachine(machine.id); };
    select.ondblclick = async () => {
      if (observing || machine.kind === 'switch' || !machine.hasLaunched) return;
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
    close.className = 'machine-close write-action';
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
  markDisabledControls();
}
export function updateControls() {
  renderGraphic();
  const machine = activeMachine();
  exitAllButton.disabled = store.exitAllBusy || !machines.size || [...machines.values()].some(item => item.busy);
  stopAllButton.disabled = store.exitAllBusy || ![...machines.values()].some(item => item.running) || [...machines.values()].some(item => item.busy);
  resumeAllButton.disabled = store.exitAllBusy || ![...machines.values()].some(item => !item.running) || [...machines.values()].some(item => item.busy);
  updatePaneStates();
  updatePaneViewControls();
  controlChanged();
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
  for (const [id, type] of [['graphic-add-host', 'host'], ['graphic-add-switch', 'switch']]) {
    const button = document.getElementById(id);
    button.style.color = NetworkNodeIcons.styles[type].color;
    NetworkNodeIcons.applyAdd(button.querySelector('svg'), type);
  }
  refreshResourceMetrics();
  setInterval(refreshResourceMetrics, 2000);
  updateSwitchConsoleToggle();
  updateWorkspaceLayout();
  initLayoutMenu();
  previousPage.addEventListener('click', () => { if (store.pageIndex > 0) { store.pageIndex--; showPage(); } });
  nextPage.addEventListener('click', () => { if ((store.pageIndex + 1) * store.layoutSize < consoleSessions().length) { store.pageIndex++; showPage(); } });
  toggleSwitchConsoles.addEventListener('click', () => {
    const selected = store.activeId;
    store.showSwitchConsoles = !store.showSwitchConsoles;
    updateSwitchConsoleToggle();
    const index = consoleSessions().findIndex(machine => machine.id === selected);
    store.pageIndex = index >= 0 ? Math.floor(index / store.layoutSize) : Math.min(store.pageIndex, Math.max(0, Math.ceil(consoleSessions().length / store.layoutSize) - 1));
    showPage(index >= 0 ? selected : null);
  });
}
