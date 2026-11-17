// Console panes: xterm instances, menus, font size and Console/Monitor/Log views.
import {generalSettings, machines, store} from './state.js';
import {jsonRequest, nodeUrl, requestJson} from './api.js';
import {focusPane, renderPaneSessionOptions, showStatusError, togglePaneExpansion, updateControls, workspace} from './workspace.js';
import {rebootActiveMachine, removeActiveMachine, resetActiveMachine, startActiveMachine, stopActiveMachine} from './nodes.js';
import {openHostSettings} from './host-settings.js';
import {canType, observing, socketOptions} from './observe.js';

export const panes = [];

// A pane shows a host's first serial console (view 'console', ttyS0) or its second one
// ('console2', ttyS1), selected on the pane's socket by console ID (public/console-id.js).
export const isConsoleView = view => view === 'console' || view === 'console2';
export const viewChannel = view => (view === 'console2' ? 1 : 0);
export const paneConsoleId = pane => ConsoleId.consoleId(pane.machineId, viewChannel(pane.view));
export const hasSecondConsole = machine => !!machine && machine.kind === 'host' && !!machine.serialPorts?.includes(ConsoleId.portName(1));
// The label of a console view button: a host's consoles are named by their serial port, a
// switch has a single VDE terminal.
const consoleViewLabel = (view, machine) => {
  if (view === 'console2') return `Console (${ConsoleId.portName(1)})`;
  return machine?.kind === 'host' ? `Console (${ConsoleId.portName(0)})` : 'Console';
};
// The replay buffer of a machine's console channel.
export const consoleBuffer = (machine, channel) => (channel === 1 ? machine.serial2 : machine.serial) || '';

// Selects the pane's console on its socket; the snapshot answers with the console's buffer.
export function selectPaneConsole(pane, callback) {
  pane.token = ++store.selectionToken;
  pane.selectedConsoleId = paneConsoleId(pane);
  pane.socket.emit('select-node', pane.selectedConsoleId, pane.token, callback);
}

export function syncConsoleScroll(pane) {
  const buffer = pane.terminal.buffer.active;
  pane.scroll.max = String(Math.max(0, buffer.baseY));
  pane.scroll.value = String(buffer.viewportY);
  pane.scroll.disabled = buffer.baseY === 0;
}
export function fitTerminal(pane) {
  if (pane.element.hidden || !pane.element.clientWidth || !pane.element.clientHeight) return;
  if (!pane.opened) {
    pane.terminal.open(document.getElementById(`terminal-${pane.index}`));
    pane.opened = true;
  }
  pane.fit.fit();
  syncConsoleScroll(pane);
  // The size Clear sends to the guest (stty rows N cols M), shown in the button's tooltip.
  const clearTitle = `Clear console and resize the guest terminal (${pane.terminal.cols} columns × ${pane.terminal.rows} rows)`;
  pane.clearButton.title = clearTitle;
  pane.clearButton.setAttribute('aria-label', clearTitle);
  const machine = pane.machineId && machines?.get(pane.machineId);
  if (machine?.kind === 'switch' && !observing) pane.socket.emit('terminal-resize', {id: machine.id, cols: pane.terminal.cols, rows: pane.terminal.rows});
}
export function fitTerminals() { panes.forEach(fitTerminal); }

