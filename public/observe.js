// Observation of another user's session by an administrator (/?observe=<login>), and the
// console control banner. The target belongs to this tab only: it comes from the URL and is
// kept in sessionStorage, never in a cookie. Every API request of the tab then carries
// "X-Observe: <login>" (see installAuthRedirect in api.js) and both Socket.IO connections pass
// it in their auth option. The server allows observers GET requests only and refuses their
// console input, clearing and resizing, unless they took control of a node (input only):
// the hidden controls below are a convenience, the server refusal is the protection.
import {machines, store} from './state.js';
import {panes} from './terminal.js';
import {selectMachine, showStatusError} from './workspace.js';
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

function renderControl() {
  if (document.body.dataset.observeUnavailable) return;
  if (observing) {
    const button = document.getElementById('observe-control');
    const status = document.getElementById('observe-status');
    if (!button) return;
    const nodeId = held ? held.nodeId : store.activeId;
    const other = nodeId && controls.get(nodeId);
    button.textContent = held ? 'Release control' : 'Take control';
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
    if (held?.nodeId === nodeId) held = null;
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

// What the owner last selected and showed; followed while Follow is on and the admin does
// not hold control. With Follow off the admin navigates freely.
const ownerView = {nodeId: null, mode: null};
const following = () => observing && !held && document.getElementById('observe-follow').checked;

export function followOwner(nodeId) {
  ownerView.nodeId = nodeId;
  if (!following()) return;
  if (machines.has(nodeId)) selectMachine(nodeId);
  else syncSessionsFromServer().then(() => { if (machines.has(nodeId) && following()) selectMachine(nodeId); });
}

export function followOwnerView(mode) {
  ownerView.mode = mode;
  if (following() && (mode === 'graphic') !== store.graphicVisible) setGraphicView(mode === 'graphic', false);
}

export function controlChanged() { renderControl(); }

function toggleControl() {
  if (held) {
    const {pane, nodeId} = held;
    pane.socket.emit('release-control', nodeId, () => {});
    held = null;
    renderControl();
    return;
  }
  const pane = panes[store.activePaneIndex];
  const nodeId = pane?.machineId;
  if (!nodeId) return;
  pane.socket.emit('take-control', nodeId, result => {
    if (result?.error) { showStatusError(result.error); return; }
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
  document.getElementById('observe-follow').addEventListener('change', () => {
    if (ownerView.mode) followOwnerView(ownerView.mode);
    if (ownerView.nodeId) followOwner(ownerView.nodeId);
  });
  renderSessionNavigation();
  setInterval(renderSessionNavigation, 10000);
  renderControl();
}
