'use strict';

// Diagnostic of the four rebuilt guest images on an isolated VDE LAN.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const io = require('socket.io-client');

const root = path.resolve(__dirname, '../..');
const supported = ['debian13-legacy', 'debian13-cloud', 'alpine', 'openwrt'];
const profiles = (process.env.GUEST_NETWORK_PROFILES || supported.join(',')).split(',').map(s => s.trim()).filter(Boolean);
const engine = process.env.GUEST_NETWORK_ENGINE || 'qemu';
const timeout = Number(process.env.GUEST_NETWORK_TIMEOUT_MS || 120000);
const addresses = ['192.0.2.101', '192.0.2.102'];
const newId = prefix => `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
const switchId = newId('s');
const created = [];
const results = [];
let child;
let baseUrl;
let serverOutput = '';

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

async function waitFor(label, predicate, limit = timeout) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    if (child && child.exitCode !== null) throw new Error(`QemuWeb exited while waiting for ${label}: ${serverOutput.slice(-2500)}`);
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function request(route, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method, headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${route}: ${data.error || response.status}`);
  return data;
}

class GuestConsole {
  constructor(id, label) {
    this.id = id;
    this.label = label;
    this.output = '';
    this.selected = false;
    this.socket = io(baseUrl, {reconnection: false, timeout: 10000});
    this.socket.on('connect', () => this.socket.emit('select-session', id, id, reply => {
      if (reply?.error) this.error = reply.error;
      else this.selected = true;
    }));
    this.socket.on('session-snapshot', value => {
      if (value.sessionId === id) this.output += value.serial || '';
    });
    this.socket.on('serial', value => {
      if (value.sessionId === id) this.output += value.data || '';
    });
    this.socket.on('serial-reset', value => {
      if (value.sessionId === id) this.output = value.serial || '';
    });
    this.socket.on('connect_error', error => { this.error = error.message; });
  }

  send(value) {
    if (!this.selected) throw new Error(`${this.label}: serial console not selected: ${this.error || 'unknown error'}`);
    this.socket.emit('input', value);
  }

  async loginRoot() {
    await waitFor(`${this.label} serial selection`, () => this.selected || this.error);
    if (this.error) throw new Error(`${this.label}: ${this.error}`);
    const loginStart = this.output.length;
    let loginSent = false;
    let lastNudge = 0;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const tail = stripAnsi(this.output).slice(-800);
      if (/Password:\s*$/i.test(tail) || /Password:/i.test(stripAnsi(this.output.slice(loginStart)))) {
        throw new Error(`${this.label}: root login asked for a password.`);
      }
      if (/(?:^|\n)[^\n]*#\s*$/.test(tail)) {
        const identity = await this.exec('id -u');
        assert.equal(identity.status, 0, `${this.label}: id -u failed: ${identity.output}`);
        assert.match(identity.output, /(?:^|\n)0\s*$/m, `${this.label}: shell is not root.`);
        return;
      }
      if (/login:\s*$/i.test(tail) && !loginSent) {
        this.send('root\r');
        loginSent = true;
      } else if (/login incorrect/i.test(tail)) loginSent = false;
      if (Date.now() - lastNudge > 2500) {
        this.send('\r');
        lastNudge = Date.now();
      }
      await delay(200);
    }
    throw new Error(`${this.label}: no passwordless root shell. Recent serial:\n${stripAnsi(this.output).slice(-2000)}`);
  }

  async exec(command) {
    assert.ok(!/[\r\n]/.test(command), 'Guest command must fit on one serial line.');
    const token = crypto.randomBytes(5).toString('hex');
    const begin = `__GN_BEGIN_${token}__`;
    const end = `__GN_END_${token}_`;
    const line = `printf '\\n${begin}\\n'; (${command}); qweb_rc=$?; printf '\\n${end}%s__\\n' "$qweb_rc"`;
    assert.ok(line.length < 256, `${this.label}: command exceeds the serial line limit.`);
    const start = this.output.length;
    console.log(`[${this.label}] $ ${command}`);
    this.send(`${line}\r`);
    const value = await waitFor(`${this.label} command completion`, () => {
      const output = stripAnsi(this.output.slice(start));
      const from = output.indexOf(`\n${begin}\n`);
      if (from < 0) return null;
      const rest = output.slice(from + begin.length + 2);
      const match = rest.match(new RegExp(`(?:^|\\n)${end}(\\d+)__(?:\\n|$)`));
      return match ? {status: Number(match[1]), output: rest.slice(0, match.index).trim()} : null;
    });
    if (value.output) for (const line of value.output.split('\n')) console.log(`[${this.label}]   ${line}`);
    console.log(`[${this.label}]   exit ${value.status}`);
    return value;
  }

  close() { this.socket.disconnect(); }
}

