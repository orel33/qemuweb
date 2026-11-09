'use strict';

const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const io = require('socket.io-client');

const root = path.resolve(__dirname, '..');
const imagePath = path.join(root, 'images/debian13-legacy.raw');
const kvmAvailable = (() => {
  try {
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (_) { return false; }
})();
const engine = process.env.LAN2_ENGINE || (kvmAvailable ? 'qemu' : 'qemu-tcg');
const timeoutMs = Number(process.env.LAN2_TIMEOUT_MS || (engine === 'qemu-tcg' ? 300000 : 120000));
const addresses = ['192.0.2.101', '192.0.2.102'];
const verifyGuestMedia = process.env.LAN2_GTS16 === '1';
const nonce = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
const switchId = `lan2-sw-${nonce}`;
const hostIds = [`lan2-a-${nonce}`, `lan2-b-${nonce}`];
const serverOutput = [];
let child;
let baseUrl;
let switchCreated = false;
const consoles = [];

function rememberServerOutput(chunk) {
  serverOutput.push(chunk.toString());
  if (serverOutput.join('').length > 30000) serverOutput.splice(0, serverOutput.length - 1);
}

function serverTail() {
  return serverOutput.join('').slice(-12000);
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const {port} = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(description, predicate, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    if (child && child.exitCode !== null) throw new Error(`QemuWeb exited while waiting for ${description}.`);
    await delay(200);
  }
  throw new Error(`Timed out after ${timeout} ms waiting for ${description}.`);
}

async function request(route, {method = 'GET', body} = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${route} returned ${response.status}: ${payload.error || JSON.stringify(payload)}`);
  return payload;
}

async function waitForSession(id, predicate, description) {
  return waitFor(description, async () => {
    const sessions = await request('/api/sessions');
    const session = sessions.find(candidate => candidate.id === id);
    return session && predicate(session) ? session : null;
  });
}

function stripAnsi(value) {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r/g, '\n');
}

function printCommand(label, command) {
  const lines = command.split('\n');
  console.log(`[${label}] $ ${lines[0]}`);
  for (const line of lines.slice(1)) console.log(`[${label}]   ${line}`);
}

class SerialShell {
  constructor(id, label) {
    this.id = id;
    this.label = label;
    this.output = '';
    this.logs = [];
    this.resetCount = 0;
    this.connected = false;
    this.selected = false;
    this.socket = io(baseUrl, {reconnection: false, timeout: 10000});
    this.socket.on('connect', () => {
      this.connected = true;
      this.socket.emit('select-session', id, `lan2-${nonce}`, response => {
        if (response && response.error) this.selectionError = response.error;
        else this.selected = true;
      });
    });
    this.socket.on('session-snapshot', snapshot => {
      if (snapshot.sessionId === id) {
        this.logs = snapshot.logs || [];
        this.append(snapshot.serial || '');
      }
    });
    this.socket.on('log', packet => { if (packet.sessionId === id) this.logs.push(packet.line); });
    this.socket.on('serial', packet => {
      if (packet.sessionId === id) this.append(packet.data || '');
    });
    this.socket.on('serial-reset', packet => {
      if (!packet || packet.sessionId === id) { this.output = ''; this.resetCount++; }
    });
    this.socket.on('connect_error', error => { this.connectionError = error.message; });
    this.socket.on('session-error', error => { this.selectionError = String(error); });
  }

  append(value) {
    this.output = (this.output + value).slice(-100000);
    this.flushLiveOutput();
  }

  flushLiveOutput(final = false) {
    const active = this.activeCommand;
    if (!active) return;
    const text = this.output.slice(active.start);
    const startAt = text.indexOf(active.begin);
    if (startAt < 0) return;
    const outputStart = startAt + active.begin.length;
    const markerAt = text.indexOf(active.marker, outputStart);
    let available = text.slice(outputStart, markerAt < 0 ? undefined : markerAt);
    if (markerAt < 0 && !final) {
      let suffix = Math.min(available.length, active.marker.length - 1);
      while (suffix > 0 && !active.marker.startsWith(available.slice(-suffix))) suffix--;
      if (suffix) available = available.slice(0, -suffix);
    }
    if (available.length > active.streamed) {
      active.pending += available.slice(active.streamed);
      active.streamed = available.length;
    }
    const lines = active.pending.split(/[\r\n]+/);
    active.pending = final ? '' : lines.pop();
    for (const line of lines) {
      const clean = stripAnsi(line);
      if (clean) console.log(`[${this.label}] ${clean}`);
    }
    if (final && active.pending) console.log(`[${this.label}] ${stripAnsi(active.pending)}`);
  }

  send(value) {
    if (!this.connected || !this.selected) throw new Error(`${this.label}: serial console is not connected.`);
    this.socket.emit('input', value);
  }

  async waitForShell() {
    await waitFor(`${this.label} serial connection`, () => this.selected || this.selectionError || this.connectionError);
    if (this.selectionError || this.connectionError) throw new Error(`${this.label}: ${this.selectionError || this.connectionError}`);

    let loginSent = false;
    let passwordSent = false;
    let lastNudge = 0;
    const prompt = /(?:^|\n)(?:root@[^\s#]*:[^\n#]*#|#)\s*$/m;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const terminal = stripAnsi(this.output);
      if (prompt.test(terminal)) {
        const result = await this.exec('id -u');
        assert.match(result.output, /(?:^|\n)0(?:\n|$)/, `${this.label} console did not log in as root.`);
        console.log(`  ${this.label}: console root prête`);
        return;
      }
      if (/login:\s*$/im.test(terminal) && !loginSent) {
        this.send('root\r');
        loginSent = true;
      } else if (/password:\s*$/im.test(terminal) && !passwordSent) {
        this.send('\r');
        passwordSent = true;
      } else if (/login incorrect/i.test(terminal)) {
        loginSent = false;
        passwordSent = false;
      }
      if (Date.now() - lastNudge > 2500) {
        this.send('\r');
        lastNudge = Date.now();
      }
      await delay(200);
    }
    throw new Error(`No root shell appeared on ${this.label} within ${timeoutMs} ms. Recent console output:\n${stripAnsi(this.output).slice(-2500)}`);
  }

  async exec(command) {
    const token = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const begin = `__LAN2_BEGIN_${token}__`;
    const marker = `__LAN2_END_${token}_`;
    const script = `printf '\\n${begin}\\n'\n(${command})\nrc=$?\nprintf '\\n${marker}%s__\\n' "$rc"\n`;
    const encoded = Buffer.from(script).toString('base64');
    const start = this.output.length;
    this.activeCommand = {start, begin, marker, streamed: 0, pending: ''};
    printCommand(this.label, command);
    this.send(`printf '%s' '${encoded}' | base64 -d | /bin/sh\r`);
    let match;
    try {
      match = await waitFor(`${this.label} command completion`, () => {
        const text = this.output.slice(start);
        const found = text.match(new RegExp(`${marker}(\\d+)__`));
        return found ? {text, status: Number(found[1]), index: found.index} : null;
      });
    } catch (error) {
      this.flushLiveOutput(true);
      this.activeCommand = null;
      throw new Error(`${error.message}\nRecent ${this.label} console output:\n${stripAnsi(this.output).slice(-2500)}`);
    }
    this.flushLiveOutput(true);
    this.activeCommand = null;
    const startAt = match.text.indexOf(begin);
    const output = stripAnsi(match.text.slice(startAt + begin.length, match.index));
    assert.equal(match.status, 0, `${this.label} command failed (${match.status}): ${command}\n${output.slice(-2000)}`);
    return {output};
  }

  async close() {
    if (this.socket) this.socket.disconnect();
  }
}

async function setStaticAddress(shell, address) {
  const result = await shell.exec([
    'ip link show eth0 >/dev/null',
    'ip link set eth0 up',
    'ip addr flush dev eth0',
    `ip addr add ${address}/24 dev eth0`,
    `printf '%s\\n' '${address}' > /root/.lan2-address-marker`,
    'ip -o -4 addr show dev eth0'
  ].join('\n'));
  assert.match(result.output, new RegExp(`inet ${address.replaceAll('.', '\\.')}\\/24`), `${shell.label} did not receive ${address}/24 on eth0.`);
}

async function ping(shell, address) {
  const {output} = await shell.exec(`ping -n -c 3 -W 2 ${address}`);
  assert.match(output, /3 packets transmitted, 3 received|3 packets transmitted, 3 packets received/, `${shell.label} could not ping ${address}:\n${output}`);
}

async function installGuestHook(shell) {
  const files = [
    ['guest-start.sh', '/usr/local/sbin/qemuweb-guest-start', '755'],
    ['qemuweb-guest-start.service', '/etc/systemd/system/qemuweb-guest-start.service', '644']
  ];
  for (const [name, destination, mode] of files) {
    const encoded = fs.readFileSync(path.join(root, 'scripts/prepare', name)).toString('base64');
    const temporary = `/tmp/${name}.b64`;
    await shell.exec(`: > ${temporary}`);
    for (let offset = 0; offset < encoded.length; offset += 400) {
      await shell.exec(`printf '%s' '${encoded.slice(offset, offset + 400)}' >> ${temporary}`);
    }
    await shell.exec(`base64 -d ${temporary} > ${destination} && chmod ${mode} ${destination} && rm ${temporary}`);
  }
  await shell.exec('systemctl daemon-reload && systemctl enable qemuweb-guest-start.service');
}

function mediaFor(index, version = 1) {
  const name = `gts16-h${index + 1}-v${version}`;
  return {
    script: `#!/bin/sh\nhostname ${name}\nip link set eth0 up\nip addr flush dev eth0\nip addr add ${addresses[index]}/24 dev eth0\necho ${name} > /root/.gts16-disk-marker\ncat config/message.txt\n`,
    resources: [{path: 'config/message.txt', contentBase64: Buffer.from(`resource-${name}\n`).toString('base64')}]
  };
}

