'use strict';

// Boot newly prepared Alpine, Debian Cloud and OpenWrt bases with isolated media.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const io = require('socket.io-client');

const root = path.resolve(__dirname, '..');
const profiles = process.env.GTS16_PROFILES ? process.env.GTS16_PROFILES.split(',') : ['alpine', 'debian13-cloud', 'openwrt'];
const engine = process.env.GTS16_ENGINE || 'qemu';
const ids = profiles.map((_, index) => `gts16-profile-${process.pid}-${index}`);
let child;
let baseUrl;
let serverOutput = '';

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(label, condition, timeout = 180000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (condition()) return;
    if (child?.exitCode !== null) throw new Error(`Server exited while waiting for ${label}: ${serverOutput.slice(-2000)}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}; server: ${serverOutput.slice(-2000)}`);
}

async function request(route, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${route}`, {method, headers: body === undefined ? {} : {'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${route}: ${result.error || response.status}`);
  return result;
}

async function run() {
  for (const profile of profiles) assert.ok(fs.existsSync(path.join(root, 'images', `${profile}.raw`)), `Missing prepared ${profile} RAW base`);
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {cwd: root, env: {...process.env, PORT: String(port)}, stdio: ['ignore', 'pipe', 'pipe']});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { serverOutput = (serverOutput + data.toString()).slice(-12000); });
  await waitFor('server startup', () => serverOutput.includes('QemuWeb is ready.'), 30000);
  for (let index = 0; index < profiles.length; index++) {
    const profile = profiles[index];
    const id = ids[index];
    const marker = `GTS16_${profile.replaceAll('-', '_')}_RESOURCE`;
    const media = {script: `#!/bin/sh\necho GTS16_${profile.replaceAll('-', '_')}_SCRIPT\ncat config/value.txt\n`, resources: [{path: 'config/value.txt', contentBase64: Buffer.from(`${marker}\n`).toString('base64')}]};
    await request('/api/hosts', 'POST', {id, name: `GTS16 ${profile}`, imageId: profile, engine, interfaces: [], guestMedia: media});
    const socket = io(baseUrl, {reconnection: false, timeout: 10000});
    let serial = '';
    let logs = [];
    socket.on('connect', () => socket.emit('select-session', id, id));
    socket.on('session-snapshot', value => { if (value.sessionId === id) { serial += value.serial || ''; logs = value.logs || []; } });
    socket.on('serial', value => { if (value.sessionId === id) serial += value.data || ''; });
    socket.on('log', value => { if (value.sessionId === id) logs.push(value.line); });
    try {
      await waitFor(`${profile} socket`, () => socket.connected);
      await request('/api/start', 'POST', {sessionId: id, engine, imageId: profile, interfaces: [], settings: {memory: profile === 'openwrt' ? 256 : 1024, cpus: 1, clock: 'utc'}});
      try { await waitFor(`${profile} guest hook`, () => serial.includes('QEMUWEB_START_EXIT 0') || serial.includes('QEMUWEB_START_ERROR'), 90000); }
      catch (error) { throw new Error(`${error.message}\nRecent serial:\n${serial.slice(-4000)}`); }
      assert.match(serial, /QEMUWEB_START_EXIT 0/, `${profile} guest hook failed: ${serial.slice(-2500)}`);
      assert.ok(serial.includes(marker), `${profile} companion resource not printed: ${serial.slice(-2500)}`);
      await waitFor(`${profile} Host Log`, () => logs.some(line => line.includes('QEMUWEB_START_EXIT 0')) && logs.some(line => line.includes(marker)));
      console.log(`${profile}: ISO mounted, start.sh and companion file ran, exit 0 visible in console and Host Log`);
    } finally { socket.disconnect(); }
    await request(`/api/sessions/${id}`, 'DELETE');
  }
  if (profiles.includes('openwrt') && engine === 'qemu') {
    const id = `gts16-missing-${process.pid}`;
    ids.push(id);
    await request('/api/hosts', 'POST', {id, name: 'GTS16 missing script', imageId: 'openwrt', engine: 'qemu', interfaces: [], guestMedia: {script: '', resources: []}});
    const socket = io(baseUrl, {reconnection: false, timeout: 10000});
    let serial = '';
    let logs = [];
    socket.on('connect', () => socket.emit('select-session', id, id));
    socket.on('session-snapshot', value => { if (value.sessionId === id) { serial += value.serial || ''; logs = value.logs || []; } });
    socket.on('serial', value => { if (value.sessionId === id) serial += value.data || ''; });
    socket.on('log', value => { if (value.sessionId === id) logs.push(value.line); });
    try {
      await waitFor('missing-script socket', () => socket.connected);
      await request('/api/start', 'POST', {sessionId: id, engine: 'qemu', imageId: 'openwrt', interfaces: [], settings: {memory: 256, cpus: 1, clock: 'utc'}});
      await waitFor('missing-script report', () => serial.includes('QEMUWEB_START_ERROR /mnt/cdrom/start.sh missing'), 90000);
      assert.ok(serial.includes('Please press Enter to activate this console.'), 'OpenWrt boot did not reach its console.');
      await waitFor('missing-script Host Log', () => logs.some(line => line.includes('QEMUWEB_START_ERROR /mnt/cdrom/start.sh missing')));
      console.log('openwrt: missing start.sh reported promptly in console and Host Log; boot reached console');
    } finally { socket.disconnect(); }
    await request(`/api/sessions/${id}`, 'DELETE');
  }
}

async function cleanup() {
  if (baseUrl && child?.exitCode === null) {
    for (const id of ids) { try { await request(`/api/sessions/${id}`, 'DELETE'); } catch (_) {} }
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(cleanup);
