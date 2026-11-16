// Supervision page (/admin, administrators only): every session with its metrics, refreshed
// every few seconds, the actions on sessions (observe, stop all, delete, bulk cleanup),
// account management, and the last entries of admin.log and users.log. Every change goes through /api/admin/*, which checks the role and
// writes logs/admin.log.
const POLL_MS = 4000;
const $ = id => document.getElementById(id);
const selected = new Set();
let me = null;

async function api(path, options = {}) {
  const init = {cache: 'no-store', ...options};
  if (options.body !== undefined) {
    init.headers = {'Content-Type': 'application/json'};
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`/api/admin${path}`, init);
  if (response.status === 401) { location.assign('/login.html'); throw new Error('Authentication required.'); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function showError(id, error) {
  const element = $(id);
  element.textContent = error ? error.message || String(error) : '';
  element.hidden = !error;
}

function cell(content) {
  const td = document.createElement('td');
  if (content instanceof Node) td.append(content); else td.textContent = content;
  return td;
}

function button(label, onClick, title = '') {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  if (title) element.title = title;
  element.addEventListener('click', onClick);
  return element;
}

function age(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ${Math.floor(seconds % 3600 / 60)} min ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

const dateTime = iso => new Date(iso).toLocaleString();
const shortDateTime = iso => new Date(iso).toLocaleString(undefined, {dateStyle: 'short', timeStyle: 'short'});
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : word.endsWith('h') ? 'es' : 's'}`;

// A login with the "(you)" mark of the admin's own row, in both tables.
function loginLabel(login, own) {
  const element = document.createElement('span');
  element.textContent = login;
  if (own) element.append(Object.assign(document.createElement('span'), {className: 'admin-own', textContent: ' (you)'}));
  return element;
}

// Sessions table only: a green dot + "online" (×n for several tabs) when the user has a
// browser connected, plain "offline" otherwise; the tab count is in the tooltip. A session
// lives on the server whether or not its user is connected. /admin opens no socket, so the
// admin's own row is online: they are looking at it.
function presence(browsers, own) {
  const online = own || browsers > 0;
  const element = document.createElement('span');
  element.className = 'presence';
  element.dataset.online = String(online);
  element.textContent = online ? `online${browsers > 1 ? ` ×${browsers}` : ''}` : 'offline';
  element.title = own && !browsers ? 'You, on this page'
    : browsers > 0 ? `${browsers} browser tab${browsers === 1 ? '' : 's'} connected` : 'No browser connected; the session keeps running';
  return element;
}

// "active": at least one running node; "idle": none (as in the observation drop-down).
function sessionState(active) {
  const element = document.createElement('span');
  element.className = 'session-state';
  element.dataset.state = active ? 'active' : 'idle';
  element.textContent = active ? 'active' : 'idle';
  return element;
}

// Resolves true when the admin accepts; lists `items` under the message.
function confirmDialog(title, message, items = [], accept = 'OK') {
  const dialog = $('admin-confirm');
  $('admin-confirm-title').textContent = title;
  $('admin-confirm-message').textContent = message;
  $('admin-confirm-list').replaceChildren(...items.map(item => Object.assign(document.createElement('li'), {textContent: item})));
  $('admin-confirm-accept').textContent = accept;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'accept'), {once: true}));
}

async function runAction(errorId, action) {
  showError(errorId, null);
  try { await action(); }
  catch (error) { showError(errorId, error); }
  await Promise.all([refreshSessions(), refreshAccounts()]);
}

async function deleteSessions(logins) {
  if (!logins.length) return;
  const ok = await confirmDialog('Delete sessions', 'Every host and switch of these sessions stops and is removed, with its disks. Their users\' browsers reload into a new, empty session.', logins, 'Delete');
  if (!ok) return;
  await runAction('sessions-error', async () => {
    await api('/sessions/delete', {method: 'POST', body: {logins}});
    for (const login of logins) selected.delete(login);
  });
}

function renderSessions(sessions) {
  const body = $('sessions-body');
  for (const login of [...selected]) if (!sessions.some(session => session.login === login)) selected.delete(login);
  body.replaceChildren(...sessions.map(session => {
    const row = document.createElement('tr');
    row.dataset.own = String(session.own);
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.disabled = session.own;
    check.checked = selected.has(session.login);
    check.setAttribute('aria-label', `Select the session of ${session.login}`);
    check.addEventListener('change', () => { if (check.checked) selected.add(session.login); else selected.delete(session.login); updateSelection(); });
    const user = loginLabel(session.login, session.own);
    user.append(presence(session.browsers, session.own));
    const actions = document.createElement('div');
    actions.className = 'admin-actions';
    if (session.own) actions.append(Object.assign(document.createElement('a'), {href: '/', className: 'admin-button', textContent: 'Open'}));
    else actions.append(Object.assign(document.createElement('a'), {href: `/?observe=${encodeURIComponent(session.login)}`, className: 'admin-button', textContent: 'Observe', title: 'Read-only view of this session'}));
    actions.append(
      button('Stop all', () => runAction('sessions-error', () => api(`/sessions/${encodeURIComponent(session.login)}/stop`, {method: 'POST'})), 'Stop every VM and switch; the nodes are kept'),
      button('Delete', async () => {
        if (!await confirmDialog('Delete session', `Delete the session of ${session.login}? Every host and switch stops and is removed, with its disks.`, [], 'Delete')) return;
        runAction('sessions-error', () => api(`/sessions/${encodeURIComponent(session.login)}`, {method: 'DELETE'}));
      }));
    row.append(cell(check), cell(user), cell(sessionState(session.active)), cell(shortDateTime(session.createdAt)),
      cell(`${plural(session.hosts, 'host')}, ${plural(session.switches, 'switch')}`),
      cell(`${session.runningHosts} / ${session.hosts}`),
      cell(session.reservedRamMb ? `${session.reservedRamMb} MB` : '—'),
      cell(Number.isFinite(session.cpuPercent) ? `${session.cpuPercent.toFixed(1)}%` : '—'),
      cell(age(session.lastActivity)), cell(actions));
    row.cells[3].title = dateTime(session.createdAt);
    row.cells[8].title = dateTime(session.lastActivity);
    return row;
  }));
  updateSelection();
}

function updateSelection() {
  $('delete-selected').disabled = !selected.size;
  $('delete-selected').textContent = selected.size ? `Delete selected (${selected.size})` : 'Delete selected';
  const boxes = [...$('sessions-body').querySelectorAll('input[type=checkbox]:not(:disabled)')];
  $('select-all').checked = boxes.length > 0 && boxes.every(box => box.checked);
}

let refreshing = false;
async function refreshSessions() {
  if (refreshing) return;
  refreshing = true;
  try {
    renderSessions(await api('/sessions'));
    $('sessions-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) { $('sessions-updated').textContent = `Not updated: ${error.message}`; }
  finally { refreshing = false; }
}

function renderAccounts(users) {
  $('accounts-body').replaceChildren(...users.map(user => {
    const own = me && user.login === me.login;
    const row = document.createElement('tr');
    const role = document.createElement('select');
    role.setAttribute('aria-label', `Role of ${user.login}`);
    for (const value of ['student', 'admin']) role.append(new Option(value, value, false, value === user.role));
    role.disabled = own;
    role.title = own ? 'You cannot change your own role' : '';
    role.addEventListener('change', () => runAction('accounts-error', () => api(`/users/${encodeURIComponent(user.login)}`, {method: 'PATCH', body: {role: role.value}})));
    const actions = document.createElement('div');
    actions.className = 'admin-actions';
    actions.append(button('Reset password', () => resetPassword(user.login)));
    const toggle = button(user.disabled ? 'Enable' : 'Disable', () => runAction('accounts-error',
      () => api(`/users/${encodeURIComponent(user.login)}`, {method: 'PATCH', body: {disabled: !user.disabled}})),
    user.disabled ? 'Allow this account to log in again' : 'Refuse its logins and cookies at once; its session is kept');
    toggle.disabled = own;
    const remove = button('Remove', async () => {
      const message = `Remove the account ${user.login}? It can no longer log in, its open pages are logged out at once, and its session, if any, is deleted with every host, switch and disk.`;
      if (!await confirmDialog('Remove account', message, [], 'Remove')) return;
      runAction('accounts-error', () => api(`/users/${encodeURIComponent(user.login)}`, {method: 'DELETE'}));
    }, 'Remove this account from users.json and delete its session');
    remove.disabled = own;
    actions.append(toggle, remove);
    row.append(cell(loginLabel(user.login, own)), cell(role), cell(user.disabled ? 'disabled' : 'enabled'), cell(actions));
    if (user.disabled) row.dataset.disabled = 'true';
    return row;
  }));
}

// The poll does not redraw the table while the admin is using one of its controls.
async function refreshAccounts({polling = false} = {}) {
  if (polling && $('accounts-body').contains(document.activeElement)) return;
  try { renderAccounts(await api('/users')); }
  catch (error) { showError('accounts-error', error); }
}

// One line per log entry: time, who, what, target, result.
function formatLogEntry(entry) {
  const target = entry.target && typeof entry.target === 'object'
    ? Object.entries(entry.target).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`).join(' ') : '';
  const time = Number.isFinite(Date.parse(entry.time)) ? new Date(entry.time).toLocaleString() : String(entry.time);
  return [time, entry.admin ?? entry.user ?? '', entry.action ?? entry.event ?? '', target, entry.result ?? ''].join('  ').trimEnd();
}