async function check(profile, label, action) {
  try {
    await action();
    results.push({profile, label, ok: true});
    console.log(`[${profile}] OK ${label}`);
    return true;
  } catch (error) {
    results.push({profile, label, ok: false, detail: error.message});
    console.error(`[${profile}] FAIL ${label}: ${error.message}`);
    return false;
  }
}

async function success(shell, command, description = command) {
  const value = await shell.exec(command);
  assert.equal(value.status, 0, `${shell.label}: ${description}: ${value.output}`);
  return value.output;
}

async function runProfile(profile) {
  const hosts = [0, 1].map(index => ({
    id: newId('h'), name: `net-${profile}-${index + 1}`,
    label: `${profile} h${index + 1}`, address: addresses[index]
  }));
  const consoles = [];
  try {
    for (const host of hosts) {
      await request('/api/hosts', 'POST', {
        id: host.id, name: host.name, imageId: profile, engine, interfaces: [switchId],
        guestMedia: {script: '#!/bin/sh\nhostname @HOSTNAME@\n', resources: []},
        startupDiskEnabled: true
      });
      created.push(host.id);
      host.console = new GuestConsole(host.id, host.label);
      consoles.push(host.console);
    }
    await Promise.all(hosts.map(host => waitFor(`${host.label} socket`, () => host.console.selected || host.console.error)));
    await Promise.all(hosts.map(host => request('/api/start', 'POST', {
      sessionId: host.id, engine, imageId: profile, interfaces: [switchId]
    })));
    await check(profile, 'distinct VDE ports and MACs', async () => {
      const sessions = await request('/api/sessions');
      const nics = hosts.map(host => sessions.find(session => session.id === host.id)?.networkInterfaces?.[0]);
      assert.ok(nics.every(nic => nic?.switchId === switchId && nic.port && nic.mac), 'A host lacks its VDE connection.');
      assert.notEqual(nics[0].port, nics[1].port, 'The hosts share a VDE port.');
      assert.notEqual(nics[0].mac, nics[1].mac, 'The hosts share a MAC address.');
    });
    const logins = await Promise.all(hosts.map(host => check(profile, `${host.label} passwordless root login`, () => host.console.loginRoot())));
    if (!logins.every(Boolean)) return;

    for (const host of hosts) {
      const shell = host.console;
      await check(profile, `${host.label} eth0 exists`, async () => {
        const output = await success(shell, 'ip link show dev eth0');
        if (profile === 'openwrt') assert.doesNotMatch(output, /master br-lan/, 'eth0 is still enslaved to br-lan.');
      });
      if (profile === 'openwrt') await check(profile, `${host.label} direct eth0 LAN`, async () => {
        assert.equal((await success(shell, "uci -q get 'network.lan.device'")).trim(), 'eth0');
        const bridge = await shell.exec('ip link show dev br-lan 2>&1');
        assert.notEqual(bridge.status, 0, 'br-lan still exists.');
      });
      await check(profile, `${host.label} startup hostname`, async () => {
        const output = await success(shell, 'hostname');
        assert.equal(output.trim(), host.name);
      });
      await check(profile, `${host.label} hostname command`, async () => {
        const output = await success(shell, `hostname ${host.name} && hostname`);
        assert.equal(output.trim(), host.name);
      });
      if (profile === 'debian13-cloud') await shell.exec('hostname -f; cat /etc/hostname');
      if (profile === 'openwrt') await shell.exec("uci -q get 'system.@system[0].hostname'; ip -o -4 addr show");
      await check(profile, `${host.label} ping/tcpdump installed`, () => success(shell, 'command -v ping >/dev/null && command -v tcpdump >/dev/null'));
    }

    const addressDevice = 'eth0';
    const configured = await Promise.all(hosts.map(host => check(profile, `${host.label} static ${addressDevice} address`, () =>
      success(host.console, `ip link set eth0 up && ip link set ${addressDevice} up && ip addr flush dev ${addressDevice} && ip addr add ${host.address}/24 dev ${addressDevice}`))));
    if (!configured.every(Boolean)) return;
    for (const host of hosts) await host.console.exec('ip -o -4 addr show; ip -4 route show');

    const captureFile = '/tmp/qemuweb-guest-network-tcpdump.log';
    const capturePid = '/tmp/qemuweb-guest-network-tcpdump.pid';
    for (const host of hosts) await check(profile, `${host.label} tcpdump started`, () => success(host.console,
      `tcpdump -n -l -i eth0 icmp >${captureFile} 2>&1 </dev/null & echo $! >${capturePid}`));
    await delay(1000);
    await check(profile, 'ping h1 → h2', () => success(hosts[0].console, `ping -c 2 -W 2 ${addresses[1]}`));
    await check(profile, 'ping h2 → h1', () => success(hosts[1].console, `ping -c 2 -W 2 ${addresses[0]}`));
    for (const host of hosts) {
      await success(host.console, `kill $(cat ${capturePid}) 2>/dev/null || true`);
      await check(profile, `${host.label} tcpdump request/reply`, async () => {
        const output = await success(host.console, `cat ${captureFile}`);
        assert.match(output, /ICMP echo request/i, 'No ICMP request captured.');
        assert.match(output, /ICMP echo reply/i, 'No ICMP reply captured.');
      });
    }
  } finally {
    for (const shell of consoles) shell.close();
    for (const host of hosts) {
      if (!created.includes(host.id)) continue;
      try { await request(`/api/sessions/${host.id}`, 'DELETE'); } catch (error) { console.error(`Cleanup ${host.id}: ${error.message}`); }
      created.splice(created.indexOf(host.id), 1);
    }
  }
}

