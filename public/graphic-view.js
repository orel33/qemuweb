// Graphic view: drawing, pan and zoom, node dragging, selection, hover details and the switch
// between the Terminals and Graphic views. The layout and the SVG are in topology-graphic.js.
// Node positions and the viewport are in world coordinates (independent of the zoom): the
// viewport is a translation and a scale applied to one SVG group, so there is no frame and no
// edge to the area where a node can be put.
// Node positions are session data, kept by the runner (layout.json, runner/commands/layout.js):
// read with GET /api/graphic-layout, moved by the session's driver only (the owner while nobody
// controls the session, the admin holding control) with the node-position socket event, which
// the server relays to the session's other pages during the drag and keeps at its end. The
// viewport is part of the view state (viewport {cx, cy, k}, public/view-state.js): a page
// whose view is driven by the other side shows the driver's pan and zoom and cannot change them.
// So is the link style (linkStyle, below).
import {graphicLinksKey, machines, store} from './state.js';
import {fitTerminals} from './terminal.js';
import {closeLayoutMenu, selectMachine, viewChanged, workspace} from './workspace.js';
import {canWrite, viewDriver} from './observe.js';
import {emitOnSession} from './socket.js';
import {onCapturesChanged, recordingOf} from './captures.js';
import {hideFloatingConsole, openFloatingConsole, refreshFloatingConsole, showFloatingConsole} from './graphic-console.js';
import {cancelEditMode, handleEditClick, refreshEditTools} from './graphic-edit.js';

const graphicWorkspace = document.getElementById('graphic-workspace');
export const graphicCanvas = document.getElementById('graphic-canvas');
const graphicSummary = document.getElementById('graphic-summary');
const graphicToggle = document.getElementById('toggle-graphic-view');
const graphicZoomOut = document.getElementById('graphic-zoom-out');
const graphicZoomIn = document.getElementById('graphic-zoom-in');
const graphicZoomLevel = document.getElementById('graphic-zoom-level');
const graphicFit = document.getElementById('graphic-fit');
const graphicLinks = document.getElementById('graphic-links');
const GRAPHIC_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/></svg>';
const TERMINALS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>';

// The link style button names what a press does and carries its icon (a Z polyline to go rectilinear, a
// curve to go back to curves), like the Graphic/Terminals button; aria-pressed tells whether rectilinear is on.
// The style is part of the view state (linkStyle, public/view-state.js): a view control, published by
// the driver and applied on the follower. linkStyle is the style shown, savedLinkStyle this browser's
// preference (graphicLinksKey), changed only by a choice made on this page (ViewState.linkStyleChange).
const LINKS_ICONS = {curved: '<path d="M3 6h7v12h11"/>', rectilinear: '<path d="M3 6c9 0 9 12 18 12"/>'};
let savedLinkStyle = 'curved';
let linkStyle = 'curved';

// This browser's preference, read once at start (initGraphicView). A private window may refuse
// storage: the default style then.
function loadLinkPreference() {
  try { savedLinkStyle = ViewState.normalizeLinkStyle(localStorage.getItem(graphicLinksKey)); } catch (_) {}
  linkStyle = savedLinkStyle;
  renderLinkStyleButton();
}

