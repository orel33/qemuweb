'use strict';

// Loads demo/lan.zip the way the Web interface's Load session button does (public/archive.js:
// archive summary, base image check only when the archive has working disks, then
// POST /api/session-archive/import?autoStart=true&discardStaleDisks=false) and checks that the
// server's own start path brings up the switch and the four hosts. No ping, no guest login.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {createTestUsers, spawnServer, QemuWebClient} = require('./qemuweb-client');
const {readArchive} = require('../../lib/session-archive');

const root = path.resolve(__dirname, '../..');
const archiveFile = path.join(root, 'demo', 'lan.zip');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-check-load-start-'));
let child;
let client;
let testUsers;
let sessionId;
let serverOutput = '';
const sockets = [];
process.on('exit', () => {
  testUsers?.cleanup();
  fs.rmSync(workDir, {recursive: true, force: true});
});

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const {port} = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(label, condition, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    if (child?.exitCode !== null) throw new Error(`QemuWeb exited while waiting for ${label}.`);
    await delay(200);
  }
  throw new Error(`Timed out after ${timeout} ms waiting for ${label}.`);
}

// The archive's node set, read with the project's ZIP reader (as in check-load).
async function archiveView(file) {
  const stage = fs.mkdtempSync(path.join(workDir, 'stage-'));
  try {
    const paths = await readArchive(file, stage);
    const metadata = JSON.parse(fs.readFileSync(path.join(stage, 'session.json'), 'utf8'));
    const read = (id, name) => JSON.parse(fs.readFileSync(path.join(stage, id, name), 'utf8'));
    return {
      engine: metadata.engine,
      diskHosts: paths.filter(name => name.endsWith('/disk.qcow2')).map(name => name.split('/')[0]),
      nodes: Object.fromEntries([
        ...metadata.switches.map(id => [id, {kind: 'switch', name: read(id, 'switch.json').name}]),
        ...metadata.hosts.map(id => {
          const host = read(id, 'host.json');
          return [id, {kind: 'host', name: host.name, system: host.system,
            links: host.network.interfaces.map(({switchId, port, mac}) => ({switchId, port, mac}))}];
        })
      ])
    };
  } finally { fs.rmSync(stage, {recursive: true, force: true}); }
}

function sessionView(nodes) {
  return Object.fromEntries(nodes.map(node => [node.id, node.kind === 'switch'
    ? {kind: 'switch', name: node.hostname}
    : {kind: 'host', name: node.hostname, system: node.imageId,
      links: node.networkInterfaces.map(({switchId, port, mac}) => ({switchId, port, mac}))}]));
}

// Processes whose command line mentions the session's runtime directory, by executable name
// (same /proc scan as admin.js).
function sessionProcesses(id) {
  const dir = path.join(root, 'runtime', 'sessions', id);
  const found = [];
  for (const name of fs.readdirSync('/proc').filter(entry => /^\d+$/.test(entry))) {
    try {
      const argv = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0');
      if (argv.join(' ').includes(dir)) found.push({pid: Number(name), executable: path.basename(argv[0])});
    } catch (_) { /* The process exited. */ }
  }
  return found;
}

const isVdeSwitch = item => item.executable === 'vde_switch';
const isQemu = item => item.executable.startsWith('qemu-system');

// Host Log and serial console of one node through Socket.IO, as a browser pane gets them.
function watchNode(id) {
  const state = {id, serial: '', logs: [], selected: false};
  const socket = client.socket();
  sockets.push(socket);
  socket.on('connect', () => socket.emit('select-node', id, id, reply => {
    if (reply?.error) state.error = reply.error;
    else state.selected = true;
  }));
  socket.on('node-snapshot', value => {
    if (value.nodeId !== id) return;
    state.serial += value.serial || '';
    state.logs = value.logs || [];
  });
  socket.on('serial', value => { if (value.nodeId === id) state.serial += value.data || ''; });
  socket.on('log', value => { if (value.nodeId === id) state.logs.push(value.line); });
  socket.on('connect_error', error => { state.error = error.message; });
  return state;
}

