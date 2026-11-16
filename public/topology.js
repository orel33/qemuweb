// Graphic network view and .topo topology load/save.
import {generalSettings, graphicLayoutKey, machines, saveViewSettings, savedViewSettings, store} from './state.js';
import {jsonRequest, requestJson} from './api.js';
import {fitTerminals} from './terminal.js';
import {selectMachine, workspace} from './workspace.js';
import {publishOwnerView} from './socket.js';

const graphicWorkspace = document.getElementById('graphic-workspace');
const graphicCanvas = document.getElementById('graphic-canvas');
const graphicSummary = document.getElementById('graphic-summary');
const graphicToggle = document.getElementById('toggle-graphic-view');
const GRAPHIC_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/></svg>';
const TERMINALS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>';
const graphicZoomOut = document.getElementById('graphic-zoom-out');
const graphicZoomIn = document.getElementById('graphic-zoom-in');
const graphicZoomLevel = document.getElementById('graphic-zoom-level');

let graphicGraph = null;
let graphicDrag = null;
let suppressGraphicClick = false;
const graphicPositions = new Map();
let graphicSessionId = null;
export function loadGraphicPositions(sessionId) {
  graphicSessionId = sessionId;
  graphicPositions.clear();
  try {
    const saved = JSON.parse(localStorage.getItem(graphicLayoutKey) || '{}');
    if (saved.sessionId !== sessionId || !saved.positions || typeof saved.positions !== 'object') return;
    for (const [id, position] of Object.entries(saved.positions)) {
      if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) graphicPositions.set(id, position);
    }
  } catch (_) {}
}
function saveGraphicPositions() {
  if (!graphicSessionId) return;
  try {
    localStorage.setItem(graphicLayoutKey, JSON.stringify({sessionId: graphicSessionId, positions: Object.fromEntries(graphicPositions)}));
  } catch (_) {}
}
function applyGraphicZoom() {
  const svg = graphicCanvas.querySelector('.topology-svg');
  if (svg) {
    svg.style.width = `${store.graphicZoom * 100}%`;
    svg.style.minWidth = `${900 * store.graphicZoom}px`;
  }
  graphicZoomLevel.textContent = `${Math.round(store.graphicZoom * 100)}%`;
  graphicZoomOut.disabled = store.graphicZoom <= 0.5;
  graphicZoomIn.disabled = store.graphicZoom >= 2;
}
export function renderGraphic() {
  if (!store.graphicVisible) return;
  const scrollLeft = graphicCanvas.scrollLeft;
  const scrollTop = graphicCanvas.scrollTop;
  for (const id of graphicPositions.keys()) if (!machines.has(id)) graphicPositions.delete(id);
  const graph = TopologyGraphic.draw(graphicCanvas, machines.values(), id => {
    if (suppressGraphicClick) return;
    setGraphicView(false);
    selectMachine(id);
  }, graphicPositions);
  graphicGraph = graph;
  graphicSummary.textContent = `${graph.hosts} host${graph.hosts === 1 ? '' : 's'} · ${graph.switches} switch${graph.switches === 1 ? '' : 'es'} · ${graph.links.length} link${graph.links.length === 1 ? '' : 's'}`;
  applyGraphicZoom();
  graphicCanvas.scrollLeft = scrollLeft;
  graphicCanvas.scrollTop = scrollTop;
}
function graphicPointerPosition(event) {
  const svg = graphicCanvas.querySelector('.topology-svg');
  const matrix = svg?.getScreenCTM();
  if (!matrix) return null;
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(matrix.inverse());
}

function finishGraphicDrag(event) {
  if (!graphicDrag || event.pointerId !== graphicDrag.pointerId) return;
  if (graphicDrag.moved) {
    suppressGraphicClick = true;
    setTimeout(() => { suppressGraphicClick = false; }, 0);
    saveGraphicPositions();
  }
  graphicDrag = null;
  delete graphicCanvas.dataset.dragging;
  if (graphicCanvas.hasPointerCapture(event.pointerId)) graphicCanvas.releasePointerCapture(event.pointerId);
}

// persist: save in this browser's view settings (not when an observer follows the owner).
export function setGraphicView(visible, persist = true) {
  store.graphicVisible = visible;
  document.body.dataset.view = visible ? 'graphic' : 'terminals';
  workspace.hidden = visible;
  graphicWorkspace.hidden = !visible;
  // The icon shows the view the button switches to: Lucide Network, or SquareTerminal.
  graphicToggle.innerHTML = visible ? TERMINALS_ICON : GRAPHIC_ICON;
  const label = visible ? 'Show Terminals view' : 'Show Graphic view';
  graphicToggle.setAttribute('aria-label', label);
  graphicToggle.title = label;
  if (visible) renderGraphic();
  else requestAnimationFrame(fitTerminals);
  if (persist) saveViewSettings();
  publishOwnerView();
}

const topologyFile = document.getElementById('topology-file');
const topologyDialog = document.getElementById('topology-dialog');
const topologyError = document.getElementById('topology-error');
const topologyConfirm = document.getElementById('confirm-topology');
const topologyCounts = document.getElementById('topology-counts');
const topologyCancel = document.getElementById('cancel-topology');
let topologyLoaded = false;
let topologyText = '';