function renderLinkStyleButton() {
  const rectilinear = linkStyle === 'rectilinear';
  const label = rectilinear ? 'Curved links' : 'Rectilinear links';
  graphicLinks.setAttribute('aria-pressed', String(rectilinear));
  graphicLinks.title = label;
  graphicLinks.setAttribute('aria-label', label);
  graphicLinks.querySelector('svg').innerHTML = LINKS_ICONS[linkStyle];
}
function changeLinkStyle(style, own) {
  const next = ViewState.linkStyleChange({shown: linkStyle, saved: savedLinkStyle}, style, {own});
  if (next.saved !== savedLinkStyle) {
    savedLinkStyle = next.saved;
    try { localStorage.setItem(graphicLinksKey, savedLinkStyle); } catch (_) {}
  }
  if (next.shown === linkStyle) return;
  linkStyle = next.shown;
  renderLinkStyleButton();
  renderGraphic();
}
// The style shown (captureView) and this browser's preference (the saved view is restored with it).
export const graphicLinkStyle = () => linkStyle;
export const graphicLinkPreference = () => savedLinkStyle;
// From a view state (applyView): shown, never saved as this browser's preference.
export function setGraphicLinkStyle(style) { changeLinkStyle(style, false); }
// A press of the button by this page's driver: shown, saved and published.
function toggleLinkStyle() {
  if (viewDriver()) return;
  changeLinkStyle(linkStyle === 'rectilinear' ? 'curved' : 'rectilinear', true);
  viewChanged();
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const DRAG_THRESHOLD = 5;
const DOUBLE_CLICK_MS = 400;
// How often a node drag, a pan or a zoom is published while it lasts (its end is published at once).
const PUBLISH_INTERVAL = 100;
// The bound of the published viewport center (public/view-state.js).
const MAX_CENTER = 100000;

// The viewport: world (wx, wy) is drawn at pixel (x + wx * k, y + wy * k) of the canvas.
const view = {x: 0, y: 0, k: 1};
let fitPending = true;
// A viewport {cx, cy, k} to show once the canvas has a size (the Graphic view hidden meanwhile),
// and the last one applied from a view state: a driven page centers it again when resized.
let wantedViewport = null;
let appliedViewport = null;
// The viewport this page shows, as published in its view state (null before the first one).
let shownViewport = null;
export let graphicGraph = null;
const graphicPositions = new Map();
let drag = null;
let lastTap = {id: null, time: 0};
let selectedLink = null;

// The positions of a received layout ({positions: {nodeId: {x, y}}}), finite numbers only.
function setPositions(positions) {
  graphicPositions.clear();
  if (!positions || typeof positions !== 'object') return;
  for (const [id, position] of Object.entries(positions)) {
    if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) graphicPositions.set(id, {x: position.x, y: position.y});
  }
}

// Reads the session's layout (at each connection of the session socket and when its runner is back).
export async function loadGraphicLayout() {
  try {
    const response = await fetch('/api/graphic-layout', {cache: 'no-store'});
    if (!response.ok) return;
    if (!drag || drag.type !== 'node') setPositions((await response.json()).positions);
    renderGraphic();
  } catch (_) { /* The next connection reads it again. */ }
}

// graphic-layout {positions}: the whole layout was replaced (a session archive was loaded): the
// drawing is fitted again.
export function graphicLayoutReceived(layout) {
  setPositions(layout?.positions);
  fitPending = true;
  renderGraphic();
}

// node-position {nodeId, x, y}: the driver moves a node (during its drag, then its final place).
export function nodePositionReceived(moved) {
  if (!moved || typeof moved.nodeId !== 'string' || !Number.isFinite(moved.x) || !Number.isFinite(moved.y)) return;
  if (drag?.type === 'node' && drag.id === moved.nodeId) return;
  graphicPositions.set(moved.nodeId, {x: moved.x, y: moved.y});
  renderGraphic();
}

// Publishes a node's position: throttled during a drag, at once at its end (final: kept by the runner).
let positionTimer = null;
let positionPending = null;
function sendPosition() {
  clearTimeout(positionTimer);
  positionTimer = null;
  if (positionPending) emitOnSession('node-position', positionPending);
  positionPending = null;
}
function publishPosition(nodeId, {x, y}, final) {
  positionPending = {nodeId, x, y, final};
  if (final) sendPosition();
  else if (positionTimer === null) positionTimer = setTimeout(sendPosition, PUBLISH_INTERVAL);
}

// The place of a node created in the Graphic view (graphic-edit.js), kept like a dropped node.
export function setGraphicPosition(id, position) {
  graphicPositions.set(id, position);
  publishPosition(id, position, true);
}

