// Account controls in the header: user name, Supervision link (admins), Delete session, Log out, and the warning
// shown when authentication is disabled (QEMUWEB_AUTH=off). The session survives Log out.
import {installAuthRedirect, redirectToLogin, requestJson} from './api.js';
import {confirmAction} from './nodes.js';
import {showStatusError} from './workspace.js';
import {observedLogin} from './observe.js';

const account = document.getElementById('account');
const accountName = document.getElementById('account-name');
const authOffWarning = document.getElementById('auth-off-warning');
const logoutButton = document.getElementById('logout');
const deleteSessionButton = document.getElementById('delete-session');
const navSupervision = document.getElementById('nav-supervision');
const navSession = document.getElementById('nav-session');

export function initAccount() {
  installAuthRedirect();
  fetch('/auth/me', {cache: 'no-store'}).then(async response => {
    if (!response.ok) return;
    const me = await response.json();
    // Observing yourself is just your own session.
    if (observedLogin === me.login) { location.replace('/'); return; }
    // Admins navigate between Supervision, their session and observed ones; the page shown is
    // marked current (not a link). Students only have their own session.
    navSupervision.hidden = navSession.hidden = me.role !== 'admin';
    if (!observedLogin) {
      navSession.removeAttribute('href');
      navSession.setAttribute('aria-current', 'page');
      navSession.title = 'Your own session (this page)';
    }
    accountName.textContent = me.login;
    accountName.title = `Logged in as ${me.login} (${me.role})`;
    authOffWarning.hidden = me.authMode !== 'off';
    logoutButton.hidden = me.authMode === 'off';
    account.hidden = false;
  }).catch(error => console.error('Cannot read the current user:', error));
  deleteSessionButton.addEventListener('click', async () => {
    const message = 'Delete your session? Every host and switch stops and is removed, with its disks, consoles and logs. Save a session ZIP first to keep it.';
    if (!await confirmAction('Delete session', message, 'Delete session')) return;
    deleteSessionButton.disabled = true;
    try {
      await requestJson('/api/session', {method: 'DELETE'}, 'Cannot delete the session');
      location.reload();
    } catch (error) {
      showStatusError(`Cannot delete the session: ${error.message}`);
      deleteSessionButton.disabled = false;
    }
  });
  logoutButton.addEventListener('click', async () => {
    logoutButton.disabled = true;
    try { await fetch('/auth/logout', {method: 'POST'}); }
    finally { redirectToLogin(); }
  });
}
