// Observation of another user's session by an administrator (/?observe=<login>), and the
// console control banner. The target belongs to this tab only: it comes from the URL and is
// kept in sessionStorage, never in a cookie. Every API request of the tab then carries
// "X-Observe: <login>" (see installAuthRedirect in api.js) and both Socket.IO connections pass
// it in their auth option. The server allows observers GET requests only and refuses their
// console input, clearing and resizing, unless they took control of a node (input only):
// the hidden controls below are a convenience, the server refusal is the protection.
import {machines, store} from './state.js';
import {panes} from './terminal.js';
import {showOwnerLayout, showStatusError} from './workspace.js';
import {syncSessionsFromServer} from './nodes.js';
import {setGraphicView} from './topology.js';

const STORAGE_KEY = 'qemuweb-observe';

function readTarget() {
  const target = new URLSearchParams(location.search).get('observe') || null;
  try {
    if (target) sessionStorage.setItem(STORAGE_KEY, target);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch (_) { /* Storage unavailable: the URL still carries the target. */ }
  return target;
}

export const observedLogin = readTarget();
export const observing = !!observedLogin;
if (observing) document.body.classList.add('observing');

// Admin sessions held by someone: nodeId -> admin login.
const controls = new Map();
// The node this tab controls, as {pane, nodeId}, or null.
let held = null;

export function observeHeaders() { return observing ? {'X-Observe': observedLogin} : {}; }

// Options of every io() call of the UI. The session socket (one per tab) is marked main: the
// server counts those to show who is online.
export function socketOptions({main = false} = {}) {
  return {transports: ['websocket', 'polling'], auth: {...(main ? {main: true} : {}), ...(observing ? {observe: observedLogin} : {})}};
}

// Whether a pane's keyboard input may be sent to its node.
export function canType(pane) {
  if (observing) return !!held && held.pane === pane && held.nodeId === pane.machineId;
  return !controls.has(pane.machineId);
}

const banner = document.getElementById('observe-banner');
const controlBanner = document.getElementById('control-banner');

function nodeName(nodeId) { return machines.get(nodeId)?.hostname || 'a node'; }

// Lucide Hand (take control) and LockOpen (release control), like the other inline icons.
const SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const TAKE_ICON = `${SVG}<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>`;
const RELEASE_ICON = `${SVG}<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;

function renderControl() {
  if (document.body.dataset.observeUnavailable) return;
  if (observing) {
    const button = document.getElementById('observe-control');
    const status = document.getElementById('observe-status');
    if (!button) return;
    const nodeId = held ? held.nodeId : store.activeId;
    const other = nodeId && controls.get(nodeId);
    if (button.dataset.held !== String(!!held)) {
      button.dataset.held = String(!!held);
      button.innerHTML = `${held ? RELEASE_ICON : TAKE_ICON}${held ? 'Release control' : 'Take control'}`;
      button.className = `observe-button ${held ? 'act-green' : 'act-amber'}`;
      button.title = held ? 'Give the keyboard back to the user' : 'Take exclusive control of the selected console';
    }
    button.disabled = !held && (!nodeId || !!other);
    status.textContent = held ? `You control the console of ${nodeName(held.nodeId)}`
      : other ? `${other} controls the console of ${nodeName(nodeId)}` : 'read-only';
    banner.dataset.control = String(!!held);
    return;
  }
  const lines = [...controls].map(([nodeId, admin]) => `${admin} controls the console of ${nodeName(nodeId)}`);
  controlBanner.textContent = lines.length ? `${lines.join(' · ')}. You see the commands and their output; your keyboard is blocked on that console.` : '';
  controlBanner.hidden = !lines.length;
}

// console-control {nodeId, admin, active} and the control field of node-snapshot.
export function applyControl(nodeId, admin, active) {
  if (active) controls.set(nodeId, admin);
  else {
    controls.delete(nodeId);
    if (held?.nodeId === nodeId) { held = null; applyOwnerView(true); }
  }
  renderControl();
}

// The observed login has no session: it never used QemuWeb since the server started, or its
// session was deleted. The page replaces the workspace with a message and a way back.
export function observationUnavailable(reason = 'no session') {
  if (!observing) return;
  const text = reason === 'deleted'
    ? `The session of ${observedLogin} was deleted.`
    : `${observedLogin} has no session: the user has not used QemuWeb since the server started, or the session was deleted.`;
  document.getElementById('observe-notice-text').textContent = text;
  document.getElementById('observe-notice').hidden = false;
  document.getElementById('observe-status').textContent = 'no session';
  document.getElementById('observe-control').disabled = true;
  document.body.dataset.observeUnavailable = 'true';
}

// What the owner shows (owner-view: active node, Terminals or Graphic, console layout), followed
// while Follow is on and the admin does not hold control, never saved in the admin's own view
// settings. With Follow off the admin navigates freely. Only the latest owner view counts.
let ownerView = null;
// Following also pauses while a take-control request is pending: re-laying out the panes
// then could move the pane that is taking control to another node.
let taking = false;
const following = () => observing && !held && !taking && document.getElementById('observe-follow').checked;

// mayRefresh: a node unknown here (created meanwhile) triggers one refresh of the node list,
// which calls refollow() when it is done.
function applyOwnerView(mayRefresh) {
  if (!following() || !ownerView) return;
  const graphic = ownerView.mode === 'graphic';
  if (graphic !== store.graphicVisible) setGraphicView(graphic, false);
  if (ownerView.nodeId && !machines.has(ownerView.nodeId)) {
    if (mayRefresh) syncSessionsFromServer();
    return;
  }
  showOwnerLayout(ownerView);
}

export function followOwnerView(view) {
  if (!observing || !view) return;
  ownerView = view;
  applyOwnerView(true);
}

// After the node list was (re)loaded: show the owner's node again.
export function refollow() { applyOwnerView(false); }

export function controlChanged() { renderControl(); }

function toggleControl() {
  if (held) {
    const {pane, nodeId} = held;
    pane.socket.emit('release-control', nodeId, () => {});
    held = null;
    renderControl();
    applyOwnerView(true);
    return;
  }
  const pane = panes[store.activePaneIndex];
  const nodeId = pane?.machineId;
  if (!nodeId || taking) return;
  taking = true;
  pane.socket.emit('take-control', nodeId, result => {
    taking = false;
    if (result?.error) { showStatusError(result.error); applyOwnerView(true); return; }
    held = {pane, nodeId};
    controls.set(nodeId, 'you');
    renderControl();
    pane.terminal.focus();
  });
}

const goTo = login => location.assign(`/?observe=${encodeURIComponent(login)}`);

async function renderSessionNavigation() {
  const select = document.getElementById('observe-select');
  let sessions;
  try {
    const response = await fetch('/api/admin/sessions', {cache: 'no-store'});
    if (!response.ok) return;
    sessions = (await response.json()).filter(session => !session.own);
  } catch (_) { return; }
  if (!sessions.some(session => session.login === observedLogin)) observationUnavailable();
  select.replaceChildren(...sessions.map(session => {
    const option = document.createElement('option');
    option.value = session.login;
    option.textContent = `${session.login}${session.active ? '' : ' (idle)'}${session.browsers > 0 ? '' : ' (offline)'}`;
    option.selected = session.login === observedLogin;
    return option;
  }));
  // Previous and next go round the active sessions only.
  const ring = sessions.filter(session => session.active || session.login === observedLogin).map(session => session.login);
  const index = ring.indexOf(observedLogin);
  for (const [id, step] of [['observe-previous', -1], ['observe-next', 1]]) {
    const button = document.getElementById(id);
    const target = ring.length > 1 ? ring[(index + step + ring.length) % ring.length] : null;
    button.disabled = !target;
    button.onclick = () => target && goTo(target);
  }
}

// Builds the banner. The server audits the observation when the console sockets connect.
export function initObserve() {
  if (!observing) return;
  document.title = `QemuWeb · observing ${observedLogin}`;
  banner.hidden = false;
  document.getElementById('observe-user').textContent = observedLogin;
  document.getElementById('observe-select').addEventListener('change', event => goTo(event.target.value));
  document.getElementById('observe-control').addEventListener('click', toggleControl);
  document.getElementById('observe-follow').addEventListener('change', () => applyOwnerView(true));
  renderSessionNavigation();
  setInterval(renderSessionNavigation, 10000);
  renderControl();
}
