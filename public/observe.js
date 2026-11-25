// Observation of another user's session by an administrator (/?observe=<login>), and the
// console control banner. The target belongs to this tab only: it comes from the URL and is
// kept in sessionStorage, never in a cookie. Every API request of the tab then carries
// "X-Observe: <login>" (see installAuthRedirect in api.js) and both Socket.IO connections pass
// it in their auth option. The server allows observers GET requests only and refuses their
// console input, clearing and resizing, unless they took control of the session: that admin then
// does what the owner can (except Delete session), and the owner's page is read-only meanwhile.
// The disabled controls below are a convenience, the server refusal is the protection.
import {machines, store} from './state.js';
import {panes} from './terminal.js';
import {applyView, closeLayoutMenu, showStatusError} from './workspace.js';
import {syncSessionsFromServer} from './nodes.js';
import {emitOnSession, publishView} from './socket.js';
import {canWrite as writeAllowed, controlReason, followReason, showReason, takeControlReason, viewReason} from './disabled-reason.js';

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

// Whether this page may write to the session (one driver at a time): the owner while nobody
// controls it, the admin holding control.
export function canWrite() { return writeAllowed(controlState()); }
// Why this page may not write ('' when it may): the reason of a write action (disabled-reason.js).
export function writeRefusal() { return controlReason({write: true}, controlState()); }
// The administrator controlling the session, or null.
export const controllingAdmin = () => control?.admin || null;

// Whether a pane's keyboard input may be sent: the controlling admin types into any node,
// the owner into none while the session is controlled.
export function canType(pane) {
  return !!pane.machineId && canWrite();
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
    }
    const blocked = takeControlReason(controlState());
    button.disabled = !!blocked;
    button.title = blocked || (mine ? 'Give the keyboard back to the user' : 'Take exclusive control of every console of this session');
    // Holding control: the view is the admin's own and Follow is meaningless, so it shows checked.
    const follow = document.getElementById('observe-follow');
    if (mine) follow.checked = true;
    follow.disabled = mine;
    for (const element of [follow, follow.parentElement]) showReason(element, followReason(controlState()));
    status.textContent = mine ? `You control the session of ${observedLogin}`
      : control ? `${control.admin} controls this session` : `read-only${following() ? `; the view follows ${observedLogin} (uncheck Follow to change it)` : ''}`;
    banner.dataset.control = String(mine);
    renderViewDriver();
    return;
  }
  controlBanner.textContent = control
    ? `${control.admin} controls your session. You see the commands and their output; your keyboard and your actions are blocked, and ${control.admin} controls your view.` : '';
  controlBanner.hidden = !control;
  renderViewDriver();
}

// One driver at a time. The view of this page is driven by the other side, and its view
// controls (class view-control) are disabled, when it is the owner's page under control, or an
// observer following the owner (Follow checked, no control held). With Follow unchecked the
// observer's controls are usable and the view stays as it is.
// Returns the reason, or '' when this page drives its own view.
export function viewDriver() { return viewReason(controlState()); }

// The state the reasons of the disabled controls depend on (disabled-reason.js).
function controlState() {
  return {observing, login: observedLogin, following: following(), holding: heldByMe(), admin: control?.admin || null, taking};
}

function renderViewDriver() {
  const reason = viewDriver();
  document.body.dataset.viewDriven = String(!!reason);
  // The write actions are greyed out (CSS) while this page may not write, and Delete session
  // also for the admin holding control.
  document.body.dataset.writeBlocked = String(!canWrite());
  document.body.dataset.ownerOnlyBlocked = String(observing);
  if (reason) { closeLayoutMenu(); for (const pane of panes) pane.viewMenu.open = false; }
  markDisabledControls();
}

// What this page must not use: the view controls while the view is driven by the other side,
// and the write actions while this page may not write (their CSS greys them out).
const isDisabled = element => !!element.closest && !!controlReason({view: !!element.closest('.view-control'),
  write: !!element.closest('.write-action'), ownerOnly: !!element.closest('.owner-only')}, controlState());

// aria-disabled and the reason as the tooltip on those controls (on the summary of a menu: it is
// what the user points at); also called when controls are created (renderTabs).
export function markDisabledControls() {
  const state = controlState();
  for (const element of document.querySelectorAll('.view-control, .write-action')) {
    const {classList} = element;
    const reason = controlReason({view: classList.contains('view-control'), write: classList.contains('write-action'), ownerOnly: classList.contains('owner-only')}, state);
    const target = element.querySelector(':scope > summary') || element;
    if (reason) target.setAttribute('aria-disabled', 'true'); else target.removeAttribute('aria-disabled');
    showReason(target, reason);
  }
}