// {memory, cpus} of a host: its own settings, else the defaults of its system.
function specsOf(machine) {
  const profile = store.images.find(item => item.id === machine.imageId);
  return {memory: machine.settings?.memory ?? profile?.memory, cpus: machine.settings?.cpus ?? profile?.cpus};
}

export function selectedGraphicLink() { return selectedLink; }
export function selectGraphicLink(id) { selectedLink = id; renderGraphic(); }

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function canvasSize() { return graphicCanvas.getBoundingClientRect(); }

function updateZoomControls() {
  graphicZoomLevel.textContent = `${Math.round(view.k * 100)}%`;
  graphicZoomOut.disabled = view.k <= MIN_ZOOM + 1e-6;
  graphicZoomIn.disabled = view.k >= MAX_ZOOM - 1e-6;
}
function applyViewport() {
  const svg = graphicCanvas.querySelector('.topology-svg');
  if (svg) TopologyGraphic.applyView(svg, view);
  graphicCanvas.style.setProperty('--graphic-grid', `${22 * view.k}px`);
  graphicCanvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
  updateZoomControls();
  noteViewport();
}

// The viewport of the view state: the world point at the canvas center (kept within the bounds)
// and the zoom. A change is published throttled (viewChanged publishes only actual changes, and
// only on the driver's page).
let viewportTimer = null;
function noteViewport() {
  const rect = canvasSize();
  if (!rect.width || !rect.height) return;
  const center = value => clamp(value, -MAX_CENTER, MAX_CENTER);
  const viewport = ViewState.normalizeViewport({cx: center((rect.width / 2 - view.x) / view.k), cy: center((rect.height / 2 - view.y) / view.k), k: view.k});
  if (shownViewport && viewport.cx === shownViewport.cx && viewport.cy === shownViewport.cy && viewport.k === shownViewport.k) return;
  shownViewport = viewport;
  if (viewportTimer === null) viewportTimer = setTimeout(publishViewport, PUBLISH_INTERVAL);
}
function publishViewport() {
  clearTimeout(viewportTimer);
  viewportTimer = null;
  viewChanged();
}
export const graphicViewport = () => shownViewport;

// Shows a viewport of a view state (workspace.js applyView: Follow, the owner's page under
// control, the view restored in this browser); null fits the drawing.
export function setGraphicViewport(viewport) {
  appliedViewport = viewport;
  if (!viewport) { wantedViewport = null; fitPending = true; if (store.graphicVisible) renderGraphic(); return; }
  fitPending = false;
  centerOn(viewport);
}
function centerOn(viewport) {
  const rect = canvasSize();
  if (!rect.width || !rect.height) { wantedViewport = viewport; return; }
  wantedViewport = null;
  view.k = clamp(viewport.k, MIN_ZOOM, MAX_ZOOM);
  view.x = rect.width / 2 - viewport.cx * view.k;
  view.y = rect.height / 2 - viewport.cy * view.k;
  applyViewport();
}

// Zooms by `factor` around the canvas pixel (cx, cy): the world point under it stays there.
function zoomAt(factor, cx, cy) {
  const k = clamp(view.k * factor, MIN_ZOOM, MAX_ZOOM);
  view.x = cx - (cx - view.x) * k / view.k;
  view.y = cy - (cy - view.y) * k / view.k;
  view.k = k;
  applyViewport();
}
function zoomCentered(factor) {
  if (viewDriver()) return;
  const rect = canvasSize();
  zoomAt(factor, rect.width / 2, rect.height / 2);
}

export function fitToView() {
  if (viewDriver() && !fitPending) return false;
  const bounds = graphicGraph && TopologyGraphic.boundsOf(graphicGraph);
  const rect = canvasSize();
  if (!bounds || !rect.width || !rect.height) return false;
  const margin = 28;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  view.k = clamp(Math.min((rect.width - 2 * margin) / width, (rect.height - 2 * margin) / height, 1.25), MIN_ZOOM, MAX_ZOOM);
  view.x = (rect.width - width * view.k) / 2 - bounds.minX * view.k;
  view.y = (rect.height - height * view.k) / 2 - bounds.minY * view.k;
  applyViewport();
  return true;
}

