// Account controls in the header: user name, Log out, and the warning shown when
// authentication is disabled (QEMUWEB_AUTH=off).
import {installAuthRedirect, redirectToLogin} from './api.js';

const account = document.getElementById('account');
const accountName = document.getElementById('account-name');
const authOffWarning = document.getElementById('auth-off-warning');
const logoutButton = document.getElementById('logout');

export function initAccount() {
  installAuthRedirect();
  fetch('/auth/me', {cache: 'no-store'}).then(async response => {
    if (!response.ok) return;
    const me = await response.json();
    accountName.textContent = me.login;
    accountName.title = `Logged in as ${me.login} (${me.role})`;
    authOffWarning.hidden = me.authMode !== 'off';
    logoutButton.hidden = me.authMode === 'off';
    account.hidden = false;
  }).catch(error => console.error('Cannot read the current user:', error));
  logoutButton.addEventListener('click', async () => {
    logoutButton.disabled = true;
    try { await fetch('/auth/logout', {method: 'POST'}); }
    finally { redirectToLogin(); }
  });
}
