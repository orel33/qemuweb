'use strict';

// Four Debian Legacy hosts configure their LAN from the startup template values.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const io = require('socket.io-client');

const root = path.resolve(__dirname, '../..');
const imagePath = path.join(root, 'images/debian13-legacy.raw');
const engine = process.env.LAN4_ENGINE || 'qemu';
const timeoutMs = Number(process.env.LAN4_TIMEOUT_MS || (engine === 'qemu-tcg' ? 300000 : 120000));
const newId = prefix => `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
const switchId = newId('s');
const hosts = Array.from({length: 4}, (_, index) => ({id: newId('h'), name: `lan4-h${index + 1}`, label: `h${index + 1}`}));
const expectedScript = '#!/bin/sh\nhostname @HOSTNAME@\nifconfig @IFNAME0@ 192.168.0.@SWPORT0@/24\n';
const serverOutput = [];
let child;
let baseUrl;
let switchCreated = false;

function tail() { return serverOutput.join('').slice(-12000); }

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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

async function waitFor(label, predicate, limit = timeoutMs) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    if (child && child.exitCode !== null) throw new Error(`QemuWeb exited while waiting for ${label}: ${tail()}`);
    await delay(200);
  }
  throw new Error(`Timed out after ${limit} ms waiting for ${label}.`);
}

async function request(route, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method, headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${route}: ${value.error || response.status}`);
  return value;
}

class GuestConsole {
  constructor(host) {
    this.host = host;
    this.output = '';
    this.selected = false;
    this.socket = io(baseUrl, {reconnection: false, timeout: 10000});
    this.socket.on('connect', () => this.socket.emit('select-session', host.id, host.id, reply => {
      if (reply?.error) this.error = reply.error;
      else this.selected = true;
    }));
    this.socket.on('session-snapshot', value => {
      if (value.sessionId === host.id) this.append(value.serial || '');
    });
    this.socket.on('serial', value => {
      if (value.sessionId === host.id) this.append(value.data || '');
    });
    this.socket.on('serial-reset', value => {
      if (value.sessionId === host.id) this.output = value.serial || '';
    });
    this.socket.on('connect_error', error => { this.error = error.message; });
  }

  append(value) { this.output = (this.output + value).slice(-100000); }

  send(value) {
    if (!this.selected) throw new Error(`${this.host.label}: serial console is not selected: ${this.error || 'unknown error'}`);
    this.socket.emit('input', value);
  }

  async loginRoot() {
    await waitFor(`${this.host.label} serial selection`, () => this.selected || this.error);
    if (this.error) throw new Error(`${this.host.label}: ${this.error}`);
    let loginSent = false;
    let lastNudge = 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const terminal = stripAnsi(this.output).slice(-1000);
      if (/(?:^|\n)[^\n]*#\s*$/.test(terminal)) {
        assert.equal((await this.success('id -u')).trim(), '0', `${this.host.label}: shell is not root.`);
        return;
      }
      if (/login:\s*$/i.test(terminal) && !loginSent) {
        this.send('root\r');
        loginSent = true;
      } else if (/login incorrect/i.test(terminal)) loginSent = false;
      if (/password:\s*$/i.test(terminal)) throw new Error(`${this.host.label}: root login asked for a password.`);
      if (Date.now() - lastNudge > 2500) {
        this.send('\r');
        lastNudge = Date.now();
      }
      await delay(200);
    }
    throw new Error(`${this.host.label}: no root shell. Recent serial:\n${stripAnsi(this.output).slice(-2500)}`);
  }

  async success(command) {
    assert.ok(!/[\r\n]/.test(command), 'Guest command must fit on one serial line.');
    const token = crypto.randomBytes(5).toString('hex');
    const begin = `__LAN4_BEGIN_${token}__`;
    const end = `__LAN4_END_${token}_`;
    const line = `printf '\\n${begin}\\n'; (${command}); qweb_rc=$?; printf '\\n${end}%s__\\n' "$qweb_rc"`;
    assert.ok(line.length < 256, `${this.host.label}: command exceeds the serial line limit.`);
    const start = this.output.length;
    console.log(`[${this.host.label}] $ ${command}`);
    this.send(`${line}\r`);
    let result;
    try {
      result = await waitFor(`${this.host.label} command completion`, () => {
        const output = stripAnsi(this.output.slice(start));
        const beginAt = output.indexOf(`\n${begin}\n`);
        if (beginAt < 0) return null;
        const rest = output.slice(beginAt + begin.length + 2);
        const match = rest.match(new RegExp(`(?:^|\\n)${end}(\\d+)__(?:\\n|$)`));
        return match ? {status: Number(match[1]), output: rest.slice(0, match.index).trim()} : null;
      });
    } catch (error) {
      throw new Error(`${error.message}\nRecent ${this.host.label} console:\n${stripAnsi(this.output).slice(-2500)}`);
    }
    if (result.output) for (const outputLine of result.output.split('\n')) console.log(`[${this.host.label}]   ${outputLine}`);
    console.log(`[${this.host.label}]   exit ${result.status}`);
    assert.equal(result.status, 0, `${this.host.label}: ${command} failed: ${result.output}`);
    return result.output;
  }

  close() { this.socket.disconnect(); }
}

