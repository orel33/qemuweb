'use strict';

// Shared helpers of the integration scenarios: a temporary users file, a test server
// started with it, and an HTTP + Socket.IO client that logs in like a browser (cookie jar,
// Origin header). The server has no test backdoor: scenarios authenticate for real.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const io = require('socket.io-client');
const {hashPassword} = require('../../lib/auth/passwords');
const {writeUsers} = require('../../lib/auth/users-store');

const root = path.join(__dirname, '..', '..');
const COOKIE_NAME = 'qemuweb_session';

// Writes a users file in a new temporary directory. Each user gets a random password
// unless one is given. Returns {file, users: [{login, password, role}], cleanup()}.
async function createTestUsers(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-users-'));
  const file = path.join(dir, 'users.json');
  const users = entries.map(entry => ({role: 'student', password: crypto.randomBytes(12).toString('base64url'), ...entry}));
  writeUsers(file, await Promise.all(users.map(async user => ({login: user.login, role: user.role, hash: await hashPassword(user.password)}))));
  return {file, users, cleanup: () => fs.rmSync(dir, {recursive: true, force: true})};
}

// Starts server.js on the given port with the users file (password authentication).
function spawnServer({port, usersFile, env = {}}) {
  const serverEnv = {...process.env, PORT: String(port), QEMUWEB_TEST_SERVER: '1', QEMUWEB_USERS_FILE: usersFile, ...env};
  delete serverEnv.QEMUWEB_AUTH;
  return spawn(process.execPath, ['server.js'], {cwd: root, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe']});
}

class QemuWebClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.origin = new URL(baseUrl).origin;
    this.cookie = null;
    this.login = null;
  }

  storeCookies(response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';');
      const index = pair.indexOf('=');
      if (pair.slice(0, index).trim() !== COOKIE_NAME) continue;
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some(attribute => /^\s*max-age=0\s*$/i.test(attribute));
      this.cookie = value && !expired ? value : null;
    }
  }

  headers(extra = {}) {
    return {origin: this.origin, ...(this.cookie ? {cookie: `${COOKIE_NAME}=${this.cookie}`} : {}), ...extra};
  }

  // Raw fetch() with the session cookie and Origin; keeps cookies the server sends back.
  async fetch(route, {method = 'GET', body, headers = {}, ...options} = {}) {
    const json = body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string';
    const response = await fetch(`${this.baseUrl}${route}`, {
      method, redirect: 'manual', ...options,
      headers: this.headers({...(json ? {'content-type': 'application/json'} : {}), ...headers}),
      body: json ? JSON.stringify(body) : body
    });
    this.storeCookies(response);
    return response;
  }

  // JSON request; throws "<METHOD> <route> returned <status>: <error>" when not successful.
  async request(route, options = {}) {
    const method = options.method || 'GET';
    const response = await this.fetch(route, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`${method} ${route} returned ${response.status}: ${payload.error || JSON.stringify(payload)}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async waitForServer(timeoutMs = 30000, isAlive = () => true) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive()) throw new Error('QemuWeb exited during startup.');
      try {
        const response = await fetch(`${this.baseUrl}/auth/me`);
        if (response.status === 200 || response.status === 401) return;
      } catch (_) { /* Not listening yet. */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`QemuWeb did not start within ${timeoutMs} ms.`);
  }

  async signIn(login, password) {
    await this.request('/auth/login', {method: 'POST', body: {login, password}});
    if (!this.cookie) throw new Error(`No session cookie after logging in as ${login}.`);
    this.login = login;
    return this;
  }

  async signOut() {
    await this.request('/auth/logout', {method: 'POST'});
    this.login = null;
  }

  // Socket.IO client authenticated with this client's cookie.
  socket(options = {}) {
    return io(this.baseUrl, {reconnection: false, timeout: 10000, ...options, extraHeaders: this.headers(options.extraHeaders)});
  }
}

module.exports = {createTestUsers, spawnServer, QemuWebClient, COOKIE_NAME};