// The mouse reaches a disabled control, so that its tooltip shows: clicks, keyboard and
// programmatic ones too, are ignored here, and a press does not take the focus.
function blockDisabledControls(event) {
  if (!isDisabled(event.target)) return;
  if (event.type === 'mousedown') { event.preventDefault(); return; }
  if (event.type.startsWith('key') && !['Enter', ' ', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

// console-control {admin, active}: the session-level state, sent on every change and at each
// connection.
export function applyControl({admin, active} = {}) {
  const wasControlled = controlledByAdmin();
  const wasMine = heldByMe();
  control = active && admin ? {admin} : null;
  renderControl();
  // Control over, on the owner's page: keep what is displayed and publish its own view again.
  if (wasControlled && !controlledByAdmin()) { received.controller = null; publishView({force: true}); }
  // On the controlling admin's page: from now on the owner's page follows this one; when
  // control ends, Follow resumes.
  if (!wasMine && heldByMe()) publishView({force: true});
  if (wasMine && !heldByMe()) followView('owner', true);
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
  const button = document.getElementById('observe-control');
  button.disabled = true;
  button.title = 'No session to control';
  document.body.dataset.observeUnavailable = 'true';
}

// Received views (view states, public/view-state.js), the latest of each kind:
//   owner       the owner's view, on an observer's page: followed while Follow is on and this
//               admin does not hold control (with Follow off the admin navigates freely);
//   controller  the controlling admin's view, on the owner's page, while the session is controlled.
// A followed view is normalized against this page's nodes, then shown with applyView (never
// saved here).
const received = {owner: null, controller: null};
// Following also pauses while a take-control request is pending: re-laying out the panes
// then could move the pane that is taking control to another node.
let taking = false;
const followState = () => ({observing, holding: heldByMe(), taking, controlled: !!control,
  followChecked: observing && document.getElementById('observe-follow').checked});
const following = () => ViewState.followsView('owner', followState());
const shouldFollow = kind => ViewState.followsView(kind, followState());

// mayRefresh: a view naming a node not known here yet (created meanwhile) first refreshes the
// node list, which follows the view again (refollow); a node still unknown then is left out.
function followView(kind, mayRefresh) {
  const view = received[kind];
  if (!view || !shouldFollow(kind)) return;
  if (mayRefresh && [view.active, ...view.panes].some(id => id && !machines.has(id))) {
    syncSessionsFromServer();
    return;
  }
  const normalized = ViewState.normalizeView(view, machines);
  if (normalized) applyView(normalized);
}

export function viewReceived(kind, view) {
  if ((kind === 'owner') !== observing) return;
  received[kind] = ViewState.normalizeView(view, null);
  followView(kind, true);
}

// After the node list was (re)loaded.
export function refollow() {
  followView('owner', false);
  followView('controller', false);
}

export function controlChanged() { renderControl(); }

// Take or release control of the whole session, through the page's session socket. The banner
// changes only when the server's console-control event arrives.
function toggleControl() {
  if (heldByMe()) { emitOnSession('release-control', () => {}); return; }
  if (taking) return;
  // Control starts from the owner's exact view: Follow is forced on and that view applied first,
  // then this page drives (controller-view, published once control is granted).
  document.getElementById('observe-follow').checked = true;
  followView('owner', true);
  taking = true;
  renderControl();
  emitOnSession('take-control', result => {
    taking = false;
    renderControl();
    if (result?.error) { showStatusError(result.error); followView('owner', true); return; }
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
  for (const type of ['click', 'dblclick', 'mousedown', 'keydown', 'keyup']) document.addEventListener(type, blockDisabledControls, true);
  if (!observing) return;
  document.title = `QemuWeb · observing ${observedLogin}`;
  banner.hidden = false;
  document.getElementById('observe-user').textContent = observedLogin;
  document.getElementById('observe-select').addEventListener('change', event => goTo(event.target.value));
  document.getElementById('observe-control').addEventListener('click', toggleControl);
  fetch('/auth/me', {cache: 'no-store'}).then(response => (response.ok ? response.json() : null)).then(me => {
    myLogin = me?.login || null;
    renderControl();
    if (heldByMe()) publishView({force: true});
  }).catch(() => {});
  document.getElementById('observe-follow').addEventListener('change', () => { renderControl(); followView('owner', true); });
  renderSessionNavigation();
  setInterval(renderSessionNavigation, 10000);
  renderControl();
}