let logName = 'admin';
// The poll leaves the panel alone while the admin selects text in it or scrolls up.
async function refreshLog({polling = false} = {}) {
  const view = $('log-view');
  const selection = document.getSelection();
  const reading = view.scrollTop + view.clientHeight < view.scrollHeight - 4
    || (selection && !selection.isCollapsed && view.contains(selection.anchorNode));
  if (polling && reading) return;
  const name = logName;
  try {
    const {entries} = await api(`/logs/${name}?lines=200`);
    if (name !== logName) return;
    view.textContent = entries.length ? entries.map(formatLogEntry).join('\n') : `${name === 'admin' ? 'admin.log' : 'users.log'} is empty.`;
    view.scrollTop = view.scrollHeight;
    $('log-status').textContent = `Last ${entries.length} entries`;
  } catch (error) { $('log-status').textContent = `Not updated: ${error.message}`; }
}

function selectLog(name) {
  logName = name;
  for (const tab of document.querySelectorAll('.admin-log-tabs [data-log]')) tab.setAttribute('aria-selected', String(tab.dataset.log === name));
  $('log-download').href = `/api/admin/logs/${name}/download`;
  $('log-view').textContent = '';
  refreshLog();
}

let passwordLogin = null;
function resetPassword(login) {
  passwordLogin = login;
  $('password-title').textContent = `Reset the password of ${login}`;
  $('reset-password').value = '';
  showError('password-error', null);
  $('password-dialog').showModal();
}

