// What a page does when the server (or the front end) says that its login is gone: a 401 from the API or the
// Socket.IO error "Authentication required.".
//   password login   the login form (/login.html), as before.
//   proxy identity   the SSO session of the authenticating front end expired: Apache sends a page request to
//                    the login of the SSO, so the page reloads, once; a second 401 within RELOAD_GUARD_MS
//                    (the reload did not help) is left to the caller, which shows its usual error.
export const RELOAD_GUARD_MS = 30 * 1000;
const STORAGE_KEY = 'qemuweb-sso-reload';

// The decision, pure: 'login' | 'reload' | 'none'. via is the `via` of /auth/me ('password', 'proxy'; null while unknown);
// lastReload is the time (ms) of the last automatic reload, or null.
export function unauthorizedAction({via, now, lastReload}) {
  if (via !== 'proxy') return 'login';
  const recent = Number.isFinite(lastReload) && now >= lastReload && now - lastReload < RELOAD_GUARD_MS;
  return recent ? 'none' : 'reload';
}

let identityVia = null;
let leaving = false;

// Called once /auth/me is known.
export function setIdentityVia(via) {
  identityVia = via || null;
}

function lastReloadTime() {
  try { return Number(sessionStorage.getItem(STORAGE_KEY)) || null; }
  catch (_) { return null; }
}

// Acts on a 401 and answers what it did: 'login' or 'reload' (the page is leaving), 'none' (the caller shows its error).
export function handleUnauthorized() {
  if (leaving) return 'login';
  const now = Date.now();
  const action = unauthorizedAction({via: identityVia, now, lastReload: lastReloadTime()});
  if (action === 'none') return action;
  leaving = true;
  if (action === 'reload') {
    try { sessionStorage.setItem(STORAGE_KEY, String(now)); } catch (_) { /* The guard is lost: at worst one more reload. */ }
    location.reload();
  } else location.assign('/login.html');
  return action;
}
