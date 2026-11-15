'use strict';

// Authentication facade. The rest of the server only uses this interface, so that the
// password store can later be replaced (OpenID Connect) without touching it:
//   mode                     'password', or 'off' (QEMUWEB_AUTH=off: one implicit local user)
//   authenticate(login, pw)  -> {login, role} or null
//   register(app)            /auth/login, /auth/logout and /auth/me
//   identify                 Express middleware setting req.user from the session cookie
//   checkOrigin              Express middleware refusing cross-site state-changing requests
//   requireUser              Express middleware: 401 JSON for the API, login redirect for pages
//   socketMiddleware         io.use() handler: Origin check, then socket.data.user from the cookie
// Environment:
//   QEMUWEB_AUTH             unset or 'password' (default), or 'off'
//   QEMUWEB_USERS_FILE       users file (default: users.json at the repository root)
//   QEMUWEB_SESSION_HOURS    sliding cookie lifetime in hours (default 12)
//   QEMUWEB_ALLOWED_ORIGINS  extra allowed origins, comma-separated (behind a proxy)
const path = require('path');
const express = require('express');
const {hashPassword, verifyPassword} = require('./passwords');
const {createUsersStore, usersFilePath, LOGIN_PATTERN} = require('./users-store');
const {COOKIE_NAME, loadSecret, signSession, verifySession, parseCookies, sessionCookie} = require('./cookie');
const {parseAllowedOrigins, originAllowed, isSafeMethod} = require('./origin');

const LOCAL_USER = Object.freeze({login: 'local', role: 'admin'});
// Public without a session: the login page, its assets and the /auth routes.
const PUBLIC_PATHS = new Set(['/login.html', '/login.js', '/css/app.css', '/favicon.svg']);
// The cookie is renewed at most once a minute while the user is active.
const RENEW_AFTER_MS = 60 * 1000;

function authMode(env) {
  const value = env.QEMUWEB_AUTH;
  if (value === undefined || value === '' || value === 'password') return 'password';
  if (value === 'off') return 'off';
  throw new Error(`Invalid QEMUWEB_AUTH: ${value} (expected "password" or "off").`);
}

function sessionLifetimeMs(env) {
  if (env.QEMUWEB_SESSION_HOURS === undefined || env.QEMUWEB_SESSION_HOURS === '') return 12 * 3600 * 1000;
  const hours = Number(env.QEMUWEB_SESSION_HOURS);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 90) throw new Error('QEMUWEB_SESSION_HOURS must be a number of hours between 0 and 2160.');
  return Math.round(hours * 3600 * 1000);
}

function createAuth({root, runtimeRoot, env = process.env, now = Date.now}) {
  const mode = authMode(env);
  const lifetimeMs = sessionLifetimeMs(env);
  const allowedOrigins = parseAllowedOrigins(env.QEMUWEB_ALLOWED_ORIGINS);
  const store = createUsersStore(usersFilePath(root, env));
  const secret = loadSecret(path.join(runtimeRoot, 'auth-secret'));
  // Unknown logins still cost one scrypt verification, like known ones.
  const dummyHash = hashPassword('qemuweb-unknown-user');

  async function authenticate(login, password) {
    if (mode === 'off') return LOCAL_USER;
    if (typeof login !== 'string' || typeof password !== 'string' || password.length > 1024) return null;
    const user = LOGIN_PATTERN.test(login) ? store.get(login) : null;
    const valid = await verifyPassword(password, user ? user.hash : await dummyHash);
    return user && valid ? {login: user.login, role: user.role} : null;
  }

  // The cookie's user, provided the account still exists.
  function sessionFromCookies(header) {
    const payload = verifySession(secret, parseCookies(header)[COOKIE_NAME], now());
    const user = payload && store.get(payload.login);
    return user ? {user: {login: user.login, role: user.role}, payload} : null;
  }

  function setSessionCookie(req, res, login) {
    const issued = now();
    const value = signSession(secret, {login, issued, expires: issued + lifetimeMs});
    res.append('Set-Cookie', sessionCookie(value, {maxAgeMs: lifetimeMs, secure: req.secure}));
  }

  function clearSessionCookie(req, res) {
    res.append('Set-Cookie', sessionCookie('', {maxAgeMs: 0, secure: req.secure}));
  }

  function identify(req, res, next) {
    if (mode === 'off') { req.user = LOCAL_USER; return next(); }
    let found;
    try { found = sessionFromCookies(req.headers.cookie); }
    catch (error) { return next(error); }
    if (found) {
      req.user = found.user;
      if (now() - found.payload.issued >= RENEW_AFTER_MS) setSessionCookie(req, res, found.user.login);
    }
    next();
  }

  function checkOrigin(req, res, next) {
    if (isSafeMethod(req.method) || originAllowed(req.headers.origin, req.headers.host, allowedOrigins)) return next();
    res.status(403).json({error: 'Cross-site request refused (missing or foreign Origin header).'});
  }

  function requireUser(req, res, next) {
    if (req.user || PUBLIC_PATHS.has(req.path) || req.path.startsWith('/auth/')) return next();
    if (req.path.startsWith('/api/') || req.path === '/api' || !['GET', 'HEAD'].includes(req.method)) {
      return res.status(401).json({error: 'Authentication required.'});
    }
    res.redirect(302, '/login.html');
  }

  function register(app) {
    const json = express.json({limit: '16kb'});
    app.post('/auth/login', json, async (req, res) => {
      try {
        const {login, password} = req.body || {};
        const user = await authenticate(login, password);
        if (!user) return res.status(401).json({error: 'Invalid login or password.'});
        if (mode === 'password') setSessionCookie(req, res, user.login);
        res.set('Cache-Control', 'no-store');
        res.json({login: user.login, role: user.role});
      } catch (error) {
        console.error('Login:', error);
        res.status(500).json({error: 'Login failed; see the server log.'});
      }
    });
    app.post('/auth/logout', (req, res) => {
      clearSessionCookie(req, res);
      res.json({ok: true});
    });
    app.get('/auth/me', (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!req.user) return res.status(401).json({error: 'Authentication required.', authMode: mode});
      res.json({login: req.user.login, role: req.user.role, authMode: mode});
    });
  }

  function socketMiddleware(socket, next) {
    const {headers} = socket.request;
    // Browsers always send Origin on a WebSocket or a cross-origin request, but may omit it on
    // a same-origin polling GET; a missing Origin is accepted unless Fetch metadata says
    // the request is cross-site. The cookie is required in every case.
    const sameSiteWithoutOrigin = headers.origin === undefined && headers['sec-fetch-site'] !== 'cross-site';
    if (!sameSiteWithoutOrigin && !originAllowed(headers.origin, headers.host, allowedOrigins)) {
      return next(new Error('Cross-site connection refused.'));
    }
    if (mode === 'off') { socket.data.user = LOCAL_USER; return next(); }
    let found;
    try { found = sessionFromCookies(headers.cookie); }
    catch (error) { return next(error); }
    if (!found) return next(new Error('Authentication required.'));
    socket.data.user = found.user;
    next();
  }

  return {mode, usersFile: store.file, userCount: () => store.count(), authenticate,
    register, identify, checkOrigin, requireUser, socketMiddleware};
}

module.exports = {createAuth, LOCAL_USER};
