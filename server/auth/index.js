'use strict';

// Authentication facade, and the one place where the identity of a request is resolved: the rest of
// the server only uses this interface (HTTP routes, /admin, X-Observe, Socket.IO and console control all read
// req.user or socket.data.user, {login, role}, plus via: 'proxy', displayName? and mail? for an identity from the authenticating front end.
//   mode                     'password', 'proxy', 'both' (--auth) or 'off' (--no-auth: one implicit local user)
//   authenticate(login, pw)  -> {login, role} or null (a user from the proxy also has via: 'proxy', displayName?, mail?)
//   register(app)            /auth/login, /auth/logout and /auth/me
//   identify                 Express middleware setting req.user: the identity given by the authenticating front end
//                            (server/auth/proxy.js, only with the right X-Proxy-Key; it wins), else the session cookie
//   requireUser              Express middleware: 401 JSON for the API, login redirect for pages (401 for all in proxy mode)
//   requireAdmin             Express middleware: 403 unless req.user has the role admin
//   socketMiddleware         io.use() handler setting socket.data.user the same way
//   currentUser(login, via)  {login, role} of an account allowed now (via 'proxy': any login that is not disabled), else null
// Cross-site request (Origin/CSRF) checks are deferred to milestone 6: until then the
// SameSite=Lax cookie is the only protection, so QemuWeb needs its own domain name.
// Settings (server/options.js): authMode, usersFile, sessionHours (the sliding cookie lifetime), proxyKeyFile,
// logoutUrl.
const path = require('path');
const express = require('express');
const {hashPassword, verifyPassword} = require('./passwords');
const {createUsersStore, LOGIN_PATTERN} = require('./users-store');
const {readProxyKey, createProxyIdentity} = require('./proxy');
const {COOKIE_NAME, newSecret, signSession, verifySession, parseCookies, sessionCookie} = require('./cookie');

const LOCAL_USER = Object.freeze({login: 'local', role: 'admin'});
const REFUSED = {403: 'Forbidden.'};
// Public without a session: the login page, its assets and the /auth routes.
const PUBLIC_PATHS = new Set(['/login.html', '/login.js', '/css/app.css', '/favicon.svg']);
// The cookie is renewed at most once a minute while the user is active.
const RENEW_AFTER_MS = 60 * 1000;

// Attempted login names in users.log: printable characters only, at most 64 of them.
function attemptedLogin(login) {
  return typeof login === 'string' ? login.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64) : '';
}

