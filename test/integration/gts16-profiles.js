'use strict';

// Boot prepared OS bases with isolated guest media.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const io = require('socket.io-client');

const root = path.resolve(__dirname, '../..');
const profiles = process.env.GTS16_PROFILES ? process.env.GTS16_PROFILES.split(',') : ['alpine', 'debian13-cloud', 'openwrt'];
const engine = process.env.GTS16_ENGINE || 'qemu';
const newHostId = () => `h-${crypto.randomBytes(8).toString('hex')}`;
const ids = profiles.map(() => newHostId());
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

function mediaFor(profile, version, host = profile) {
  const prefix = `GTS16_${host.replaceAll('-', '_')}`;
  const scriptMarker = `${prefix}_V${version}_SCRIPT`;
  const resourceMarker = `${prefix}_V${version}_RESOURCE`;
  const diskMarker = `${prefix}_DISK`;
  const diskStep = version === 1
    ? `printf '%s\\n' '${diskMarker}' > /root/.gts16-profile-marker\ncat /root/.gts16-profile-marker`
    : 'cat /root/.gts16-profile-marker';
  return {
    scriptMarker, resourceMarker, diskMarker,
    files: {
      script: `#!/bin/sh\necho ${scriptMarker}\ncat config/value.txt\n${diskStep}\n`,
      resources: [{path: 'config/value.txt', contentBase64: Buffer.from(`${resourceMarker}\n`).toString('base64')}]
    }
  };
}

function watchSession(id) {
  const state = {serial: '', logs: [], resetCount: 0};
  const socket = io(baseUrl, {reconnection: false, timeout: 10000});
  state.socket = socket;
  socket.on('connect', () => socket.emit('select-session', id, id));
  socket.on('session-snapshot', value => {
    if (value.sessionId === id) {
      state.serial += value.serial || '';
      state.logs = value.logs || [];
    }
  });
  socket.on('serial', value => { if (value.sessionId === id) state.serial += value.data || ''; });
  socket.on('serial-reset', value => {
    if (value.sessionId === id) { state.serial = value.serial || ''; state.resetCount++; }
  });
  socket.on('log', value => { if (value.sessionId === id) state.logs.push(value.line); });
  return state;
}

