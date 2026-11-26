// Account controls in the header: user name, Admin link (admins), Log out, and the warning
// shown when authentication is disabled (--no-auth). The session survives Log out. An identity given by the authenticating front end
// shows its display name, and Log out goes to --logout-url (no button without it).
import {installAuthRedirect, accountLabel, canLogOut, logOut} from './api.js';
import {observedLogin} from './observe.js';
import {setIdentityVia} from './session-expiry.js';

const account = document.getElementById('account');
const accountName = document.getElementById('account-name');
const authOffWarning = document.getElementById('auth-off-warning');
const logoutButton = document.getElementById('logout');
const navAdmin = document.getElementById('nav-admin');

let currentUser = null;

export function initAccount() {
  installAuthRedirect();
  fetch('/auth/me', {cache: 'no-store'}).then(async response => {
    if (!response.ok) return;
    const me = await response.json();
    setIdentityVia(me.via);
    // Observing yourself is just your own session.
    if (observedLogin === me.login) { location.replace('/'); return; }
    // Admins go to Admin from their session or an observed one; students never see it.
    navAdmin.hidden = me.role !== 'admin';
    accountName.textContent = accountLabel(me);
    accountName.title = `Logged in as ${me.login} (${me.role})${me.mail ? `, ${me.mail}` : ''}`;
    authOffWarning.hidden = me.authMode !== 'off';
    logoutButton.hidden = !canLogOut(me);
    currentUser = me;
    account.hidden = false;
  }).catch(error => console.error('Cannot read the current user:', error));
  logoutButton.addEventListener('click', async () => {
    logoutButton.disabled = true;
    await logOut(currentUser || {});
  });
}