function init() {
  fetch('/auth/me', {cache: 'no-store'}).then(async response => {
    if (!response.ok) return;
    me = await response.json();
    $('account-name').textContent = me.login;
    $('auth-off-warning').hidden = me.authMode !== 'off';
    $('logout').hidden = me.authMode === 'off';
    refreshAccounts();
  });
  $('logout').addEventListener('click', async () => {
    try { await fetch('/auth/logout', {method: 'POST'}); } finally { location.assign('/login.html'); }
  });
  $('select-all').addEventListener('change', event => {
    for (const box of $('sessions-body').querySelectorAll('input[type=checkbox]:not(:disabled)')) {
      box.checked = event.target.checked;
      box.dispatchEvent(new Event('change'));
    }
  });
  $('delete-selected').addEventListener('click', () => deleteSessions([...selected].sort()));
  $('inactive-form').addEventListener('submit', async event => {
    event.preventDefault();
    showError('sessions-error', null);
    try {
      const {hours, logins} = await api(`/sessions/inactive?hours=${encodeURIComponent($('inactive-hours').value)}`);
      if (!logins.length) { showError('sessions-error', `No session is inactive for ${hours} hours (your own is never included).`); return; }
      await deleteSessions(logins);
    } catch (error) { showError('sessions-error', error); }
  });
  $('show-create-account').addEventListener('click', () => {
    $('create-account').reset();
    showError('create-account-error', null);
    $('create-account-dialog').showModal();
  });
  $('create-account-cancel').addEventListener('click', () => $('create-account-dialog').close());
  $('create-account').addEventListener('submit', async event => {
    event.preventDefault();
    const login = $('new-login').value.trim();
    try {
      await api('/users', {method: 'POST', body: {login, password: $('new-password').value, role: $('new-role').value}});
      $('create-account').reset();
      $('create-account-dialog').close();
      await refreshAccounts();
    } catch (error) { showError('create-account-error', error); }
  });
  $('password-cancel').addEventListener('click', () => $('password-dialog').close());
  $('password-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await api(`/users/${encodeURIComponent(passwordLogin)}/password`, {method: 'POST', body: {password: $('reset-password').value}});
      $('reset-password').value = '';
      $('password-dialog').close();
    } catch (error) { showError('password-error', error); }
  });
  for (const tab of document.querySelectorAll('.admin-log-tabs [data-log]')) tab.addEventListener('click', () => selectLog(tab.dataset.log));
  refreshSessions();
  refreshLog();
  setInterval(() => { refreshSessions(); refreshAccounts({polling: true}); refreshLog({polling: true}); }, POLL_MS);
}

init();