async function verifyGuestBoot(shell, index, version) {
  const name = `gts16-h${index + 1}-v${version}`;
  assert.doesNotMatch(shell.output, /qemuweb-guest-start\[\d+\]: QEMUWEB_START_/,
    `${shell.label} boot console contains guest hook syslog lines.`);
  assert.ok(!shell.logs.some(line => line.includes('QEMUWEB_START_')),
    `${shell.label} Host Log contains Debian guest hook output.`);
  await shell.exec(`for attempt in $(seq 1 60); do journalctl -b -u qemuweb-guest-start.service --no-pager -o cat | grep -Fq 'QEMUWEB_START_EXIT 0' && break; sleep 1; done
journalctl -b -u qemuweb-guest-start.service --no-pager -o cat | grep -Fq 'QEMUWEB_START_EXIT 0' &&
journalctl -b -u qemuweb-guest-start.service --no-pager -o cat | grep -Fq 'resource-${name}' &&
journalctl -b -u qemuweb-guest-start.service --no-pager -o cat | grep -Fq 'QEMUWEB_START_BEGIN'`);
  await shell.exec(`test "$(hostname)" = "${name}" && test "$(cat /root/.gts16-disk-marker)" = "${name}" && ip -o -4 addr show eth0 | grep -q '${addresses[index]}/24'`);
  assert.ok(!shell.logs.some(line => line.includes('QEMUWEB_START_')),
    `${shell.label} Host Log gained Debian guest hook output after journal query.`);
}

