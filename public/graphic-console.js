// Floating console of the Graphic view. It is not a new terminal: the console workspace of the
// Terminals view is shown over the graph as a movable, resizable window that displays only the
// selected node's pane. The pane is the normal one (xterm, socket, view menu, actions, read-only
// for an observer without control), and the layout saved per user is not touched.
// Whether it is open and its geometry are part of the view state (public/view-state.js,
// floating and geometry), so a follower shows it where the driver put it. Open means "shown
// whenever the Graphic view shows": the Terminals view hides it and coming back shows it again.
// The geometry is kept as fractions of the Graphic view (browsers differ in size) and turned into
// pixels on each page. Its close button, moving and resizing are view controls: a page whose view
// is driven by the other side (body[data-view-driven]) cannot use them.
import {machines, store} from './state.js';
import {fitTerminals, panes} from './terminal.js';
import {viewChanged, workspace} from './workspace.js';

const bar = document.getElementById('floating-console-bar');
const barTitle = document.getElementById('floating-console-title');
const closeButton = document.getElementById('floating-console-close');
const graphicArea = document.getElementById('graphic-workspace');
// Published at most every PUBLISH_INTERVAL ms while the window moves or is resized, and once
// more at the end of a move.
const PUBLISH_INTERVAL = 250;
let open = false;      // the window is wanted (view state floating), shown in the Graphic view only
let frame = null;      // its geometry (view state geometry), null for the default one
let applied = null;    // the size in pixels this page last gave the window, to tell a user resize apart
let origin = null;
let moving = null;
let publishTimer = null;

const isShown = () => workspace.dataset.floating === 'true';
const viewDriven = () => document.body.dataset.viewDriven === 'true';
export const floatingConsoleOpen = () => open;
export const floatingGeometry = () => frame;

const viewport = () => ({width: window.innerWidth, height: window.innerHeight});
const windowPixels = () => ({left: workspace.offsetLeft, top: workspace.offsetTop, width: workspace.offsetWidth, height: workspace.offsetHeight});

function setPixels({width, height, left, top}) {
  workspace.style.width = `${width}px`;
  workspace.style.height = `${height}px`;
  workspace.style.left = `${left}px`;
  workspace.style.top = `${top}px`;
  applied = {width, height};
}

// The window geometry is inline style on the console workspace: it must not outlive the window, or the
// Terminals view would keep the size of the floating window.
function clearGeometry() {
  for (const property of ['width', 'height', 'left', 'top']) workspace.style.removeProperty(property);
  applied = null;
}

// Gives the window its geometry (the default one when none was set), inside this viewport.
function applyFrame() {
  if (frame) setPixels(ViewState.geometryPixels(frame, graphicArea.getBoundingClientRect(), viewport()));
  else {
    const width = Math.min(780, window.innerWidth - 16);
    const height = Math.min(480, Math.round(window.innerHeight * 0.62));
    setPixels(ViewState.geometryPixels({left: 0, top: 0, width: 1, height: 1}, {left: window.innerWidth - width - 20, top: window.innerHeight - height - 84, width, height}, viewport()));
  }
  requestAnimationFrame(() => fitTerminals());
}

// The driver moved or resized the window: its geometry relative to the Graphic view, published
// throttled (publishNow ends a move).
function frameChanged() {
  frame = ViewState.geometryFraction(windowPixels(), graphicArea.getBoundingClientRect()) || frame;
  if (publishTimer === null) publishTimer = setTimeout(publishNow, PUBLISH_INTERVAL);
}
function publishNow() {
  clearTimeout(publishTimer);
  publishTimer = null;
  viewChanged();
}

function show() {
  workspace.dataset.floating = 'true';
  workspace.hidden = false;
  bar.hidden = false;
  workspace.setAttribute('role', 'group');
  workspace.setAttribute('aria-label', 'Floating console');
  applyFrame();
}

