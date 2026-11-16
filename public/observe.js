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
import {emitOnSession, publishOwnerView} from './socket.js';

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

// The session's control state, as the server last said (console-control {admin, active}):
// {admin} while an administrator controls the session, else null. Nothing else is kept, so the
// banners cannot drift from the server.
let control = null;
// This page's login (observation tabs): to know whether the controlling admin is us.
let myLogin = null;
const heldByMe = () => observing && !!control && control.admin === myLogin;

export function observeHeaders() { return observing ? {'X-Observe': observedLogin} : {}; }

// Options of every io() call of the UI. The session socket (one per tab) is marked main: the
// server counts those to show who is online.
export function socketOptions({main = false} = {}) {
  return {transports: ['websocket', 'polling'], auth: {...(main ? {main: true} : {}), ...(observing ? {observe: observedLogin} : {})}};
}

// Whether a pane's keyboard input may be sent: the controlling admin types into any node,
// the owner into none while the session is controlled.
export function canType(pane) {
  return !!pane.machineId && (observing ? heldByMe() : !control);
}

const banner = document.getElementById('observe-banner');
const controlBanner = document.getElementById('control-banner');

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
    const mine = heldByMe();
    if (button.dataset.held !== String(mine)) {
      button.dataset.held = String(mine);
      button.innerHTML = `${mine ? RELEASE_ICON : TAKE_ICON}${mine ? 'Release control' : 'Take control'}`;
      button.className = `observe-button ${mine ? 'act-green' : 'act-amber'}`;
      button.title = mine ? 'Give the keyboard back to the user' : 'Take exclusive control of every console of this session';
    }
    button.disabled = taking || (!mine && !!control);
    status.textContent = mine ? `You control the session of ${observedLogin}`
      : control ? `${control.admin} controls this session` : 'read-only';
    banner.dataset.control = String(mine);
    return;
  }
  controlBanner.textContent = control
    ? `${control.admin} controls your session. You see the commands and their output; your keyboard is blocked on every console, and your view follows the administrator's.` : '';
  controlBanner.hidden = !control;
  // While controlled, the owner's page is driven by the controller: its layout controls are
  // disabled (CSS) and it does not publish its own view.
  document.body.dataset.controlled = String(!!control);
}

// console-control {admin, active}: the session-level state, sent on every change and at each
// connection.
export function applyControl({admin, active} = {}) {
  const wasControlled = controlledByAdmin();
  const wasMine = heldByMe();
  control = active && admin ? {admin} : null;
  renderControl();
  // Control over, on the owner's page: keep what is displayed and publish its own view again.
  if (wasControlled && !controlledByAdmin()) { controllerView = null; publishOwnerView({force: true}); }
  // On the controlling admin's page: from now on the owner's page follows this one; when
  // control ends, Follow resumes.
  if (!wasMine && heldByMe()) publishOwnerView({force: true});
  if (wasMine && !heldByMe()) applyOwnerView(true);
}

// The admin's page holds control: it publishes its view to the owner (controller-view).
export const holdingControl = heldByMe;
// The owner's page while an administrator controls its session.
export const controlledByAdmin = () => !observing && !!control;

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
const following = () => observing && !heldByMe() && !taking && document.getElementById('observe-follow').checked;

// Shows a published view (owner-view or controller-view) without saving it in this browser's
// view settings.
function showView(view, mayRefresh) {
  const graphic = view.mode === 'graphic';
  if (graphic !== store.graphicVisible) setGraphicView(graphic, false);
  // A node not known here yet (created meanwhile): refresh the node list first, which applies
  // the view again (refollow); a node still unknown after that leaves its pane empty.
  if (mayRefresh && [view.nodeId, ...view.panes].some(id => id && !machines.has(id))) {
    syncSessionsFromServer();
    return;
  }
  showOwnerLayout(view);
}

// Observer side: the owner's view, while following.
function applyOwnerView(mayRefresh) {
  if (following() && ownerView) showView(ownerView, mayRefresh);
}

// Owner side: while an administrator controls one of its consoles, the owner's page shows the
// controller's view (the reverse of Follow). Only the latest one counts.
let controllerView = null;
function applyControllerView(mayRefresh) {
  if (controlledByAdmin() && controllerView) showView(controllerView, mayRefresh);
}

export function followController(view) {
  if (observing || !view) return;
  controllerView = view;
  applyControllerView(true);
}

export function followOwnerView(view) {
  if (!observing || !view) return;
  ownerView = view;
  applyOwnerView(true);
}

// After the node list was (re)loaded: show the owner's node again.
export function refollow() {
  applyOwnerView(false);
  applyControllerView(false);
}

export function controlChanged() { renderControl(); }

// Take or release control of the whole session, through the page's session socket. The banner
// changes only when the server's console-control event arrives.
function toggleControl() {
  if (heldByMe()) { emitOnSession('release-control', () => {}); return; }
  if (taking) return;
  taking = true;
  renderControl();
  emitOnSession('take-control', result => {
    taking = false;
    renderControl();
    if (result?.error) { showStatusError(result.error); applyOwnerView(true); return; }
    panes[store.activePaneIndex]?.terminal.focus();
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
  fetch('/auth/me', {cache: 'no-store'}).then(response => (response.ok ? response.json() : null)).then(me => {
    myLogin = me?.login || null;
    renderControl();
    if (heldByMe()) publishOwnerView({force: true});
  }).catch(() => {});
  document.getElementById('observe-follow').addEventListener('change', () => applyOwnerView(true));
  renderSessionNavigation();
  setInterval(renderSessionNavigation, 10000);
  renderControl();
}