async function startHost(id) {
  await request('/api/start', {method: 'POST', body: {
    sessionId: id,
    engine,
    imageId: 'debian13-legacy',
    interfaces: [switchId],
    settings: {memory: 1024, cpus: 1, clock: 'utc'}
  }});
}

async function run() {
  assert.ok(fs.existsSync(imagePath), `Missing ${imagePath}; run bash prepare.sh first.`);
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {...process.env, PORT: String(port)},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', rememberServerOutput);
  child.stderr.on('data', rememberServerOutput);

  await waitFor('QemuWeb API startup', async () => {
    try { return (await request('/api/systems')).some(system => system.id === 'debian13-legacy'); }
    catch (_) { return false; }
  }, 30000);
  console.log('LAN2: QemuWeb démarré');
  console.log(`LAN2: moteur ${engine === 'qemu' ? 'QEMU/KVM' : 'QEMU/TCG'}`);

  const switchName = `lan2sw${nonce.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}`;
  const sw = await request('/api/switches', {method: 'POST', body: {id: switchId, name: switchName, autostart: true}});
  switchCreated = true;
  assert.equal(sw.running, true, 'VDE switch did not start.');
  console.log('LAN2: switch VDE démarré');

  for (let index = 0; index < hostIds.length; index++) {
    const id = hostIds[index];
    await request('/api/hosts', {method: 'POST', body: {
      id,
      name: `LAN2 Debian ${index + 1} ${nonce}`,
      imageId: 'debian13-legacy',
      engine,
      interfaces: [switchId],
      settings: {memory: 1024, cpus: 1, clock: 'utc'}
    }});
    consoles.push(new SerialShell(id, `h${index + 1}`));
  }

  await Promise.all(hostIds.map(startHost));
  await Promise.all(hostIds.map(id => waitForSession(id, session => session.running && session.hasDifferentialDisk, `${id} boot`)));
  const beforeResume = await Promise.all(hostIds.map(id => waitForSession(id, session => session.networkInterfaces?.[0]?.port, `${id} VDE port`)));
  const firstNic = beforeResume[0].networkInterfaces[0];
  const secondNic = beforeResume[1].networkInterfaces[0];
  assert.equal(firstNic.switchId, switchId);
  assert.equal(secondNic.switchId, switchId);
  assert.notEqual(firstNic.port, secondNic.port, 'Hosts were assigned the same VDE port.');
  assert.notEqual(firstNic.mac, secondNic.mac, 'Hosts were assigned the same MAC address.');
  console.log(`LAN2: ports distincts (${firstNic.port}, ${secondNic.port}), MAC distinctes`);

  await Promise.all(consoles.map(shell => shell.waitForShell()));
  await Promise.all(consoles.map((shell, index) => setStaticAddress(shell, addresses[index])));
  await ping(consoles[0], addresses[1]);
  await ping(consoles[1], addresses[0]);
  console.log('LAN2: ping bidirectionnel validé');

  if (verifyGuestMedia) {
    for (let index = 0; index < hostIds.length; index++) {
      await installGuestHook(consoles[index]);
      await request(`/api/hosts/${hostIds[index]}/guest-media`, {method: 'PUT', body: mediaFor(index)});
      await request(`/api/hosts/${hostIds[index]}/guest-cdrom`, {method: 'POST', body: mediaFor(index)});
      await request(`/api/hosts/${hostIds[index]}/guest-cdrom`, {method: 'PATCH', body: {attached: true}});
    }
    console.log('GTS16: hooks installés dans les overlays, médias propres aux hôtes enregistrés');
  }

  for (const id of hostIds) await request(`/api/stop/${id}`, {method: 'POST'});
  for (const id of hostIds) {
    const stopped = await waitForSession(id, session => !session.running && session.hasDifferentialDisk, `${id} stop`);
    assert.ok(stopped.hasDifferentialDisk, `${id} differential disk was lost after Stop.`);
  }
  console.log('LAN2: les deux hôtes sont arrêtés, disques conservés');

  await Promise.all(hostIds.map(startHost));
  await Promise.all(hostIds.map(id => waitForSession(id, session => session.running, `${id} resume`)));
  await Promise.all(consoles.map(shell => shell.waitForShell()));
  const afterResume = await Promise.all(hostIds.map(id => waitForSession(id, session => session.running, `${id} resumed state`)));
  for (let index = 0; index < hostIds.length; index++) {
    const nic = afterResume[index].networkInterfaces[0];
    assert.equal(nic.port, beforeResume[index].networkInterfaces[0].port, `${hostIds[index]} VDE port changed on Resume.`);
    assert.equal(nic.mac, beforeResume[index].networkInterfaces[0].mac, `${hostIds[index]} MAC changed on Resume.`);
    await consoles[index].exec(`test "$(cat /root/.lan2-address-marker)" = "${addresses[index]}"`);
    if (verifyGuestMedia) await verifyGuestBoot(consoles[index], index, 1);
  }
  console.log('LAN2: reprise confirmée, port/MAC et disque conservés');

  if (!verifyGuestMedia) await Promise.all(consoles.map((shell, index) => setStaticAddress(shell, addresses[index])));
  await ping(consoles[0], addresses[1]);
  await ping(consoles[1], addresses[0]);
  console.log('LAN2: IP statiques reconfigurées, ping bidirectionnel validé après reprise');
  if (verifyGuestMedia) {
    await request(`/api/hosts/${hostIds[0]}/guest-media`, {method: 'PUT', body: mediaFor(0, 2)});
    await request(`/api/hosts/${hostIds[0]}/guest-cdrom`, {method: 'POST', body: mediaFor(0, 2)});
    const resetBeforeReboot = consoles[0].resetCount;
    await request(`/api/reboot/${hostIds[0]}`, {method: 'POST'});
    await waitFor('h1 reboot serial reset', () => consoles[0].resetCount > resetBeforeReboot);
    await waitFor('h1 fresh login prompt', () => /login:\s*$/m.test(stripAnsi(consoles[0].output)));
    await consoles[0].waitForShell();
    await verifyGuestBoot(consoles[0], 0, 2);
    await ping(consoles[0], addresses[1]);
    console.log('GTS16: script édité après Reboot, ressource lue, IP/hostname et disque vérifiés');
  }
}

async function cleanup() {
  await Promise.all(consoles.map(shell => shell.close().catch(() => {})));
  if (baseUrl && child && child.exitCode === null) {
    for (const id of hostIds) {
      try { await request(`/api/sessions/${id}`, {method: 'DELETE'}); } catch (_) {}
    }
    if (switchCreated) {
      try { await request(`/api/sessions/${switchId}`, {method: 'DELETE'}); } catch (_) {}
    }
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      delay(12000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })
    ]);
  }
}

run().catch(error => {
  console.error(`\nLAN2 FAILED: ${error.stack || error.message}`);
  if (serverOutput.length) console.error(`\n--- QemuWeb output ---\n${serverTail()}`);
  process.exitCode = 1;
}).finally(cleanup);