async function run() {
  assert.ok(fs.existsSync(archiveFile), 'Missing demo/lan.zip.');
  fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
  const expected = await archiveView(archiveFile);
  const systems = [...new Set(Object.values(expected.nodes).filter(node => node.kind === 'host').map(node => node.system))];
  for (const system of systems) {
    assert.ok(fs.existsSync(path.join(root, 'images', `${system}.raw`)), `Missing images/${system}.raw; run bash scripts/prepare.sh --system ${system} first.`);
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  testUsers = await createTestUsers([{login: 'loader'}]);
  child = spawnServer({port, usersFile: testUsers.file});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { serverOutput = (serverOutput + value).slice(-12000); });
  client = new QemuWebClient(baseUrl);
  await client.waitForServer(30000, () => child.exitCode === null);
  const [user] = testUsers.users;
  await client.signIn(user.login, user.password);
  ({sessionId} = await client.request('/api/general-settings'));
  assert.deepEqual(await client.request('/api/nodes'), [], 'The new session is not empty.');
  console.log(`Load start: server started, empty session ${sessionId}`);

  // (1) Like the button: summary of the archive; the base image check runs only for working disks.
  const counts = kind => Object.values(expected.nodes).filter(node => node.kind === kind).length;
  assert.deepEqual(expected.diskHosts, [], 'demo/lan.zip unexpectedly contains working disks.');
  console.log(`Load start: demo/lan.zip summary: ${counts('host')} hosts and ${counts('switch')} switches, no working disk, so no base image check (as in the Web interface)`);

  // (2) The import request of the button.
  const result = await client.request('/api/session-archive/import?autoStart=true&discardStaleDisks=false', {
    method: 'POST', body: fs.readFileSync(archiveFile), headers: {'content-type': 'application/zip'}
  });
  assert.equal(result.ok, true);
  assert.equal(result.hosts, counts('host'));
  assert.equal(result.switches, counts('switch'));
  assert.deepEqual(result.startErrors, [], `Start errors: ${result.startErrors?.join('; ')}`);
  assert.deepEqual(sessionView(await client.request('/api/nodes')), expected.nodes, 'Imported nodes differ from the archive.');
  console.log(`Load start: import with automatic start accepted, no start error, nodes equal to the archive`);

  // (3) Every node reports running.
  const nodes = await waitFor('all nodes running', async () => {
    const list = await client.request('/api/nodes');
    return list.length === Object.keys(expected.nodes).length && list.every(node => node.running) ? list : null;
  });
  console.log(`Load start: ${nodes.filter(node => node.kind === 'switch').length} switch and ${nodes.filter(node => node.kind === 'host').length} hosts running`);

  const hosts = nodes.filter(node => node.kind === 'host');
  const watched = hosts.map(host => watchNode(host.id));
  await waitFor('host consoles selected', () => watched.every(state => state.selected || state.error), 10000);
  for (const state of watched) if (state.error) throw new Error(`${state.id}: ${state.error}`);
  await waitFor(`${hosts[0].hostname} serial output`, () => watched[0].serial.length > 0, 20000);
  console.log(`Load start: ${hosts[0].hostname} serial console streams boot output`);

  // (4) The processes behind the nodes.
  const processes = await waitFor('session processes', () => {
    const found = sessionProcesses(sessionId);
    return found.filter(isVdeSwitch).length === counts('switch') && found.filter(isQemu).length === counts('host') ? found : null;
  }, 10000);
  console.log(`Load start: ${processes.filter(isVdeSwitch).length} vde_switch and ${processes.filter(isQemu).length} qemu-system processes in runtime/sessions/${sessionId}`);

  // (5) Distinct VDE ports and MACs, startup disk attached on each host.
  for (const kind of ['port', 'mac']) {
    const values = hosts.map(host => host.networkInterfaces[0]?.[kind]);
    assert.ok(values.every(Boolean), `A host lacks its VDE ${kind}.`);
    assert.equal(new Set(values).size, hosts.length, `Hosts share a VDE ${kind}.`);
  }
  for (const [index, state] of watched.entries()) {
    await waitFor(`${hosts[index].hostname} startup disk log`, () => state.logs.some(line => line.startsWith('# Guest setup ISO attached: ')), 10000);
  }
  console.log(`Load start: distinct VDE ports and MACs; startup disk attached on the ${hosts.length} hosts`);
}

// (6) Deleting the session stops every process and removes its runtime directory.
async function cleanup(failed) {
  for (const socket of sockets) socket.disconnect();
  if (!child || child.exitCode !== null) return;
  try {
    if (client?.cookie && sessionId) {
      await client.request('/api/session', {method: 'DELETE'});
      await waitFor('session processes to exit', () => sessionProcesses(sessionId).length === 0, 20000);
      assert.equal(fs.existsSync(path.join(root, 'runtime', 'sessions', sessionId)), false, `runtime/sessions/${sessionId} remains.`);
      if (!failed) console.log('Load start: session deleted, its processes and runtime directory are gone');
    }
  } catch (error) {
    console.error(`Cleanup: ${error.message}`);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      delay(12000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })
    ]);
  }
}

let failed = false;
run().catch(error => {
  failed = true;
  console.error(`\nLoad start test FAILED: ${error.stack || error.message}`);
  if (serverOutput) console.error(`\n--- QemuWeb output ---\n${serverOutput.slice(-6000)}`);
  process.exitCode = 1;
}).finally(() => cleanup(failed));