// `secret` signs the login cookies: a new one per server start (injected only by tests); `proxyKey` is
// the shared key read from --proxy-key-file (also injected by tests).
// userLog (server/audit.js createUserLog) receives login, login-failed, logout and proxy-refused events.
function createAuth({settings, now = Date.now, secret = newSecret(), userLog = {record() {}}, proxyKey}) {
  const mode = settings.authMode;
  const usesProxy = mode === 'proxy' || mode === 'both';
  const usesPassword = mode === 'password' || mode === 'both';
  const lifetimeMs = Math.round(settings.sessionHours * 3600 * 1000);
  const store = createUsersStore(settings.usersFile);
  // Unknown logins still cost one scrypt verification, like known ones.
  const dummyHash = hashPassword('qemuweb-unknown-user');
  const proxy = usesProxy ? createProxyIdentity({key: proxyKey ?? readProxyKey(settings.proxyKeyFile), store, userLog, now}) : null;

  // A proxy identity has no login request: its first request, and the first one after as long a pause as the
  // cookie lifetime, is logged as a login (users.log), like a password login.
  const lastProxySeen = new Map();
  function noteProxyLogin(user) {
    const time = now();
    const previous = lastProxySeen.get(user.login);
    lastProxySeen.set(user.login, time);
    if (previous === undefined || time - previous >= lifetimeMs) userLog.record(user.login, 'login', {via: 'proxy'});
  }

  // The identity of a request or handshake from its headers: {user} (the proxy's, else the cookie's), {refused: code}
  // for a wrong key or a refused account, or {} for nobody.
  function identityOf(headers) {
    if (mode === 'off') return {user: LOCAL_USER};
    if (proxy) {
      const found = proxy.resolve(headers);
      if (found.status === 'refused') return {refused: found.code};
      if (found.status === 'ok') { noteProxyLogin(found.user); return {user: found.user}; }
    }
    if (!usesPassword) return {};
    const session = sessionFromCookies(headers.cookie);
    return session ? {user: session.user, session: session.payload} : {};
  }

  async function authenticate(login, password) {
    if (mode === 'off') return LOCAL_USER;
    if (!usesPassword || typeof login !== 'string' || typeof password !== 'string' || password.length > 1024) return null;
    const user = LOGIN_PATTERN.test(login) ? store.get(login) : null;
    // An account without a password still costs one verification, like an unknown login.
    const valid = await verifyPassword(password, user?.hash || await dummyHash);
    return user && user.hash && valid && !user.disabled ? {login: user.login, role: user.role} : null;
  }

  // The cookie's user, provided the account still exists and is not disabled. The role is
  // read from the users file at every request, so a role change applies at once.
  function sessionFromCookies(header) {
    const payload = verifySession(secret, parseCookies(header)[COOKIE_NAME], now());
    const user = payload && store.get(payload.login);
    return user && !user.disabled ? {user: {login: user.login, role: user.role}, payload} : null;
  }

  // Same lookup as the cookie check, for connections opened earlier (server/sockets.js).
  function currentUser(login, via = 'password') {
    if (mode === 'off') return login === LOCAL_USER.login ? LOCAL_USER : null;
    if (via === 'proxy') return proxy ? proxy.current(login) : null;
    const user = usesPassword ? store.get(login) : null;
    return user && !user.disabled ? {login: user.login, role: user.role} : null;
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
    let found;
    try { found = identityOf(req.headers); }
    catch (error) { return next(error); }
    if (found.refused) return res.status(found.refused).json({error: REFUSED[found.refused]});
    if (found.user) {
      req.user = found.user;
      if (found.session && now() - found.session.issued >= RENEW_AFTER_MS) setSessionCookie(req, res, found.user.login);
    }
    next();
  }

  function requireUser(req, res, next) {
    if (req.user || (mode !== 'proxy' && (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/auth/'))) || (mode === 'proxy' && req.path === '/auth/me')) return next();
    if (mode === 'proxy') return res.status(401).json({error: 'Authentication required.'});
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
      if (!usesPassword) return res.status(404).json({error: 'Password login is not enabled (--auth proxy).'});
      try {
        const {login, password} = req.body || {};
        const user = await authenticate(login, password);
        if (!user) {
          userLog.record(attemptedLogin(login), 'login-failed');
          return res.status(401).json({error: 'Invalid login or password.'});
        }
        userLog.record(user.login, 'login', {via: 'password'});
        if (mode === 'password') setSessionCookie(req, res, user.login);
        res.set('Cache-Control', 'no-store');
        res.json({login: user.login, role: user.role});
      } catch (error) {
        console.error('Login:', error);
        res.status(500).json({error: 'Login failed; see the server log.'});
      }
    });
    app.post('/auth/logout', (req, res) => {
      if (req.user) userLog.record(req.user.login, 'logout', mode === 'off' ? undefined : {via: req.user.via || 'password'});
      clearSessionCookie(req, res);
      res.json({ok: true});
    });
    app.get('/auth/me', (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!req.user) return res.status(401).json({error: 'Authentication required.', authMode: mode});
      const {login, role, via, displayName, mail} = req.user;
      // The logout URL is the front end's: it only applies to an identity that came from it.
      res.json({login, role, authMode: mode, ...(mode !== 'off' ? {via: via || 'password'} : {}), ...(displayName ? {displayName} : {}), ...(mail ? {mail} : {}),
        ...(via === 'proxy' && settings.logoutUrl ? {logoutUrl: settings.logoutUrl} : {})});
    });
  }

  function socketMiddleware(socket, next) {
    let found;
    try { found = identityOf(socket.request.headers); }
    catch (error) { return next(error); }
    if (found.refused) return next(new Error(REFUSED[found.refused]));
    if (!found.user) return next(new Error('Authentication required.'));
    socket.data.user = found.user;
    next();
  }

  return {mode, usersFile: store.file, userCount: () => store.count(), authenticate,
    register, identify, requireUser, requireAdmin, socketMiddleware, currentUser};
}

module.exports = {createAuth, LOCAL_USER};