function applyPaneFontSize(pane) {
  const size = pane.fontSizeOverride ?? generalSettings.consoleFontSize;
  if (pane.fontSizeOverride === null) pane.element.style.removeProperty('--console-font-size');
  else pane.element.style.setProperty('--console-font-size', `${size}px`);
  pane.terminal.options.fontSize = size;
  for (const [index, button] of pane.fontButtons.entries()) {
    button.disabled = index === 0 ? size <= 11 : size >= 24;
    button.title = `${index === 0 ? 'Decrease' : 'Increase'} terminal font size (${size} px)`;
    button.setAttribute('aria-label', button.title);
  }
  pane.fontSizeLabel.textContent = String(size);
  pane.fontSizeLabel.title = `Terminal font size: ${size} px`;
}
function changePaneFontSize(pane, change) {
  const current = pane.fontSizeOverride ?? generalSettings.consoleFontSize;
  pane.fontSizeOverride = Math.max(11, Math.min(24, current + change));
  applyPaneFontSize(pane);
  requestAnimationFrame(() => { fitTerminal(pane); pane.terminal.scrollToBottom(); pane.terminal.focus(); });
}
export function applyConsoleAppearance(resetPaneSizes = false) {
  const root = document.documentElement;
  root.dataset.consoleFont = generalSettings.consoleFontFamily;
  root.style.setProperty('--console-font-size', `${generalSettings.consoleFontSize}px`);
  const style = getComputedStyle(root);
  const fontFamily = style.getPropertyValue('--console-font-family').trim();
  for (const pane of panes) {
    if (resetPaneSizes) pane.fontSizeOverride = null;
    pane.terminal.options.fontFamily = fontFamily;
    applyPaneFontSize(pane);
  }
  requestAnimationFrame(fitTerminals);
}

export function finishReplay(pane, generation, id) {
  if (generation !== pane.replayGeneration || id !== pane.machineId || !isConsoleView(pane.view)) return;
  if (pane.replayPending) {
    const pending = pane.replayPending;
    pane.replayPending = '';
    pane.terminal.write(pending, () => finishReplay(pane, generation, id));
  } else {
    pane.replaying = false;
    pane.terminal.scrollToBottom();
    syncConsoleScroll(pane);
  }
}