// Which interfaces are being captured, for the drawing: a link (host, interface) and a node.
const recordingIndicator = {
  link: (hostId, nic) => recordingOf(hostId).some(capture => capture.index === nic),
  node: id => recordingOf(id).length > 0
};
onCapturesChanged(() => renderGraphic());

export function renderGraphic() {
  refreshFloatingConsole();
  if (!store.graphicVisible) return;
  for (const id of graphicPositions.keys()) if (!machines.has(id)) graphicPositions.delete(id);
  const focusedId = document.activeElement?.closest?.('.topology-node')?.dataset.nodeId;
  const graph = TopologyGraphic.draw(graphicCanvas, machines.values(), graphicPositions,
    {view, linkStyle, selectedId: store.activeId, selectedLink, specs: specsOf, recording: recordingIndicator});
  graphicGraph = graph;
  if (selectedLink && !graph.links.some(link => `${link.hostId}:${link.nicIndex}` === selectedLink)) selectedLink = null;
  graphicSummary.textContent = `${graph.hosts} host${graph.hosts === 1 ? '' : 's'} · ${graph.switches} switch${graph.switches === 1 ? '' : 'es'} · ${graph.links.length} link${graph.links.length === 1 ? '' : 's'}`;
  if (wantedViewport) centerOn(wantedViewport);
  else if (fitPending && graph.nodes.length && fitToView()) fitPending = false;
  else applyViewport();
  if (focusedId) graphicCanvas.querySelector(`.topology-node[data-node-id="${CSS.escape(focusedId)}"]`)?.focus({preventScroll: true});
  refreshEditTools();
}

// ---- Pointer interaction -----------------------------------------------------------------------
// The pointer in canvas pixels, kept inside the canvas so a node dragged to its edge stays
// reachable at every zoom level.
function canvasPoint(event, keepInside = false) {
  const rect = canvasSize();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return keepInside ? {x: clamp(x, 24, Math.max(24, rect.width - 24)), y: clamp(y, 24, Math.max(24, rect.height - 24))} : {x, y};
}
export const worldPoint = point => ({x: (point.x - view.x) / view.k, y: (point.y - view.y) / view.k});
export const screenPoint = (x, y) => ({x: view.x + x * view.k, y: view.y + y * view.k});
export const worldFromEvent = event => worldPoint(canvasPoint(event));

function findNode(id) { return graphicGraph?.nodes.find(node => node.id === id); }

function selectNode(id) {
  if (viewDriver()) return false;
  selectedLink = null;
  selectMachine(id);
  return true;
}

function finishDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const finished = drag;
  drag = null;
  delete graphicCanvas.dataset.dragging;
  if (graphicCanvas.hasPointerCapture(event.pointerId)) graphicCanvas.releasePointerCapture(event.pointerId);
  const dropped = finished.type === 'node' && finished.moved && !finished.locked;
  if (dropped) publishPosition(finished.id, graphicPositions.get(finished.id), true);
  if (finished.type !== 'node' && finished.moved && !finished.locked) publishViewport();
  if (event.type === 'pointercancel') return;
  if (finished.type === 'node') {
    if (finished.moved) return;
    if (handleEditClick({nodeId: finished.id, event})) return;
    const now = performance.now();
    const double = lastTap.id === finished.id && now - lastTap.time < DOUBLE_CLICK_MS;
    lastTap = double ? {id: null, time: 0} : {id: finished.id, time: now};
    if (double) { if (selectNode(finished.id)) openFloatingConsole(); }
    else selectNode(finished.id);
  } else if (finished.type === 'link' && !finished.moved) {
    selectGraphicLink(selectedLink === finished.id ? null : finished.id);
  } else if (finished.type === 'background' && !finished.moved) {
    if (!handleEditClick({point: worldFromEvent(event), event})) { selectedLink = null; renderGraphic(); }
  }
}