async function run() {
  assert.ok(profiles.length && profiles.every(profile => supported.includes(profile)),
    `GUEST_NETWORK_PROFILES must contain only: ${supported.join(', ')}.`);
  assert.equal(engine, 'qemu', 'Use QEMU/KVM for this VDE diagnostic.');
  fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
  for (const profile of profiles) {
    assert.ok(fs.existsSync(path.join(root, 'images', `${profile}.raw`)), `Missing images/${profile}.raw; prepare the image first.`);
  }
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: root, env: {...process.env, PORT: String(port), QEMUWEB_TEST_SERVER: '1'}, stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => {
    serverOutput = (serverOutput + value.toString()).slice(-15000);
  });
  await waitFor('QemuWeb server', () => serverOutput.includes('QemuWeb is ready.'), 30000);
  await request('/api/general-settings', 'PUT', {engine});
  await request('/api/switches', 'POST', {id: switchId, name: `guestnet-${process.pid}`, autostart: true});
  created.push(switchId);
  for (const profile of profiles) {
    console.log(`\n=== ${profile} (${engine === 'qemu' ? 'KVM' : 'TCG'}) ===`);
    try { await runProfile(profile); }
    catch (error) {
      results.push({profile, label: 'scenario', ok: false, detail: error.message});
      console.error(`[${profile}] FAIL scenario: ${error.stack || error.message}`);
    }
  }
  console.log('\nGuest network diagnostic:');
  for (const result of results) console.log(`${result.ok ? 'OK  ' : 'FAIL'} ${result.profile}: ${result.label}${result.detail ? ` — ${result.detail}` : ''}`);
  if (results.some(result => !result.ok)) process.exitCode = 1;
}

async function cleanup() {
  if (!child || child.exitCode !== null) return;
  for (const id of created.reverse()) {
    try { await request(`/api/sessions/${id}`, 'DELETE'); } catch (error) { console.error(`Cleanup ${id}: ${error.message}`); }
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(12000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })
  ]);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(cleanup);