function monitorIsAvailable(machine) {
  return MonitorTerminal.isSupported(machine) && machine.running && !machine.busy;
}
export function renderLogView(pane) {
  const machine = pane.machineId && machines.get(pane.machineId);
  pane.replayGeneration++;
  pane.replayPending = '';
  pane.replaying = false;
  pane.terminal.reset();
  pane.terminal.write(SessionLog.terminalText(machine), () => {
    pane.terminal.scrollToBottom();
    syncConsoleScroll(pane);
  });
}
export function refreshLogViews(machine) {
  for (const pane of panes) if (pane.machineId === machine.id && pane.view === 'log') renderLogView(pane);
}
export function renderConsoleView(pane) {
  const machine = pane.machineId && machines.get(pane.machineId);
  const generation = ++pane.replayGeneration;
  pane.replayPending = '';
  pane.replaying = !!machine;
  pane.terminal.write('', () => {
    if (generation !== pane.replayGeneration || !isConsoleView(pane.view) || pane.machineId !== (machine?.id || null)) return;
    pane.terminal.reset();
    syncConsoleScroll(pane);
    if (!machine) { pane.replaying = false; return; }
    pane.terminal.write(consoleBuffer(machine, viewChannel(pane.view)), () => finishReplay(pane, generation, machine.id));
  });
}
function renderMonitorView(pane) {
  const machine = pane.machineId && machines.get(pane.machineId);
  pane.replayGeneration++;
  pane.replayPending = '';
  pane.replaying = false;
  pane.terminal.reset();
  if (!MonitorTerminal.isSupported(machine)) return;
  let content = 'QEMU monitor — commands control the emulator, not the guest OS.\r\nExamples: help, info status, info block\r\n\r\n';
  if (machine.monitorOutput) content += MonitorTerminal.terminalText(machine.monitorOutput);
  if (!monitorIsAvailable(machine)) content += 'The monitor is available while this QEMU host is running.\r\n';
  else if (machine.monitorBusy) content += 'Command in progress…\r\n';
  else content += `> ${pane.monitorInput}`;
  pane.terminal.write(content, () => {
    pane.terminal.scrollToBottom();
    syncConsoleScroll(pane);
  });
}
// Shows the pane's console view. When the socket has selected the other console, the new one is
// selected first: its snapshot (node-snapshot) fills the terminal.
function showPaneConsole(pane) {
  if (pane.selectedConsoleId === paneConsoleId(pane)) { renderConsoleView(pane); return; }
  pane.replayGeneration++;
  pane.replayPending = '';
  pane.replaying = true;
  pane.terminal.reset();
  selectPaneConsole(pane, result => { if (result?.error) showStatusError(result.error); });
}
function setPaneView(pane, view) {
  const machine = pane.machineId && machines.get(pane.machineId);
  if (!['console', 'console2', 'monitor', 'log'].includes(view) || !machine) return;
  if (view === 'monitor' && !MonitorTerminal.isSupported(machine)) return;
  if (view === 'console2' && !hasSecondConsole(machine)) return;
  pane.viewMenu.open = false;
  if (pane.view === view) { pane.terminal.focus(); return; }
  pane.view = view;
  pane.monitorInput = '';
  pane.viewButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  updatePaneViewMenuIcon(pane);
  if (view === 'monitor') renderMonitorView(pane);
  else if (view === 'log') renderLogView(pane);
  else showPaneConsole(pane);
  pane.clearButton.disabled = !isConsoleView(view);
  if (pane.index === store.activePaneIndex) updateControls();
  requestAnimationFrame(() => { fitTerminal(pane); pane.terminal.focus(); });
}
function updatePaneViewMenuIcon(pane) {
  const selected = pane.viewButtons.find(button => button.dataset.view === pane.view);
  const label = selected.getAttribute('aria-label');
  const port = selected.dataset.port || '';
  if (pane.viewMenuToggle.dataset.view === pane.view && pane.viewMenuToggle.dataset.label === label && (pane.viewMenuToggle.dataset.port || '') === port) return;
  pane.viewMenuToggle.replaceChildren(selected.querySelector('svg').cloneNode(true));
  pane.viewMenuToggle.dataset.view = pane.view;
  pane.viewMenuToggle.dataset.label = label;
  if (port) pane.viewMenuToggle.dataset.port = port; else delete pane.viewMenuToggle.dataset.port;
  pane.viewMenuToggle.title = `${label} · choose terminal view`;
  pane.viewMenuToggle.setAttribute('aria-label', pane.viewMenuToggle.title);
}
export function updatePaneViewControls() {
  for (const pane of panes) {
    const machine = pane.machineId && machines.get(pane.machineId);
    const supported = !!machine;
    const monitorSupported = MonitorTerminal.isSupported(machine);
    const available = monitorIsAvailable(machine);
    pane.viewMenu.hidden = !supported;
    if (!supported) pane.viewMenu.open = false;
    pane.viewButtons.forEach(button => {
      if (button.dataset.view === 'monitor') button.hidden = !monitorSupported;
      if (button.dataset.view === 'console2') button.hidden = !hasSecondConsole(machine);
      if (isConsoleView(button.dataset.view)) {
        const label = consoleViewLabel(button.dataset.view, machine);
        button.title = label;
        button.setAttribute('aria-label', label);
        const text = button.querySelector('span');
        if (text) text.textContent = label;
        // Both consoles of a host share one icon; a small 0 or 1 tells them apart.
        if (hasSecondConsole(machine)) button.dataset.port = button.dataset.view === 'console2' ? '1' : '0';
        else delete button.dataset.port;
      }
    });
    if ((pane.view === 'monitor' && !monitorSupported) || (pane.view === 'console2' && !hasSecondConsole(machine))) {
      pane.view = 'console';
      pane.monitorInput = '';
      showPaneConsole(pane);
    }
    pane.viewButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === pane.view)));
    updatePaneViewMenuIcon(pane);
    if (pane.view === 'monitor' && pane.monitorAvailable !== available) renderMonitorView(pane);
    pane.monitorAvailable = available;
  }
}
async function sendPaneMonitorCommand(pane, machine, command) {
  machine.monitorBusy = true;
  machine.monitorOutput = `${machine.monitorOutput || ''}> ${command}\n`;
  const nodeId = machine.id;
  const request = ++pane.monitorRequest;
  let output;
  try {
    const body = await requestJson(nodeUrl(nodeId, 'monitor'), jsonRequest('POST', {command}), 'Command failed');
    output = body.output || '(no output)';
  } catch (error) { output = `Error: ${error.message}`; }
  finally {
    machine.monitorOutput += `${output}\n`;
    machine.monitorBusy = false;
    if (pane.monitorRequest === request && pane.machineId === nodeId && pane.view === 'monitor' && machines.get(nodeId) === machine) renderMonitorView(pane);
  }
}
function handleMonitorInput(pane, data) {
  const machine = pane.machineId && machines.get(pane.machineId);
  if (!monitorIsAvailable(machine) || machine.monitorBusy) { pane.terminal.write('\x07'); return; }
  const result = MonitorTerminal.consumeInput(pane.monitorInput, data);
  pane.monitorInput = result.input;
  if (result.echo) pane.terminal.write(result.echo, () => syncConsoleScroll(pane));
  if (result.prompt) pane.terminal.write('> ');
  if (result.command) sendPaneMonitorCommand(pane, machine, result.command);
}