function startDrag(event) {
  if (event.button !== 0 || event.target.closest('.graphic-tooltip, .graphic-popover')) return;
  const nodeElement = event.target.closest('.topology-node');
  const linkElement = event.target.closest('.topology-link');
  // No text selection and no native drag while the pointer works the canvas; the focus the
  // browser would have given is given explicitly.
  event.preventDefault();
  hideTooltip();
  const start = canvasPoint(event);
  // A node moves for the driver only (a write: canWrite), the canvas pans when this page drives
  // its view (viewDriver); a locked drag is still a click.
  const base = {pointerId: event.pointerId, startX: start.x, startY: start.y, moved: false, locked: nodeElement ? !canWrite() : !!viewDriver()};
  if (nodeElement) {
    const node = findNode(nodeElement.dataset.nodeId);
    if (!node) return;
    nodeElement.focus({preventScroll: true});
    drag = {...base, type: 'node', id: node.id, x: node.x, y: node.y};
  } else if (linkElement) drag = {...base, type: 'link', id: linkElement.dataset.linkId, viewX: view.x, viewY: view.y};
  else { graphicCanvas.focus({preventScroll: true}); drag = {...base, type: 'background', viewX: view.x, viewY: view.y}; }
  graphicCanvas.setPointerCapture(event.pointerId);
}

function moveDrag(event) {
  const point = canvasPoint(event, drag.type === 'node');
  const dx = point.x - drag.startX;
  const dy = point.y - drag.startY;
  if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  if (drag.locked) return;
  drag.moved = true;
  graphicCanvas.dataset.dragging = drag.type === 'node' ? 'node' : 'pan';
  if (drag.type === 'node') {
    const position = {x: drag.x + dx / view.k, y: drag.y + dy / view.k};
    graphicPositions.set(drag.id, position);
    publishPosition(drag.id, position, false);
    renderGraphic();
  } else {
    view.x = drag.viewX + dx;
    view.y = drag.viewY + dy;
    applyViewport();
  }
}

// ---- Hover details ---------------------------------------------------------------------------
const tooltip = document.createElement('div');
tooltip.className = 'graphic-tooltip';
tooltip.setAttribute('role', 'tooltip');
tooltip.hidden = true;
let tooltipId = null;

function hideTooltip() { tooltip.hidden = true; tooltipId = null; }
function showTooltip(node, event) {
  if (tooltipId !== node.id) {
    tooltipId = node.id;
    const info = TopologyGraphic.describe(node, graphicGraph);
    const machine = node.machine;
    const line = (text, className) => { const item = document.createElement('div'); if (className) item.className = className; item.textContent = text; return item; };
    const head = line(machine.hostname, 'tooltip-name');
    const state = document.createElement('span');
    state.className = 'tooltip-state';
    state.dataset.state = node.state;
    state.textContent = node.state.toUpperCase();
    head.append(state);
    tooltip.replaceChildren(head, line(info.kind), line(info.resources));
    if (machine.message && machine.message !== node.state) tooltip.append(line(machine.message, 'tooltip-note'));
    for (const text of info.interfaces) tooltip.append(line(text, 'tooltip-nic'));
    tooltip.append(line(viewDriver() || 'Click to select · double-click to open the console', 'tooltip-hint'));
  }
  tooltip.hidden = false;
  const rect = canvasSize();
  const x = event.clientX - rect.left + 16;
  const y = event.clientY - rect.top + 16;
  tooltip.style.left = `${Math.max(4, Math.min(x, rect.width - tooltip.offsetWidth - 4))}px`;
  tooltip.style.top = `${Math.max(4, Math.min(y, rect.height - tooltip.offsetHeight - 4))}px`;
}

