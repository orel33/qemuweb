// Account controls in the header: user name, Supervision link (admins), Delete session, Log out, and the warning
// shown when authentication is disabled (--no-auth). The session survives Log out. An identity given by the OpenID front end
// shows its display name, and Log out goes to --logout-url (no button without it).
import {installAuthRedirect, requestJson, accountLabel, canLogOut, logOut} from './api.js';
import {confirmAction} from './nodes.js';
import {showStatusError} from './workspace.js';
import {observedLogin} from './observe.js';

const account = document.getElementById('account');
const accountName = document.getElementById('account-name');
const authOffWarning = document.getElementById('auth-off-warning');
const logoutButton = document.getElementById('logout');
const deleteSessionButton = document.getElementById('delete-session');
const navSupervision = document.getElementById('nav-supervision');

let currentUser = null;

export function initAccount() {
  installAuthRedirect();
  fetch('/auth/me', {cache: 'no-store'}).then(async response => {
    if (!response.ok) return;
    const me = await response.json();
    // Observing yourself is just your own session.
    if (observedLogin === me.login) { location.replace('/'); return; }
    // Admins go to Supervision from their session or an observed one; students never see it.
    navSupervision.hidden = me.role !== 'admin';
    accountName.textContent = accountLabel(me);
    accountName.title = `Logged in as ${me.login} (${me.role})${me.mail ? `, ${me.mail}` : ''}`;
    authOffWarning.hidden = me.authMode !== 'off';
    logoutButton.hidden = !canLogOut(me);
    currentUser = me;
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
    await logOut(currentUser || {});
  });
}