export function initTopology() {
  graphicCanvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const nodeElement = event.target.closest('.topology-node');
    const node = graphicGraph?.nodes.find(item => item.id === nodeElement?.dataset.nodeId);
    const pointer = graphicPointerPosition(event);
    if (!node || !pointer) return;
    graphicDrag = {pointerId: event.pointerId, id: node.id, x: node.x, y: node.y, startX: pointer.x, startY: pointer.y, moved: false};
    graphicCanvas.setPointerCapture(event.pointerId);
  });
  graphicCanvas.addEventListener('pointermove', event => {
    if (!graphicDrag || event.pointerId !== graphicDrag.pointerId) return;
    const pointer = graphicPointerPosition(event);
    if (!pointer) return;
    const dx = pointer.x - graphicDrag.startX;
    const dy = pointer.y - graphicDrag.startY;
    if (!graphicDrag.moved && Math.hypot(dx, dy) < 5) return;
    graphicDrag.moved = true;
    graphicPositions.set(graphicDrag.id, {x: graphicDrag.x + dx, y: graphicDrag.y + dy});
    graphicCanvas.dataset.dragging = 'true';
    renderGraphic();
  });
  graphicCanvas.addEventListener('pointerup', finishGraphicDrag);
  graphicCanvas.addEventListener('pointercancel', finishGraphicDrag);
  graphicCanvas.addEventListener('click', event => {
    if (suppressGraphicClick) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  graphicToggle.addEventListener('click', () => setGraphicView(!store.graphicVisible));
  graphicZoomOut.addEventListener('click', () => { store.graphicZoom = Math.max(0.5, store.graphicZoom - 0.25); applyGraphicZoom(); saveViewSettings(); });
  graphicZoomIn.addEventListener('click', () => { store.graphicZoom = Math.min(2, store.graphicZoom + 0.25); applyGraphicZoom(); saveViewSettings(); });
  applyGraphicZoom();
  setGraphicView(savedViewSettings.view === 'graphic', false);
  document.getElementById('load-topology').addEventListener('click', () => topologyFile.click());
  topologyCancel.addEventListener('click', () => topologyDialog.close());
  topologyDialog.addEventListener('cancel', event => { if (topologyConfirm.disabled) event.preventDefault(); });
  topologyDialog.addEventListener('close', () => { if (topologyLoaded) location.reload(); });
  topologyFile.addEventListener('change', async () => {
    const file = topologyFile.files[0];
    if (!file) return;
    topologyFile.value = '';
    document.getElementById('topology-title').textContent = 'Load topology';
    document.getElementById('topology-file-name').textContent = file.name;
    topologyCounts.textContent = '';
    document.getElementById('topology-options').hidden = false;
    topologyError.hidden = true; topologyConfirm.hidden = false; topologyConfirm.disabled = true;
    topologyCancel.textContent = 'Cancel';
    document.getElementById('topology-autostart').checked = true;
    document.getElementById('topology-close-previous').checked = false;
    topologyDialog.showModal();
    try {
      if (!/\.topo$/i.test(file.name)) throw new Error('Choose a .topo file.');
      topologyText = await file.text();
      const result = await requestJson('/api/topology/preview', jsonRequest('POST', {text: topologyText, engine: generalSettings.engine}), 'Invalid topology.');
      topologyCounts.textContent = `${result.hosts} hosts · ${result.switches} switches`;
      topologyConfirm.disabled = false;
    }
    catch (error) { topologyText = ''; topologyError.textContent = error.message; topologyError.hidden = false; topologyConfirm.hidden = true; topologyConfirm.disabled = false; }
  });
  document.getElementById('topology-form').addEventListener('submit', async event => {
    event.preventDefault();
    topologyConfirm.disabled = true;
    topologyCancel.disabled = true;
    try {
      const result = await requestJson('/api/topology', jsonRequest('POST', {text: topologyText, engine: generalSettings.engine, autostart: document.getElementById('topology-autostart').checked, closePrevious: document.getElementById('topology-close-previous').checked}), 'Cannot load topology.');
      topologyLoaded = true;
      if (result.errors?.length) {
        topologyError.textContent = result.errors.join('\n'); topologyError.hidden = false;
        topologyConfirm.hidden = true; topologyCancel.textContent = 'Close';
      } else location.reload();
    } catch (error) { topologyError.textContent = error.message; topologyError.hidden = false; }
    finally { topologyConfirm.disabled = false; topologyCancel.disabled = false; }
  });
  document.getElementById('save-topology').addEventListener('click', async () => {
    try {
      const response = await fetch('/api/topology', {cache: 'no-store'});
      if (!response.ok) { const result = await response.json(); throw new Error(result.error); }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = 'network.topo'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      document.getElementById('topology-title').textContent = 'Save topology';
      document.getElementById('topology-file-name').textContent = '';
      topologyCounts.textContent = '';
      document.getElementById('topology-options').hidden = true;
      topologyError.textContent = error.message; topologyError.hidden = false;
      topologyConfirm.hidden = true; document.getElementById('cancel-topology').textContent = 'Close'; topologyDialog.showModal();
    }
  });
}