// ---- Views -----------------------------------------------------------------------------------
export function setGraphicView(visible) {
  closeLayoutMenu();
  // The floating console stays open across the Terminals view: hidden now, shown again with the
  // Graphic view (public/graphic-console.js).
  hideFloatingConsole();
  store.graphicVisible = visible;
  document.body.dataset.view = visible ? 'graphic' : 'terminals';
  workspace.hidden = visible;
  graphicWorkspace.hidden = !visible;
  // The button names the view it switches to, with its icon: Graphic (blue) or Terminals (green).
  graphicToggle.innerHTML = visible ? `${TERMINALS_ICON}<span>Terminals</span>` : `${GRAPHIC_ICON}<span>Graphic</span>`;
  graphicToggle.className = `nav-button view-control ${visible ? 'act-green' : 'act-blue'}`;
  const label = visible ? 'Show Terminals view' : 'Show Graphic view';
  graphicToggle.setAttribute('aria-label', label);
  graphicToggle.title = label;
  if (visible) { renderGraphic(); showFloatingConsole(); }
  else requestAnimationFrame(fitTerminals);
  viewChanged();
}

export function toggleGraphicView() { setGraphicView(!store.graphicVisible); }

export function initGraphicView() {
  graphicCanvas.tabIndex = -1;
  graphicCanvas.append(tooltip);
  graphicCanvas.addEventListener('pointerdown', event => { if (!drag) startDrag(event); });
  graphicCanvas.addEventListener('pointermove', event => {
    if (drag) { if (event.pointerId === drag.pointerId) moveDrag(event); return; }
    const node = findNode(event.target.closest?.('.topology-node')?.dataset.nodeId);
    if (node && event.pointerType !== 'touch') showTooltip(node, event); else hideTooltip();
  });
  graphicCanvas.addEventListener('pointerleave', hideTooltip);
  graphicCanvas.addEventListener('pointerup', finishDrag);
  graphicCanvas.addEventListener('pointercancel', finishDrag);
  // No text selection in the canvas, whatever starts it (drag, double click, select all).
  graphicCanvas.addEventListener('selectstart', event => event.preventDefault());
  graphicCanvas.addEventListener('dblclick', event => event.preventDefault());
  graphicCanvas.addEventListener('dragstart', event => event.preventDefault());
  graphicCanvas.addEventListener('wheel', event => {
    event.preventDefault();
    if (viewDriver()) return;
    const point = canvasPoint(event);
    zoomAt(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015)), point.x, point.y);
  }, {passive: false});
  graphicCanvas.addEventListener('keydown', event => {
    const nodeElement = event.target.closest?.('.topology-node');
    if (nodeElement && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      if (selectNode(nodeElement.dataset.nodeId) && event.key === 'Enter') openFloatingConsole();
    } else if (event.key === 'Escape') { hideTooltip(); cancelEditMode(); if (selectedLink) selectGraphicLink(null); }
    else if ((event.target === graphicCanvas || nodeElement) && !viewDriver()) {
      if (event.key === '+' || event.key === '=') zoomCentered(1.25);
      else if (event.key === '-') zoomCentered(0.8);
      else if (event.key === '0') fitToView();
    }
  });
  graphicToggle.addEventListener('click', toggleGraphicView);
  graphicZoomOut.addEventListener('click', () => zoomCentered(0.8));
  graphicZoomIn.addEventListener('click', () => zoomCentered(1.25));
  graphicFit.addEventListener('click', fitToView);
  graphicLinks.addEventListener('click', toggleLinkStyle);
  loadLinkPreference();
  // A driven page keeps the driver's center and zoom when resized; the driver publishes its new center.
  new ResizeObserver(() => {
    if (!store.graphicVisible) return;
    if (viewDriver() && appliedViewport) centerOn(appliedViewport);
    else if (fitPending) renderGraphic();
    else noteViewport();
  }).observe(graphicCanvas);
  applyViewport();
}