// Hides the window without closing it (the Terminals view), or after closing it.
function hide() {
  if (!isShown()) return;
  moving = null;
  delete workspace.dataset.floating;
  clearGeometry();
  workspace.removeAttribute('role');
  workspace.removeAttribute('aria-label');
  bar.hidden = true;
  workspace.hidden = store.graphicVisible;
  requestAnimationFrame(() => fitTerminals());   // the panes get the whole workspace back
}

// Opens the floating console on the selected node (the caller selected it). focus: false when a
// received view opens it. Outside the Graphic view it is only marked open.
export function openFloatingConsole({focus = true} = {}) {
  if (!store.activeId || !machines.has(store.activeId)) return;
  open = true;
  if (store.graphicVisible && !isShown()) show();
  refreshFloatingConsole();
  if (isShown()) {
    requestAnimationFrame(() => {
      fitTerminals();
      if (focus) panes[store.activePaneIndex]?.terminal.focus();
    });
  }
  viewChanged();
}

export function closeFloatingConsole(returnFocus = false) {
  if (!open) return;
  const id = store.activeId;
  open = false;
  hide();
  if (returnFocus && id) document.querySelector(`.topology-node[data-node-id="${CSS.escape(id)}"]`)?.focus({preventScroll: true});
  viewChanged();
}

// The Graphic view hides (hideFloatingConsole, before) or shows (showFloatingConsole, after it
// is visible): the window goes with it and stays open. The caller publishes the view.
export function hideFloatingConsole() { hide(); }
export function showFloatingConsole() {
  if (open && store.graphicVisible && !isShown()) { show(); refreshFloatingConsole(); }
}

// A received or restored geometry (normalized, or null for the default one).
export function setFloatingGeometry(geometry) {
  frame = geometry;
  if (isShown() && !moving) applyFrame();
}

// Keeps the window title on the selected node, and closes the window when no node is left.
export function refreshFloatingConsole() {
  if (!open) return;
  const machine = store.activeId && machines.get(store.activeId);
  if (!machine) { closeFloatingConsole(); return; }
  if (isShown()) barTitle.textContent = `${machine.hostname} · ${machine.kind === 'switch' ? 'VDE switch' : machine.osHint}`;
}

export function initFloatingConsole() {
  closeButton.addEventListener('click', () => closeFloatingConsole(true));
  bar.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button') || viewDriven()) return;
    event.preventDefault();
    origin = {x: event.clientX, y: event.clientY, left: workspace.offsetLeft, top: workspace.offsetTop};
    moving = event.pointerId;
    bar.setPointerCapture(event.pointerId);
  });
  bar.addEventListener('pointermove', event => {
    if (moving !== event.pointerId) return;
    const maxLeft = Math.max(0, window.innerWidth - workspace.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - 48);
    workspace.style.left = `${Math.max(0, Math.min(origin.left + event.clientX - origin.x, maxLeft))}px`;
    workspace.style.top = `${Math.max(0, Math.min(origin.top + event.clientY - origin.y, maxTop))}px`;
    frameChanged();
  });
  const stop = event => {
    if (moving !== event.pointerId) return;
    moving = null;
    frameChanged();
    publishNow();
  };
  bar.addEventListener('pointerup', stop);
  bar.addEventListener('pointercancel', stop);
  // The resize handle of the window (CSS resize) has no event of its own: a size this page did
  // not set is the driver resizing it. The last change is published by the trailing timer.
  new ResizeObserver(() => {
    if (!isShown() || !applied || viewDriven()) return;
    const {width, height} = windowPixels();
    if (Math.abs(width - applied.width) <= 1 && Math.abs(height - applied.height) <= 1) return;
    applied = {width, height};
    frameChanged();
  }).observe(workspace);
  // This browser window resized (a follower too): the same geometry in the new pixels, not published.
  window.addEventListener('resize', () => { if (isShown()) applyFrame(); });
}