async function run() {
  assert.ok(fs.existsSync(imagePath), `Missing ${imagePath}; run bash scripts/prepare.sh --system debian13-legacy first.`);
  assert.ok(['qemu', 'qemu-tcg'].includes(engine), `Unsupported LAN4_ENGINE: ${engine}`);
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: root, env: {...process.env, PORT: String(port), QEMUWEB_TEST_SERVER: '1'},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    serverOutput.push(chunk.toString());
    if (serverOutput.join('').length > 30000) serverOutput.splice(0, serverOutput.length - 1);
  });

  await waitFor('QemuWeb API', async () => {
    try { return (await request('/api/systems')).some(system => system.id === 'debian13-legacy'); }
    catch (_) { return false; }
  }, 30000);
  console.log(`LAN4: QemuWeb started with ${engine === 'qemu' ? 'KVM' : 'TCG'}`);
  await request('/api/general-settings', 'PUT', {engine});
  const sw = await request('/api/switches', 'POST', {id: switchId, name: 'lan4sw', autostart: true});
  switchCreated = true;
  assert.equal(sw.running, true, 'VDE switch did not start.');

  for (const host of hosts) {
    await request('/api/hosts', 'POST', {
      id: host.id, name: host.name, imageId: 'debian13-legacy', engine, interfaces: [switchId],
      autoBuildGuestCdrom: true
    });
    host.created = true;
    const config = await request(`/api/hosts/${host.id}/config`);
    assert.equal(config.guestMedia.script, expectedScript, `${host.label}: unexpected default start.sh`);
    assert.equal(config.autoBuildGuestCdrom, true, `${host.label}: automatic startup disk is disabled`);
    host.console = new GuestConsole(host);
  }
  await Promise.all(hosts.map(host => waitFor(`${host.label} console selection`, () => host.console.selected || host.console.error)));
  for (const host of hosts) if (host.console.error) throw new Error(`${host.label}: ${host.console.error}`);

  await Promise.all(hosts.map(host => request('/api/start', 'POST', {
    sessionId: host.id, engine, imageId: 'debian13-legacy', interfaces: [switchId]
  })));
  const sessions = await request('/api/sessions');
  const ports = new Set();
  const macs = new Set();
  for (const host of hosts) {
    const session = sessions.find(candidate => candidate.id === host.id);
    const nic = session?.networkInterfaces?.[0];
    assert.equal(session?.running, true, `${host.label}: host did not start`);
    assert.equal(nic?.switchId, switchId, `${host.label}: Ethernet 0 is not on the test switch`);
    assert.ok(Number.isInteger(nic.port) && nic.port > 0 && nic.port <= 32, `${host.label}: invalid VDE port`);
    assert.ok(nic.mac, `${host.label}: missing MAC address`);
    ports.add(nic.port);
    macs.add(nic.mac);
    host.address = `192.168.0.${nic.port}`;
  }
  assert.equal(ports.size, 4, 'VDE ports are not distinct.');
  assert.equal(macs.size, 4, 'MAC addresses are not distinct.');
  console.log(`LAN4: four distinct ports (${[...ports].join(', ')}) and MAC addresses`);

  await Promise.all(hosts.map(host => host.console.loginRoot()));
  for (const host of hosts) {
    const shell = host.console;
    await shell.success("journalctl -b -u qemuweb-start.service --no-pager -o cat | grep -Fq 'QEMUWEB_START_EXIT 0'");
    assert.equal((await shell.success('hostname')).trim(), host.name, `${host.label}: startup hostname was not applied`);
    const address = await shell.success("ip -o -4 addr show dev eth0 | awk '{print $4}'");
    assert.equal(address.trim(), `${host.address}/24`, `${host.label}: startup template did not configure Ethernet 0`);
  }
  console.log('LAN4: startup service, hostnames and template addresses verified');

  for (const source of hosts) {
    for (const target of hosts) {
      if (source === target) continue;
      const output = await source.console.success(`ping -n -c 2 -W 2 ${target.address}`);
      assert.match(output, /2 packets transmitted, 2 received|2 packets transmitted, 2 packets received/,
        `${source.label} could not ping ${target.label} at ${target.address}`);
    }
  }
  console.log('LAN4: all 12 directed ping paths verified');
}

async function cleanup() {
  for (const host of hosts) host.console?.close();
  if (!baseUrl || !child || child.exitCode !== null) return;
  for (const host of hosts) {
    if (!host.created) continue;
    try { await request(`/api/sessions/${host.id}`, 'DELETE'); } catch (_) {}
  }
  if (switchCreated) {
    try { await request(`/api/sessions/${switchId}`, 'DELETE'); } catch (_) {}
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(12000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })
  ]);
}

run().catch(error => {
  console.error(`\nLAN4 FAILED: ${error.stack || error.message}`);
  if (serverOutput.length) console.error(`\n--- QemuWeb output ---\n${tail()}`);
  process.exitCode = 1;
}).finally(cleanup);
