'use strict';

// Loads the real example files without starting any VM: topo/*.topo through the topology routes,
// examples/lan.zip through the session-archive routes, its export re-imported into another session,
// and corrupted copies of lan.zip refused. Nodes are only created, never started: no system
// image, KVM or VDE process is needed. Expectations come from the project's own topology
// parser and ZIP reader.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {createTestUsers, spawnServer, QemuWebClient} = require('./qemuweb-client');
const {parseTopology} = require('../../common/topology');
const {readArchive} = require('../../runner/archive-zip');

const root = path.resolve(__dirname, '../..');
const example = name => path.join(root, 'examples', name);
const topology = name => path.join(root, 'topo', name);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-check-load-'));
let child;
let testUsers;
let serverOutput = '';
const clients = [];
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

// Expects a refused request: a 4xx status and an error message.
async function expectRefused(client, route, options, label) {
  const response = await client.fetch(route, options);
  const payload = await response.json().catch(() => ({}));
  assert.ok(response.status >= 400 && response.status < 500, `${label}: ${route} returned ${response.status}, expected a refusal.`);
  assert.ok(typeof payload.error === 'string' && payload.error, `${label}: refusal without an error message.`);
  return payload.error;
}

// The node set of a session, in a form comparable with a topology or an archive.
async function nodeSet(client) {
  const nodes = await client.request('/api/nodes');
  for (const node of nodes) assert.equal(node.running, false, `${node.hostname} is running.`);
  const switches = nodes.filter(node => node.kind === 'switch');
  const hosts = nodes.filter(node => node.kind === 'host');
  return {nodes, switches, hosts};
}

// Topology view of a session: switch names and, per host, its system and switch names.
function topologyView({switches, hosts}) {
  const switchName = new Map(switches.map(sw => [sw.id, sw.hostname]));
  return {
    switches: switches.map(sw => sw.hostname).sort(),
    hosts: Object.fromEntries(hosts.map(host => [host.hostname, {
      system: host.imageId,
      switches: host.networkInterfaces.map(nic => {
        assert.ok(switchName.has(nic.switchId), `${host.hostname} is linked to an unknown switch ${nic.switchId}.`);
        return switchName.get(nic.switchId);
      })
    }]))
  };
}

function parsedView(topology) {
  return {
    switches: topology.switches.map(sw => sw.name).sort(),
    hosts: Object.fromEntries(topology.hosts.map(host => [host.name, {system: host.system, switches: host.switches}]))
  };
}

