'use strict';

// Boot prepared OS bases with isolated guest media.
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

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
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
    await request(`/api/hosts/${id}/guest-cdrom`, 'POST', media);
    await request(`/api/hosts/${id}/guest-cdrom`, 'PATCH', {attached: true});
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
      if (profile.startsWith('debian')) {
        await waitFor(`${profile} login`, () => /login:\s*$/.test(serial), 90000);
        socket.emit('input', 'root\r');
        await waitFor(`${profile} root shell`, () => /root@[^\r\n]*#\s*$/.test(serial), 15000);
        const journalCheck = `for attempt in $(seq 1 60); do journalctl -b -u qemuweb-guest-start.service --no-pager -o cat | grep -Fq 'QEMUWEB_START_EXIT 0' && break; sleep 1; done
journalctl -b -u qemuweb-guest-start.service --no-pager -o cat | grep -Fq 'QEMUWEB_START_EXIT 0' &&
journalctl -b -u qemuweb-guest-start.service --no-pager -o cat | grep -Fq '${marker}' &&
journalctl -b -u qemuweb-guest-start.service --no-pager -o cat | grep -Fq 'QEMUWEB_START_BEGIN'
printf 'GTS16_JOURNAL_CHECK_%s\\n' "$?"`;
        const encoded = Buffer.from(journalCheck).toString('base64');
        socket.emit('input', `printf '%s' '${encoded}' | base64 -d | /bin/sh\r`);
        await waitFor(`${profile} journal check`, () => /GTS16_JOURNAL_CHECK_\d+/.test(serial), 90000);
        assert.match(serial, /GTS16_JOURNAL_CHECK_0/, `${profile} journal lacks script output or exit 0: ${serial.slice(-2500)}`);
        assert.doesNotMatch(serial, /qemuweb-guest-start\[\d+\]: QEMUWEB_START_/);
        assert.ok(!logs.some(line => line.includes('QEMUWEB_START_')), `${profile} Host Log contains guest hook output.`);
        assert.match(stripAnsi(serial), /Finished .*QemuWeb guest startup media/,
          `${profile} normal systemd completion status is missing from serial: ${stripAnsi(serial).split('\n').filter(line => /Finished|QemuWeb|qemuweb-guest/.test(line)).slice(-15).join(' | ')}`);
        console.log(`${profile}: ISO script and resource verified in journalctl, exit 0; no guest hook syslog in serial or Host Log`);
      } else {
        try { await waitFor(`${profile} guest hook`, () => serial.includes(marker) || serial.includes('QEMUWEB_START_ERROR'), 90000); }
        catch (error) { throw new Error(`${error.message}\nRecent serial:\n${serial.slice(-4000)}`); }
        assert.ok(serial.includes(`GTS16_${profile.replaceAll('-', '_')}_SCRIPT`), `${profile} start.sh output not printed: ${serial.slice(-2500)}`);
        assert.ok(serial.includes(marker), `${profile} companion resource not printed: ${serial.slice(-2500)}`);
        assert.doesNotMatch(serial, /QEMUWEB_START_(?:BEGIN|EXIT)/, `${profile} boot console contains guest hook markers.`);
        assert.ok(!logs.some(line => line.startsWith('[guest]')), `${profile} Host Log contains guest serial output.`);
        console.log(`${profile}: ISO mounted; start.sh and companion file output verified without guest hook markers in console or Host Log`);
      }
    } finally { socket.disconnect(); }
    await request(`/api/sessions/${id}`, 'DELETE');
  }
  if (profiles.includes('openwrt') && engine === 'qemu') {
    const id = `gts16-missing-${process.pid}`;
    ids.push(id);
    await request('/api/hosts', 'POST', {id, name: 'GTS16 missing script', imageId: 'openwrt', engine: 'qemu', interfaces: [], guestMedia: {script: '', resources: []}});
    await request(`/api/hosts/${id}/guest-cdrom`, 'POST', {script: '', resources: []});
    await request(`/api/hosts/${id}/guest-cdrom`, 'PATCH', {attached: true});
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
      assert.ok(!logs.some(line => line.startsWith('[guest]')), 'Host Log contains guest serial output.');
      console.log('openwrt: missing start.sh reported promptly in console; boot reached console');
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