async function verifyBoot(profile, state, media) {
  const {socket} = state;
  if (profile.startsWith('debian')) {
    await waitFor(`${profile} login`, () => /login:\s*$/.test(state.serial), 90000);
    socket.emit('input', 'root\r');
    await waitFor(`${profile} root shell`, () => /root@[^\r\n]*#\s*$/.test(state.serial), 15000);
    const journalCheck = `for attempt in $(seq 1 60); do journalctl -b -u qemuweb-start.service --no-pager -o cat | grep -Fq 'QEMUWEB_START_EXIT 0' && break; sleep 1; done
journalctl -b -u qemuweb-start.service --no-pager -o cat | grep -Fq 'QEMUWEB_START_EXIT 0' &&
journalctl -b -u qemuweb-start.service --no-pager -o cat | grep -Fq '${media.scriptMarker}' &&
journalctl -b -u qemuweb-start.service --no-pager -o cat | grep -Fq '${media.resourceMarker}' &&
journalctl -b -u qemuweb-start.service --no-pager -o cat | grep -Fq '${media.diskMarker}' &&
journalctl -b -u qemuweb-start.service --no-pager -o cat | grep -Fq 'QEMUWEB_START_BEGIN'
printf 'GTS16_JOURNAL_CHECK_%s\\n' "$?"`;
    const encoded = Buffer.from(journalCheck).toString('base64');
    socket.emit('input', `printf '%s' '${encoded}' | base64 -d | /bin/sh\r`);
    await waitFor(`${profile} journal check`, () => /GTS16_JOURNAL_CHECK_\d+/.test(state.serial), 90000);
    assert.match(state.serial, /GTS16_JOURNAL_CHECK_0/, `${profile} journal lacks script/resource/disk output or exit 0: ${state.serial.slice(-2500)}`);
    assert.doesNotMatch(state.serial, /qemuweb-guest-start\[\d+\]: QEMUWEB_START_/);
    assert.ok(!state.logs.some(line => line.includes('QEMUWEB_START_')), `${profile} Host Log contains guest hook output.`);
    assert.match(stripAnsi(state.serial), /Finished .*Run start\.sh/,
      `${profile} normal systemd completion status is missing from serial: ${stripAnsi(state.serial).split('\n').filter(line => /Finished|start\.sh|qemuweb-start/.test(line)).slice(-15).join(' | ')}`);
  } else {
    try {
      await waitFor(`${profile} guest hook`, () =>
        (state.serial.includes(media.scriptMarker) && state.serial.includes(media.resourceMarker) && state.serial.includes(media.diskMarker)) ||
        state.serial.includes('QEMUWEB_START_ERROR'), 90000);
    } catch (error) { throw new Error(`${error.message}\nRecent serial:\n${state.serial.slice(-4000)}`); }
    assert.ok(state.serial.includes(media.scriptMarker), `${profile} start.sh output not printed: ${state.serial.slice(-2500)}`);
    assert.ok(state.serial.includes(media.resourceMarker), `${profile} companion resource not printed: ${state.serial.slice(-2500)}`);
    assert.ok(state.serial.includes(media.diskMarker), `${profile} disk marker not printed: ${state.serial.slice(-2500)}`);
    assert.doesNotMatch(state.serial, /QEMUWEB_START_ERROR|QEMUWEB_START_(?:BEGIN|EXIT)/,
      `${profile} boot console contains guest hook error or technical markers.`);
    assert.ok(!state.logs.some(line => line.startsWith('[guest]')), `${profile} Host Log contains guest serial output.`);
  }
}

async function verifyConcurrentIsolation() {
  const hosts = [0, 1].map(index => ({
    id: newHostId(),
    media: mediaFor('openwrt', 1, `openwrt_isolated_${index}`)
  }));
  for (const host of hosts) {
    ids.push(host.id);
    await request('/api/hosts', 'POST', {id: host.id, name: `GTS16 isolated ${host.id}`, imageId: 'openwrt', engine, interfaces: [], guestMedia: host.media.files});
    await request(`/api/hosts/${host.id}/guest-cdrom`, 'POST', host.media.files);
    await request(`/api/hosts/${host.id}/guest-cdrom`, 'PATCH', {attached: true});
    host.state = watchSession(host.id);
  }
  try {
    await Promise.all(hosts.map(host => waitFor(`${host.id} socket`, () => host.state.socket.connected)));
    await Promise.all(hosts.map(host => request('/api/start', 'POST', {
      sessionId: host.id, engine, imageId: 'openwrt', interfaces: [], settings: {memory: 256, cpus: 1, clock: 'utc'}
    })));
    await Promise.all(hosts.map(host => verifyBoot('openwrt', host.state, host.media)));
    const sessions = await request('/api/sessions');
    assert.ok(hosts.every(host => sessions.some(session => session.id === host.id && session.running)),
      'Both isolated hosts must be running at the same time.');
    for (let index = 0; index < hosts.length; index++) {
      assert.ok(!hosts[index].state.serial.includes(hosts[1 - index].media.resourceMarker),
        `${hosts[index].id} printed the other host's resource.`);
      assert.ok(!hosts[index].state.serial.includes(hosts[1 - index].media.scriptMarker),
        `${hosts[index].id} printed the other host's script marker.`);
    }
    const paths = hosts.map(host => {
      const attached = host.state.logs.find(line => line.startsWith('# Guest setup ISO attached: '));
      assert.ok(attached, `${host.id} lacks an ISO attachment log.`);
      return attached.slice('# Guest setup ISO attached: '.length).replace(/ \(read-only\)$/, '');
    });
    assert.notEqual(paths[0], paths[1], 'The concurrent hosts used the same ISO path.');
    console.log('openwrt: two concurrent hosts used distinct ISOs, scripts, resources and disks');
  } finally {
    for (const host of hosts) host.state.socket.disconnect();
    for (const host of hosts) await request(`/api/sessions/${host.id}`, 'DELETE');
  }
}

async function run() {
  for (const profile of profiles) assert.ok(fs.existsSync(path.join(root, 'images', `${profile}.raw`)), `Missing prepared ${profile} RAW base`);
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {cwd: root, env: {...process.env, PORT: String(port)}, stdio: ['ignore', 'pipe', 'pipe']});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { serverOutput = (serverOutput + data.toString()).slice(-12000); });
  await waitFor('server startup', () => serverOutput.includes('QemuWeb is ready.'), 30000);
  await request('/api/general-settings', 'PUT', {engine});
  for (let index = 0; index < profiles.length; index++) {
    const profile = profiles[index];
    const id = ids[index];
    const first = mediaFor(profile, 1);
    const second = mediaFor(profile, 2);
    const startOptions = {sessionId: id, engine, imageId: profile, interfaces: [], settings: {memory: profile === 'openwrt' ? 256 : 1024, cpus: 1, clock: 'utc'}};
    await request('/api/hosts', 'POST', {id, name: `GTS16 ${profile}`, imageId: profile, engine, interfaces: [], guestMedia: first.files});
    await request(`/api/hosts/${id}/guest-cdrom`, 'POST', first.files);
    await request(`/api/hosts/${id}/guest-cdrom`, 'PATCH', {attached: true});
    const state = watchSession(id);
    try {
      await waitFor(`${profile} socket`, () => state.socket.connected);
      await request('/api/start', 'POST', startOptions);
      await verifyBoot(profile, state, first);
      console.log(`${profile}: initial ISO script, resource and disk marker verified`);
      if (engine.startsWith('qemu')) {
        await request(`/api/hosts/${id}/guest-media`, 'PUT', second.files);
        const beforeReboot = state.resetCount;
        await request(`/api/reboot/${id}`, 'POST');
        await waitFor(`${profile} reboot serial reset`, () => state.resetCount > beforeReboot);
        await verifyBoot(profile, state, second);
        assert.ok(!state.serial.includes(first.resourceMarker), `${profile} reboot retained the old resource.`);
        console.log(`${profile}: edited script and companion resource verified after Reboot`);

        await request(`/api/stop/${id}`, 'POST');
        const stopped = (await request('/api/sessions')).find(session => session.id === id);
        assert.ok(stopped && !stopped.running && stopped.hasDifferentialDisk, `${profile} Stop lost its differential disk.`);
        const beforeResume = state.resetCount;
        await request('/api/start', 'POST', startOptions);
        await waitFor(`${profile} resume serial reset`, () => state.resetCount > beforeResume);
        await verifyBoot(profile, state, second);
        console.log(`${profile}: Stop/Resume retained the disk marker and edited startup media`);
      }
    } finally { state.socket.disconnect(); }
    await request(`/api/sessions/${id}`, 'DELETE');
  }
  if (profiles.includes('openwrt') && engine.startsWith('qemu')) await verifyConcurrentIsolation();
  if (profiles.includes('openwrt') && engine === 'qemu') {
    const missingCases = [
      {suffix: 'script', script: '', attach: true, error: 'QEMUWEB_START_ERROR /mnt/cdrom/start.sh missing'},
      {suffix: 'media', script: '#!/bin/sh\n', attach: false, error: 'QEMUWEB_START_ERROR ISO label QWEBSTART missing'}
    ];
    for (const scenario of missingCases) {
      const id = newHostId();
      ids.push(id);
      await request('/api/hosts', 'POST', {id, name: `GTS16 missing ${scenario.suffix}`, imageId: 'openwrt', engine: 'qemu', interfaces: [], guestMedia: {script: scenario.script, resources: []}});
      if (scenario.attach) {
        await request(`/api/hosts/${id}/guest-cdrom`, 'POST', {script: scenario.script, resources: []});
        await request(`/api/hosts/${id}/guest-cdrom`, 'PATCH', {attached: true});
      }
      const socket = io(baseUrl, {reconnection: false, timeout: 10000});
      let serial = '';
      let logs = [];
      socket.on('connect', () => socket.emit('select-session', id, id));
      socket.on('session-snapshot', value => { if (value.sessionId === id) { serial += value.serial || ''; logs = value.logs || []; } });
      socket.on('serial', value => { if (value.sessionId === id) serial += value.data || ''; });
      socket.on('log', value => { if (value.sessionId === id) logs.push(value.line); });
      try {
        await waitFor(`${scenario.suffix} socket`, () => socket.connected);
        await request('/api/start', 'POST', {sessionId: id, engine: 'qemu', imageId: 'openwrt', interfaces: [], settings: {memory: 256, cpus: 1, clock: 'utc'}});
        await waitFor(`${scenario.suffix} report`, () => serial.includes(scenario.error), 90000);
        assert.ok(serial.includes('Please press Enter to activate this console.'), 'OpenWrt boot did not reach its console.');
        assert.ok(!logs.some(line => line.startsWith('[guest]')), 'Host Log contains guest serial output.');
        console.log(`openwrt: missing ${scenario.suffix} reported promptly in console; boot reached console`);
      } finally { socket.disconnect(); }
      await request(`/api/sessions/${id}`, 'DELETE');
    }
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