// Reads a session ZIP with the project's reader; returns its node set keyed by ID.
async function archiveView(file) {
  const stage = fs.mkdtempSync(path.join(workDir, 'stage-'));
  try {
    const paths = await readArchive(file, stage);
    const metadata = JSON.parse(fs.readFileSync(path.join(stage, 'session.json'), 'utf8'));
    const read = (id, name) => JSON.parse(fs.readFileSync(path.join(stage, id, name), 'utf8'));
    return {
      engine: metadata.engine,
      disks: paths.filter(name => /\/disk\.(?:qcow2|vdi)$/.test(name)).length,
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

function sessionView({nodes}) {
  return Object.fromEntries(nodes.map(node => [node.id, node.kind === 'switch'
    ? {kind: 'switch', name: node.hostname}
    : {kind: 'host', name: node.hostname, system: node.imageId,
      links: node.networkInterfaces.map(({switchId, port, mac}) => ({switchId, port, mac}))}]));
}

async function importArchive(client, data) {
  return client.request('/api/session-archive/import?autoStart=false&discardDisks=false', {
    method: 'POST', body: data, headers: {'content-type': 'application/zip'}
  });
}

async function checkTopologies(client, systems) {
  const engine = (await client.request('/api/general-settings')).engine;
  let first = true;
  for (const name of ['lan.topo', 'gw.topo', 'dmz.topo']) {
    const text = fs.readFileSync(topology(name), 'utf8');
    const expected = parsedView(parseTopology(text, systems));
    const preview = await client.request('/api/topology/preview', {method: 'POST', body: {text, engine}});
    const links = Object.values(expected.hosts).reduce((count, host) => count + host.switches.length, 0);
    assert.deepEqual(preview, {hosts: Object.keys(expected.hosts).length, switches: expected.switches.length, links}, `${name}: preview counts`);
    if (!first) await client.request('/api/session/reset', {method: 'POST'});
    const result = await client.request('/api/topology', {method: 'POST', body: {text, engine, autostart: false}});
    assert.equal(result.created, Object.keys(expected.hosts).length + expected.switches.length, `${name}: created count`);
    assert.deepEqual(result.errors, []);
    const loaded = await nodeSet(client);
    assert.deepEqual(topologyView(loaded), expected, `${name}: nodes and links differ from the file`);
    console.log(`Load: examples/${name}: ${expected.switches.length} switches and ${Object.keys(expected.hosts).length} hosts created, links match, none running`);

    const exportResponse = await client.fetch('/api/topology');
    assert.equal(exportResponse.status, 200, `${name}: topology export returned ${exportResponse.status}`);
    assert.deepEqual(parsedView(parseTopology(await exportResponse.text(), systems)), expected, `${name}: exported topology differs`);
    console.log(`Load: examples/${name}: exported topology parses back to the same hosts and switches`);
    first = false;
  }

  const before = sessionView(await nodeSet(client));
  const invalid = {
    'host linked to an unknown switch': 'SWITCH s1\nHOST debian13-legacy bad1 s1\nHOST debian13-legacy bad2 nowhere\n',
    'unknown directive': 'SWITCH s1\nROUTER r1 s1\n'
  };
  for (const [label, text] of Object.entries(invalid)) {
    await expectRefused(client, '/api/topology/preview', {method: 'POST', body: {text, engine}}, label);
    const error = await expectRefused(client, '/api/topology', {method: 'POST', body: {text, engine}}, label);
    assert.deepEqual(sessionView(await nodeSet(client)), before, `${label}: the session changed`);
    console.log(`Load: invalid topology (${label}) refused without changes: ${error}`);
  }
}

async function checkArchives(importer, reimporter, systems) {
  const archiveFile = example('lan.zip');
  const data = fs.readFileSync(archiveFile);
  const expected = await archiveView(archiveFile);
  assert.equal(expected.disks, 0, 'examples/lan.zip unexpectedly contains working disks.');
  for (const node of Object.values(expected.nodes)) if (node.kind === 'host') assert.ok(systems.includes(node.system), `Unknown system ${node.system}`);

  // Only hosts with a working disk record a base image identity: lan.zip has none, so
  // neither the check nor the import reads images/<system>.raw.
  const check = await importer.request('/api/session-archive/check', {method: 'POST', body: {baseImages: {}}});
  assert.deepEqual(check, {changed: []});
  console.log('Load: examples/lan.zip base image check: nothing to compare (no working disk)');

  const imported = await importArchive(importer, data);
  const counts = kind => Object.values(expected.nodes).filter(node => node.kind === kind).length;
  assert.equal(imported.hosts, counts('host'));
  assert.equal(imported.switches, counts('switch'));
  assert.deepEqual(imported.startErrors, []);
  assert.deepEqual(sessionView(await nodeSet(importer)), expected.nodes, 'lan.zip: imported nodes differ from the archive');
  console.log(`Load: examples/lan.zip imported (${imported.hosts} hosts, ${imported.switches} switches): IDs, names, systems and links match, none running`);

  await expectRefused(importer, '/api/session-archive/import?autoStart=false', {
    method: 'POST', body: data, headers: {'content-type': 'application/zip'}
  }, 'import into a non-empty session');
  console.log('Load: second import into the non-empty session refused');

  const response = await importer.fetch('/api/session-archive/export', {method: 'POST', body: {includeDisks: false}});
  assert.equal(response.status, 200, `Session export returned ${response.status}`);
  const exported = Buffer.from(await response.arrayBuffer());
  const exportFile = path.join(workDir, 'export.zip');
  fs.writeFileSync(exportFile, exported);
  assert.deepEqual((await archiveView(exportFile)).nodes, expected.nodes, 'The exported archive differs from lan.zip');
  console.log(`Load: session exported (${exported.length} bytes), readable and identical in content to examples/lan.zip`);

  // Corrupted copies are refused and create nothing.
  const corrupted = {
    'flipped byte in session.json': (() => {
      const copy = Buffer.from(data);
      const name = Buffer.from('session.json');
      let offset = -1;
      for (let at = copy.indexOf(name); at >= 0; at = copy.indexOf(name, at + 1)) {
        if (at >= 30 && copy.readUInt32LE(at - 30) === 0x04034b50) { offset = at + name.length + copy.readUInt16LE(at - 2); break; }
      }
      assert.ok(offset > 0, 'No session.json local entry in examples/lan.zip.');
      copy[offset] ^= 0xff;
      return copy;
    })(),
    'truncated archive': data.subarray(0, data.length - 40),
    'not a ZIP file': Buffer.from('SWITCH s1\n')
  };
  for (const [label, copy] of Object.entries(corrupted)) {
    const error = await expectRefused(reimporter, '/api/session-archive/import?autoStart=false', {
      method: 'POST', body: copy, headers: {'content-type': 'application/zip'}
    }, label);
    assert.deepEqual((await nodeSet(reimporter)).nodes, [], `${label}: nodes were created`);
    console.log(`Load: corrupted lan.zip (${label}) refused without changes: ${error}`);
  }

  const reimported = await importArchive(reimporter, exported);
  assert.deepEqual(reimported.startErrors, []);
  assert.deepEqual(sessionView(await nodeSet(reimporter)), expected.nodes, 'The re-imported export differs from lan.zip');
  console.log('Load: exported archive imported into a third session: same IDs, names, kinds and links, none running');
}

async function run() {
  for (const name of ['lan.topo', 'gw.topo', 'dmz.topo']) assert.ok(fs.existsSync(topology(name)), `Missing topo/${name}.`);
  assert.ok(fs.existsSync(example('lan.zip')), 'Missing examples/lan.zip.');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  testUsers = await createTestUsers([{login: 'topo'}, {login: 'importer'}, {login: 'reimporter'}]);
  child = spawnServer({port, usersFile: testUsers.file});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { serverOutput = (serverOutput + value).slice(-12000); });
  const [topo, importer, reimporter] = testUsers.users;
  await new QemuWebClient(baseUrl).waitForServer(30000, child);
  for (const user of [topo, importer, reimporter]) clients.push(await new QemuWebClient(baseUrl).signIn(user.login, user.password));
  const sessions = new Set(await Promise.all(clients.map(async client => (await client.request('/api/general-settings')).sessionId)));
  assert.equal(sessions.size, 3, 'The three users must have three sessions.');
  const systems = (await clients[0].request('/api/systems')).map(system => system.id);
  console.log(`Load: server started, three users with three empty sessions; systems ${systems.join(', ')}`);

  await checkTopologies(clients[0], systems);
  await checkArchives(clients[1], clients[2], systems);
  console.log('Load: all checks passed');
}

async function cleanup() {
  for (const client of clients) {
    try { await client.request('/api/session/reset', {method: 'POST'}); } catch (error) { console.error(`Cleanup ${client.login}: ${error.message}`); }
  }
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(12000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })
  ]);
}

run().catch(error => {
  console.error(`\nLoad test FAILED: ${error.stack || error.message}`);
  if (serverOutput) console.error(`\n--- QemuWeb output ---\n${serverOutput.slice(-6000)}`);
  process.exitCode = 1;
}).finally(cleanup);