export function appendLog(machine, line) {
  const truncated = SessionLog.append(machine, line);
  for (const pane of panes) {
    if (pane.machineId !== machine.id || pane.view !== 'log') continue;
    if (truncated) renderLogView(pane);
    else {
      pane.terminal.write(SessionLog.terminalEntry(line), () => {
        pane.terminal.scrollToBottom();
        syncConsoleScroll(pane);
      });
    }
  }
}

// A short note under the machine's controls (cleared after 5 s).
function notePaneError(machine, note) {
  machine.error = note;
  updateControls();
  setTimeout(() => { if (machine.error === note) { machine.error = ''; updateControls(); } }, 5000);
}

function clearPaneConsole(pane) {
  if (observing || !pane.machineId || !isConsoleView(pane.view) || !machines.has(pane.machineId)) return;
  const buffer = pane.terminal.buffer.active;
  const machine = machines.get(pane.machineId);
  // A full-screen program (nano, vi, less) draws on the alternate screen: clearing would only blank
  // it, so nothing is cleared until the program exits.
  if (buffer.type !== 'normal') {
    notePaneError(machine, 'Console not cleared: a full-screen program is running.');
    return;
  }
  const line = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) || '';
  const clear = () => pane.socket.emit('clear-console', {id: paneConsoleId(pane), line, column: buffer.cursorX});
  clear();
  if (machine.kind !== 'host' || !canType(pane)) return;
  // The size is typed into the guest only where a command can be typed: not at a login or password
  // prompt, not while a command runs, and not after text already typed on the line.
  const atShellPrompt = /[#$%>]$/.test(line) && buffer.cursorX >= line.length;
  if (!atShellPrompt) {
    notePaneError(machine, `Console cleared; the terminal size was not sent because the cursor is not at an empty shell prompt (line: "${line}", cursor at ${buffer.cursorX}, line length ${line.length}).`);
    return;
  }
  fitTerminal(pane);
  pane.socket.emit('input', `stty rows ${pane.terminal.rows} cols ${pane.terminal.cols}\r`);
  setTimeout(() => {
    if (isConsoleView(pane.view) && pane.machineId) clear();
  }, 300);
}

