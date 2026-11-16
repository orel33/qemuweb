'use strict';

// Authentication facade. The rest of the server only uses this interface, so that the
// password store can later be replaced (OpenID Connect) without touching it:
//   mode                     'password', or 'off' (QEMUWEB_AUTH=off: one implicit local user)
//   authenticate(login, pw)  -> {login, role} or null
//   register(app)            /auth/login, /auth/logout and /auth/me
//   identify                 Express middleware setting req.user from the session cookie
//   requireUser              Express middleware: 401 JSON for the API, login redirect for pages
//   requireAdmin             Express middleware: 403 unless req.user has the role admin
//   socketMiddleware         io.use() handler setting socket.data.user from the cookie
// Cross-site request (Origin/CSRF) checks are deferred to milestone 6: until then the
// SameSite=Lax cookie is the only protection, so QemuWeb needs its own domain name.
// Environment:
//   QEMUWEB_AUTH             unset or 'password' (default), or 'off'
//   QEMUWEB_USERS_FILE       users file (default: users.json at the repository root)
//   QEMUWEB_SESSION_HOURS    sliding cookie lifetime in hours (default 12)
const path = require('path');
const express = require('express');
const {hashPassword, verifyPassword} = require('./passwords');
const {createUsersStore, usersFilePath, LOGIN_PATTERN} = require('./users-store');
const {COOKIE_NAME, newSecret, signSession, verifySession, parseCookies, sessionCookie} = require('./cookie');

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

// `secret` signs the login cookies: a new one per server start (injected only by tests).
function createAuth({root, env = process.env, now = Date.now, secret = newSecret()}) {
  const mode = authMode(env);
  const lifetimeMs = sessionLifetimeMs(env);
  const store = createUsersStore(usersFilePath(root, env));
  // Unknown logins still cost one scrypt verification, like known ones.
  const dummyHash = hashPassword('qemuweb-unknown-user');

  async function authenticate(login, password) {
    if (mode === 'off') return LOCAL_USER;
    if (typeof login !== 'string' || typeof password !== 'string' || password.length > 1024) return null;
    const user = LOGIN_PATTERN.test(login) ? store.get(login) : null;
    const valid = await verifyPassword(password, user ? user.hash : await dummyHash);
    return user && valid && !user.disabled ? {login: user.login, role: user.role} : null;
  }

  // The cookie's user, provided the account still exists and is not disabled. The role is
  // read from the users file at every request, so a role change applies at once.
  function sessionFromCookies(header) {
    const payload = verifySession(secret, parseCookies(header)[COOKIE_NAME], now());
    const user = payload && store.get(payload.login);
    return user && !user.disabled ? {user: {login: user.login, role: user.role}, payload} : null;
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

  function requireUser(req, res, next) {
    if (req.user || PUBLIC_PATHS.has(req.path) || req.path.startsWith('/auth/')) return next();
    if (req.path.startsWith('/api/') || req.path === '/api' || !['GET', 'HEAD'].includes(req.method)) {
      return res.status(401).json({error: 'Authentication required.'});
    }
    res.redirect(302, '/login.html');
  }

  function requireAdmin(req, res, next) {
    if (req.user?.role === 'admin') return next();
    res.status(403).json({error: 'Administrator role required.'});
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
    if (mode === 'off') { socket.data.user = LOCAL_USER; return next(); }
    let found;
    try { found = sessionFromCookies(headers.cookie); }
    catch (error) { return next(error); }
    if (!found) return next(new Error('Authentication required.'));
    socket.data.user = found.user;
    next();
  }

  return {mode, usersFile: store.file, userCount: () => store.count(), authenticate,
    register, identify, requireUser, requireAdmin, socketMiddleware};
}

module.exports = {createAuth, LOCAL_USER};
