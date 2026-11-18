// Floating console of the Graphic view. It is not a new terminal: the console workspace of the
// Terminals view is shown over the graph as a movable, resizable window that displays only the
// selected node's pane. The pane is the normal one (xterm, socket, view menu, actions, read-only
// for an observer without control), and the layout saved per user is not touched.
import {machines, store} from './state.js';
import {fitTerminals, panes} from './terminal.js';
import {workspace} from './workspace.js';

const bar = document.getElementById('floating-console-bar');
const barTitle = document.getElementById('floating-console-title');
const closeButton = document.getElementById('floating-console-close');
let origin = null;
let moving = null;

const isFloating = () => workspace.dataset.floating === 'true';

function place(left, top) {
  const maxLeft = Math.max(0, window.innerWidth - workspace.offsetWidth);
  const maxTop = Math.max(0, window.innerHeight - 48);
  workspace.style.left = `${Math.max(0, Math.min(left, maxLeft))}px`;
  workspace.style.top = `${Math.max(0, Math.min(top, maxTop))}px`;
}

function defaultGeometry() {
  const width = Math.min(780, window.innerWidth - 16);
  const height = Math.min(480, Math.round(window.innerHeight * 0.62));
  workspace.style.width = `${width}px`;
  workspace.style.height = `${height}px`;
  place(window.innerWidth - width - 20, window.innerHeight - height - 84);
}

// Opens the floating console on the selected node (the caller selected it).
export function openFloatingConsole() {
  if (!store.graphicVisible || !store.activeId || !machines.has(store.activeId)) return;
  if (!isFloating()) {
    workspace.dataset.floating = 'true';
    workspace.hidden = false;
    bar.hidden = false;
    workspace.setAttribute('role', 'group');
    workspace.setAttribute('aria-label', 'Floating console');
    if (!workspace.style.width) defaultGeometry();
  }
  refreshFloatingConsole();
  requestAnimationFrame(() => {
    fitTerminals();
    panes[store.activePaneIndex]?.terminal.focus();
  });
}

export function closeFloatingConsole(returnFocus = false) {
  if (!isFloating()) return;
  const id = store.activeId;
  delete workspace.dataset.floating;
  workspace.removeAttribute('role');
  workspace.removeAttribute('aria-label');
  bar.hidden = true;
  workspace.hidden = store.graphicVisible;
  if (returnFocus && id) document.querySelector(`.topology-node[data-node-id="${CSS.escape(id)}"]`)?.focus({preventScroll: true});
}

// Keeps the window title on the selected node, and closes the window when no node is left.
export function refreshFloatingConsole() {
  if (!isFloating()) return;
  const machine = store.activeId && machines.get(store.activeId);
  if (!machine || !store.graphicVisible) { closeFloatingConsole(); return; }
  barTitle.textContent = `${machine.hostname} · ${machine.kind === 'switch' ? 'VDE switch' : machine.osHint}`;
}

export function initFloatingConsole() {
  closeButton.addEventListener('click', () => closeFloatingConsole(true));
  bar.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    event.preventDefault();
    origin = {x: event.clientX, y: event.clientY, left: workspace.offsetLeft, top: workspace.offsetTop};
    moving = event.pointerId;
    bar.setPointerCapture(event.pointerId);
  });
  bar.addEventListener('pointermove', event => {
    if (moving === event.pointerId) place(origin.left + event.clientX - origin.x, origin.top + event.clientY - origin.y);
  });
  const stop = event => { if (moving === event.pointerId) moving = null; };
  bar.addEventListener('pointerup', stop);
  bar.addEventListener('pointercancel', stop);
  window.addEventListener('resize', () => {
    if (!isFloating()) return;
    workspace.style.width = `${Math.min(workspace.offsetWidth, window.innerWidth - 8)}px`;
    place(workspace.offsetLeft, workspace.offsetTop);
  });
}