export function initTerminals() {
  panes.push(...[0, 1, 2, 3].map(index => {
    const terminal = new Terminal({cursorBlink: true, convertEol: true, scrollback: 5000, theme: {background: '#0b0f14'}});
    const fit = new FitAddon.FitAddon();
    terminal.loadAddon(fit);
    const pane = {
      index,
      socket: io(socketOptions()),
      element: document.getElementById(`console-pane-${index}`),
      title: document.getElementById(`console-session-${index}`),
      viewToggle: document.getElementById(`console-view-${index}`),
      viewButtons: [...document.querySelectorAll(`#console-view-${index} [data-view]`)],
      state: document.getElementById(`console-state-${index}`),
      terminal,
      fit,
      opened: false,
      scroll: document.getElementById(`terminal-scroll-${index}`),
      view: 'console',
      monitorInput: '',
      monitorRequest: 0,
      monitorAvailable: false,
      machineId: null,
      token: 0,
      replayGeneration: 0,
      replaying: false,
      replayPending: '',
      fontSizeOverride: null
    };
    pane.viewMenu = document.createElement('details');
    pane.viewMenu.className = 'pane-view-menu';
    pane.viewMenu.hidden = true;
    pane.viewMenuToggle = document.createElement('summary');
    pane.viewToggle.hidden = false;
    for (const button of pane.viewButtons) {
      const label = document.createElement('span');
      label.textContent = button.getAttribute('aria-label');
      button.append(label);
    }
    pane.viewToggle.replaceWith(pane.viewMenu);
    pane.viewMenu.append(pane.viewMenuToggle, pane.viewToggle);
    pane.viewMenu.addEventListener('toggle', () => {
      if (pane.viewMenu.open) for (const other of panes) {
        if (other !== pane) other.viewMenu.open = false;
        other.actionMenu?.removeAttribute('open');
        other.sessionMenu?.removeAttribute('open');
      }
    });
    pane.sessionMenu = document.createElement('details');
    pane.sessionMenu.className = 'pane-session-menu view-control';
    pane.sessionMenu.hidden = true;
    pane.sessionToggle = document.createElement('summary');
    pane.sessionToggle.className = 'pane-session-title';
    pane.sessionLabel = document.createElement('span');
    pane.sessionLabel.className = 'pane-session-label';
    pane.sessionToggle.append(pane.sessionLabel);
    pane.sessionToggle.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>');
    pane.sessionList = document.createElement('div');
    pane.sessionList.className = 'pane-session-list';
    pane.sessionList.setAttribute('role', 'group');
    pane.sessionMenu.append(pane.sessionToggle, pane.sessionList);
    pane.title.after(pane.sessionMenu);
    pane.sessionMenu.addEventListener('toggle', () => {
      if (!pane.sessionMenu.open) return;
      renderPaneSessionOptions(pane);
      for (const other of panes) {
        if (other !== pane) other.sessionMenu.open = false;
        other.actionMenu?.removeAttribute('open');
        other.viewMenu?.removeAttribute('open');
      }
    });
    pane.metrics = document.createElement('span');
    pane.metrics.className = 'pane-metrics';
    pane.metrics.hidden = true;
    pane.sessionMenu.after(pane.metrics);
    pane.actionMenu = document.createElement('details');
    pane.actionMenu.className = 'pane-action-menu write-action';
    pane.actionMenu.hidden = true;
    const actionToggle = document.createElement('summary');
    actionToggle.title = 'Session actions';
    actionToggle.setAttribute('aria-label', 'Session actions');
    actionToggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
    const actionList = document.createElement('div');
    actionList.className = 'pane-action-list';
    actionList.setAttribute('role', 'group');
    actionList.setAttribute('aria-label', 'Session actions');
    pane.actionButtons = {};
    for (const [action, label] of [['play', 'Play'], ['stop', 'Stop'], ['reboot', 'Reboot'], ['reset', 'Reset'], ['remove', 'Remove']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = action;
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '2');
      icon.setAttribute('stroke-linecap', 'round');
      icon.setAttribute('stroke-linejoin', 'round');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', `#pane-${action}-icon`);
      icon.append(use);
      const caption = document.createElement('span');
      caption.textContent = label;
      button.append(icon, caption);
      button.addEventListener('click', () => {
        const nodeId = pane.machineId;
        pane.actionMenu.open = false;
        if (!nodeId || !machines.has(nodeId)) return;
        focusPane(pane.index);
        if (store.activeId !== nodeId) return;
        ({play: startActiveMachine, stop: stopActiveMachine, reboot: rebootActiveMachine, reset: resetActiveMachine, remove: removeActiveMachine})[action]();
      });
      pane.actionButtons[action] = button;
      actionList.append(button);
    }
    pane.actionMenu.append(actionToggle, actionList);
    pane.title.before(pane.actionMenu);
    pane.actionMenu.addEventListener('toggle', () => {
      if (pane.actionMenu.open) for (const other of panes) {
        if (other !== pane) other.actionMenu.open = false;
        other.viewMenu.open = false;
        other.sessionMenu.open = false;
      }
    });
    pane.settingsButton = document.createElement('button');
    pane.settingsButton.type = 'button';
    pane.settingsButton.className = 'pane-settings-button write-action';
    pane.settingsButton.title = 'Host Settings';
    pane.settingsButton.setAttribute('aria-label', 'Host Settings');
    pane.settingsButton.hidden = true;
    pane.settingsButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#pane-settings-icon"></use></svg>';
    pane.settingsButton.addEventListener('click', () => {
      const nodeId = pane.machineId;
      if (!nodeId || machines.get(nodeId)?.kind !== 'host') return;
      focusPane(pane.index);
      if (store.activeId === nodeId) openHostSettings();
    });
    pane.actionMenu.after(pane.settingsButton);
    pane.clearButton = document.createElement('button');
    pane.clearButton.type = 'button';
    pane.clearButton.className = 'pane-clear-button write-action';
    pane.clearButton.title = 'Clear console and resize the guest terminal';
    pane.clearButton.setAttribute('aria-label', 'Clear console and resize the guest terminal');
    pane.clearButton.hidden = true;
    pane.clearButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#pane-clear-icon"></use></svg>';
    pane.clearButton.addEventListener('click', () => clearPaneConsole(pane));
    pane.settingsButton.after(pane.clearButton);
    pane.expandButton = document.createElement('button');
    pane.expandButton.type = 'button';
    pane.expandButton.className = 'pane-expand-button view-control';
    pane.expandButton.hidden = true;
    pane.expandButton.addEventListener('click', () => togglePaneExpansion(pane));
    pane.clearButton.after(pane.expandButton);
    pane.fontButtons = [-1, 1].map(change => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pane-font-button';
      button.textContent = change < 0 ? 'A−' : 'A+';
      button.title = change < 0 ? 'Decrease terminal font size' : 'Increase terminal font size';
      button.setAttribute('aria-label', button.title);
      button.hidden = true;
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => changePaneFontSize(pane, change));
      return button;
    });
    pane.fontSizeLabel = document.createElement('span');
    pane.fontSizeLabel.className = 'pane-font-size';
    pane.fontSizeLabel.hidden = true;
    pane.expandButton.after(pane.fontButtons[0], pane.fontSizeLabel, pane.fontButtons[1]);
    terminal.onScroll(() => syncConsoleScroll(pane));
    terminal.onData(data => {
      if (pane.replaying || !pane.machineId) return;
      if (pane.view === 'monitor') handleMonitorInput(pane, data);
      else if (isConsoleView(pane.view)) {
        if (!canType(pane)) return;
        const machine = machines.get(pane.machineId);
        // Cursor position replies are dropped for hosts: a serial getty can echo them literally at boot.
        const input = machine?.kind === 'host' ? data.replace(/\x1b\[\d+;\d+R/g, '') : data;
        if (input) pane.socket.emit('input', input);
      }
    });
    pane.viewButtons.forEach(button => button.addEventListener('click', () => setPaneView(pane, button.dataset.view)));
    pane.scroll.addEventListener('input', () => terminal.scrollToLine(Number(pane.scroll.value)));
    pane.element.addEventListener('focusin', () => focusPane(index));
    pane.element.addEventListener('pointerdown', () => focusPane(index));
    return pane;
  }));
  document.addEventListener('pointerdown', event => {
    for (const pane of panes) {
      if (!pane.actionMenu.contains(event.target)) pane.actionMenu.open = false;
      if (!pane.viewMenu.contains(event.target)) pane.viewMenu.open = false;
      if (!pane.sessionMenu.contains(event.target)) pane.sessionMenu.open = false;
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const openMenu = panes.find(pane => pane.actionMenu.open || pane.viewMenu.open || pane.sessionMenu.open);
    if (!openMenu) return;
    event.preventDefault();
    const menu = openMenu.sessionMenu.open ? openMenu.sessionMenu : openMenu.viewMenu.open ? openMenu.viewMenu : openMenu.actionMenu;
    menu.open = false;
    menu.querySelector('summary').focus();
  });
  fitTerminals();
  window.addEventListener('resize', fitTerminals);
  new ResizeObserver(fitTerminals).observe(workspace);
}
