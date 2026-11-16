// Supervision page (/admin, administrators only): every session with its metrics, refreshed
// every few seconds, the actions on sessions (observe, stop all, delete, bulk cleanup) and
// account management. Every change goes through /api/admin/*, which checks the role and
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
    const user = document.createElement('span');
    user.textContent = session.login;
    if (session.own) user.append(Object.assign(document.createElement('span'), {className: 'admin-own', textContent: ' (you)'}));
    const actions = document.createElement('div');
    actions.className = 'admin-actions';
    if (session.own) actions.append(Object.assign(document.createElement('a'), {href: '/', textContent: 'Open'}));
    else actions.append(Object.assign(document.createElement('a'), {href: `/?observe=${encodeURIComponent(session.login)}`, textContent: 'Observe', title: 'Read-only view of this session'}));
    actions.append(
      button('Stop all', () => runAction('sessions-error', () => api(`/sessions/${encodeURIComponent(session.login)}/stop`, {method: 'POST'})), 'Stop every VM and switch; the nodes are kept'),
      button('Delete', async () => {
        if (!await confirmDialog('Delete session', `Delete the session of ${session.login}? Every host and switch stops and is removed, with its disks.`, [], 'Delete')) return;
        runAction('sessions-error', () => api(`/sessions/${encodeURIComponent(session.login)}`, {method: 'DELETE'}));
      }));
    row.append(cell(check), cell(user), cell(dateTime(session.createdAt)),
      cell(`${session.hosts} hosts, ${session.switches} switches`),
      cell(`${session.runningHosts} / ${session.hosts}`),
      cell(session.reservedRamMb ? `${session.reservedRamMb} MB` : '—'),
      cell(Number.isFinite(session.cpuPercent) ? `${session.cpuPercent.toFixed(1)}%` : '—'),
      cell(age(session.lastActivity)), cell(actions));
    row.cells[7].title = dateTime(session.lastActivity);
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
    actions.append(toggle);
    row.append(cell(`${user.login}${own ? ' (you)' : ''}`), cell(role), cell(user.disabled ? 'disabled' : 'enabled'),
      cell(user.session ? 'yes' : '—'), cell(actions));
    if (user.disabled) row.dataset.disabled = 'true';
    return row;
  }));
}

async function refreshAccounts() {
  try { renderAccounts(await api('/users')); }
  catch (error) { showError('accounts-error', error); }
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
  $('create-account').addEventListener('submit', event => {
    event.preventDefault();
    const login = $('new-login').value.trim();
    runAction('accounts-error', async () => {
      await api('/users', {method: 'POST', body: {login, password: $('new-password').value, role: $('new-role').value}});
      $('create-account').reset();
    });
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
  refreshSessions();
  setInterval(refreshSessions, POLL_MS);
}

init();
