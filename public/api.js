import {observeHeaders, observing} from './observe.js';
import {handleUnauthorized} from './session-expiry.js';
// HTTP helpers for the QemuWeb REST API.
// URL of a node resource: /api/nodes/<nodeId>[/<action>].
export function nodeUrl(nodeId, action = '') {
  return `/api/nodes/${encodeURIComponent(nodeId)}${action ? `/${action}` : ''}`;
}

// fetch() options for a JSON request body.
export function jsonRequest(method, data) {
  return {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)};
}

// Fetches a JSON response and throws the server error message (or the
// fallback message) when the HTTP status is not successful.
export async function requestJson(url, options, fallbackError) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || fallbackError);
  return body;
}

// URL of the launch preview of a host draft (settings, storage, commands).
export function launchOptionsUrl(machine, settings) {
  const params = new URLSearchParams({system: machine.imageId, engine: machine.engine, interfaces: JSON.stringify(machine.interfaces || []), settings: JSON.stringify(settings), startupDiskEnabled: String(!!machine.startupDiskEnabled)});
  return `${nodeUrl(machine.id, 'options')}?${params}`;
}

// After a 401 response or a Socket.IO authentication error: the login page (password login), or one reload that sends
// an identity from the front end to its login (public/session-expiry.js). Answers 'none' when it did nothing.
export const sessionLost = handleUnauthorized;

// The header text of a user: the login, with the display name the authenticating front end gave when there is one.
export function accountLabel(me) {
  return me.displayName ? `${me.displayName} (${me.login})` : me.login;
}

// Whether the Log out button is shown: not without authentication, and for an identity given by the authenticating front end only
// when --logout-url says where to go.
export function canLogOut(me) {
  return me.authMode !== 'off' && (me.via !== 'proxy' || !!me.logoutUrl);
}

// Log out: ends the QemuWeb login (cookie), then goes to the front end's logout URL for an identity it gave, else to the login page.
export async function logOut(me) {
  try { await fetch('/auth/logout', {method: 'POST'}); }
  finally {
    if (me.via === 'proxy' && me.logoutUrl) location.assign(me.logoutUrl);
    else location.assign('/login.html');
  }
}

// Every fetch() of the UI goes through this wrapper: a 401 response means the login
// session expired or was revoked, so the page returns to the login (see sessionLost). In an observation
// tab, it adds the X-Observe header to the session API requests (not to /api/admin).
export function installAuthRedirect() {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (resource, options = {}) => {
    const url = new URL(resource instanceof Request ? resource.url : String(resource), location.href);
    if (observing && url.origin === location.origin && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/admin/')) {
      options = {...options, headers: {...Object.fromEntries(new Headers(options.headers || {})), ...observeHeaders()}};
    }
    const response = await nativeFetch(resource, options);
    if (response.status === 401) sessionLost();
    return response;
  };
}
