// Runner unit tests: the runtime of one session (runner/session-runner.js) is driven with an
// injected in-memory session and a temporary runtime directory. No HTTP server is
// started and no emulator process is spawned.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createSessionRunner} = require('../../runner/session-runner');

const root = path.join(__dirname, '..', '..');
const commands = {QEMU_IMG: 'qemu-img', QEMU_SYSTEM_X86_64: 'qemu-system-x86_64', GENISOIMAGE: 'genisoimage'};
const HOST_1 = 'h-00000001';
const HOST_2 = 'h-00000002';
const SWITCH_1 = 's-00000001';
const SWITCH_2 = 's-00000002';

function setup(options = {}) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-runner-'));
  const runtimeDir = path.join(runtimeRoot, 'sessions', 'test');
  fs.mkdirSync(runtimeDir, {recursive: true});
  const session = {nodes: new Map(), engine: options.engine || 'qemu', runtimeDir, saveMetadata() {}};
  const runner = createSessionRunner({session, commands: {...commands, ...options.commands}, root, runtimeRoot,
    configPath: path.join(root, 'config.json')});
  const cleanup = () => fs.rmSync(runtimeRoot, {recursive: true, force: true});
  return {runner, session, runtimeRoot, runtimeDir, cleanup};
}

function addSwitch(runner, id, name) {
  const node = runner.createNode(id, 'switch');
  runner.setNodeHostname(node, name);
  return node;
}

test('the session runner reports available engines from the resolved commands', t => {
  const qemuOnly = setup();
  t.after(qemuOnly.cleanup);
  assert.deepEqual(qemuOnly.runner.availableEngines, ['qemu']);
  assert.equal(typeof qemuOnly.runner.events.on, 'function');
  const both = setup({commands: {VBOXMANAGE: 'VBoxManage'}});
  t.after(both.cleanup);
  assert.deepEqual(both.runner.availableEngines, ['qemu', 'vbox']);
});

test('createNode builds the runtime directory layout of a host and a switch', t => {
  const {runner, session, runtimeDir, cleanup} = setup();
  t.after(cleanup);
  const host = runner.createNode(HOST_1, 'host');
  assert.equal(host.kind, 'host');
  assert.equal(host.runtimeDir, path.join(runtimeDir, HOST_1));
  assert.ok(fs.statSync(path.join(runtimeDir, HOST_1, 'startup')).isDirectory());
  assert.equal(host.socketPath, path.join(runtimeDir, HOST_1, 'serial0.sock'));
  assert.equal(host.socketPath1, path.join(runtimeDir, HOST_1, 'serial1.sock'));
  assert.equal(host.monitorPath, path.join(runtimeDir, HOST_1, 'mon.sock'));
  assert.equal(host.socketDir, null);
  assert.equal(session.nodes.get(HOST_1), host);
  assert.equal(runner.getNode(HOST_1), host);

  const sw = runner.createNode(SWITCH_1, 'switch');
  assert.equal(sw.socketDir, path.join(runtimeDir, SWITCH_1, 'vde'));
  assert.equal(sw.mgmtPath, path.join(runtimeDir, SWITCH_1, 'mgmt.sock'));
  assert.equal(fs.existsSync(path.join(runtimeDir, SWITCH_1, 'startup')), false);
});

test('node IDs are validated and an existing runtime directory is not reused by mistake', t => {
  const {runner, runtimeDir, cleanup} = setup();
  t.after(cleanup);
  assert.throws(() => runner.createNode('h1', 'host'), /Invalid host or switch ID/);
  assert.throws(() => runner.createNode(SWITCH_1, 'host'), /Expected a host ID/);
  fs.mkdirSync(path.join(runtimeDir, HOST_2));
  assert.throws(() => runner.createNode(HOST_2, 'host'), /Runtime directory state does not match/);
  assert.equal(runner.createNode(HOST_2, 'host', {existingDir: true}).id, HOST_2);
  assert.equal(runner.getNode(HOST_1), undefined);
});

test('hostname aliases follow renames under hosts/ and switches/', t => {
  const {runner, runtimeDir, cleanup} = setup();
  t.after(cleanup);
  const host = runner.createNode(HOST_1, 'host');
  runner.setNodeHostname(host, 'alpha');
  const alias = path.join(runtimeDir, 'hosts', 'alpha');
  assert.equal(fs.readlinkSync(alias), path.join('..', HOST_1));
  runner.setNodeHostname(host, 'beta');
  assert.equal(fs.existsSync(alias), false);
  assert.equal(fs.readlinkSync(path.join(runtimeDir, 'hosts', 'beta')), path.join('..', HOST_1));
  assert.equal(host.hostname, 'beta');
  addSwitch(runner, SWITCH_1, 'lan');
  assert.equal(fs.readlinkSync(path.join(runtimeDir, 'switches', 'lan')), path.join('..', SWITCH_1));
  runner.removeHostnameAlias(host);
  assert.equal(fs.existsSync(path.join(runtimeDir, 'hosts')), false);
});

test('state and log events carry the payloads forwarded to browsers', t => {
  const {runner, cleanup} = setup();
  t.after(cleanup);
  const host = runner.createNode(HOST_1, 'host');
  const events = [];
  for (const name of ['state', 'log']) runner.events.on(name, payload => events.push([name, payload]));
  t.after(() => runner.events.removeAllListeners());

  runner.publishState(host);
  runner.appendLog(host, 'QEMU started  \n');
  runner.appendLog(host, '   ');
  assert.deepEqual(events, [
    ['state', {nodeId: HOST_1, running: false, hasLaunched: false, pendingRestart: false, serialPorts: ['ttyS0'], message: 'Stopped'}],
    ['log', {nodeId: HOST_1, line: 'QEMU started'}]
  ]);
  assert.equal(runner.stateMessage(host), 'Stopped');
  for (let index = 0; index < 1005; index++) runner.appendLog(host, `line ${index}`);
  assert.equal(host.runLog.length, 1000);
  assert.equal(host.runLog.at(-1), 'line 1004');
});

test('listNodes describes nodes for the web layer', t => {
  const {runner, cleanup} = setup();
  t.after(cleanup);
  addSwitch(runner, SWITCH_1, 's1');
  assert.deepEqual(runner.listNodes(), [{
    id: SWITCH_1, kind: 'switch', running: false, hasLaunched: false, engine: null, imageId: null,
    settings: null, hostname: 's1', networkInterfaces: [], pendingRestart: false, serialPorts: ['ttyS0'], hasDifferentialDisk: false,
    addresses: {}, message: 'Stopped'
  }]);
});

test('startAllNodes skips running and busy nodes and reports a host that cannot start', async t => {
  const {runner, cleanup} = setup();
  t.after(cleanup);
  const states = [];
  runner.events.on('state', state => states.push(state));
  t.after(() => runner.events.removeAllListeners());
  addSwitch(runner, SWITCH_1, 'running-sw').machine = {};
  addSwitch(runner, SWITCH_2, 'stopping-sw').stopping = true;
  const running = runner.createNode(HOST_1, 'host');
  runner.setNodeHostname(running, 'running-host');
  running.machine = {};
  const rebooting = runner.createNode(HOST_2, 'host');
  runner.setNodeHostname(rebooting, 'rebooting-host');
  rebooting.action = 'reboot';
  const failing = runner.createNode('h-00000003', 'host');
  runner.setNodeHostname(failing, 'failing-host');
  failing.engine = 'vbox';
  failing.selectedImage = runner.imageById('debian13-legacy');

  const result = await runner.startAllNodes();
  assert.deepEqual(result.started, []);
  assert.deepEqual(result.startErrors, ['failing-host: VirtualBox is unavailable on this server.']);
  assert.deepEqual(states.map(state => [state.nodeId, state.message]), [['h-00000003', 'Start failed: VirtualBox is unavailable on this server.']]);
  assert.equal(rebooting.machine, null);
});

test('Ethernet interfaces get unique locally administered MACs and free switch ports', t => {
  const {runner, cleanup} = setup();
  t.after(cleanup);
  const sw1 = addSwitch(runner, SWITCH_1, 's1');
  const sw2 = addSwitch(runner, SWITCH_2, 's2');
  const h1 = runner.createNode(HOST_1, 'host');
  h1.networkInterfaces = runner.assignNetworkInterfaces(h1, [sw1, sw1, null]);
  assert.deepEqual(h1.networkInterfaces.map(({switchId, port}) => [switchId, port]), [[SWITCH_1, 1], [SWITCH_1, 2], [null, null]]);
  assert.ok(h1.networkInterfaces.every(nic => /^02(?::[0-9a-f]{2}){5}$/.test(nic.mac)));
  assert.equal(new Set(h1.networkInterfaces.map(nic => nic.mac)).size, 3);

  const h2 = runner.createNode(HOST_2, 'host');
  h2.networkInterfaces = runner.assignNetworkInterfaces(h2, [sw1, sw2]);
  assert.deepEqual(h2.networkInterfaces.map(nic => nic.port), [3, 1]);

  // Unchanged interfaces are kept as is; a moved interface gets a free port on its new switch.
  const replanned = runner.assignNetworkInterfaces(h1, [sw1, sw2, null]);
  assert.equal(replanned[0], h1.networkInterfaces[0]);
  assert.equal(replanned[2], h1.networkInterfaces[2]);
  assert.deepEqual([replanned[1].switchId, replanned[1].port], [SWITCH_2, 2]);
  assert.equal(new Set(replanned.map(nic => nic.mac)).size, 3);
});

test('interface lists are validated against existing and running switches', t => {
  const {runner, cleanup} = setup();
  t.after(cleanup);
  const sw = addSwitch(runner, SWITCH_1, 's1');
  assert.deepEqual(runner.validateNetworkInterfaces(undefined, 'qemu'), [null]);
  assert.throws(() => runner.validateNetworkInterfaces([null, null, null, null, null], 'qemu'), /At most four/);
  assert.throws(() => runner.validateNetworkInterfaces([SWITCH_1], 'qemu'), /Ethernet 0: start its VDE switch first/);
  assert.throws(() => runner.validateNetworkInterfaces([null, SWITCH_2], 'qemu', false), /Ethernet 1/);
  assert.deepEqual(runner.validateNetworkInterfaces([SWITCH_1, null], 'qemu', false), [sw, null]);
});

test('name allocation and engine checks use the injected session', t => {
  const {runner, session, cleanup} = setup();
  t.after(cleanup);
  addSwitch(runner, SWITCH_1, 'h1');
  assert.equal(runner.allocateName('h'), 'h2');
  assert.throws(() => runner.requireSessionEngine('vbox'), /VirtualBox is unavailable/);
  runner.requireSessionEngine('qemu');
  session.engine = 'vbox';
  assert.throws(() => runner.requireSessionEngine('qemu'), /differs from this session's vbox engine/);
});

test('the system catalog resolves images from config.json and the project root', t => {
  const {runner, cleanup} = setup();
  t.after(cleanup);
  const id = Object.keys(runner.readConfig().systems).find(system => system !== 'default');
  const image = runner.imageById(id);
  assert.equal(image.id, id);
  assert.equal(typeof image.label, 'string');
  assert.ok(image.images.raw);
  assert.equal(runner.imageById('default'), null);
  assert.equal(runner.imageById('no-such-system'), null);
  assert.equal(runner.imagePath('images/disk.raw'), path.join(root, 'images', 'disk.raw'));
  const settings = runner.launchSettingsFor(id, {memory: 768});
  assert.equal(settings.memory, 768);
});

test('launch preview builds QEMU commands for a new host without creating it', t => {
  const {runner, session, runtimeDir, cleanup} = setup();
  t.after(cleanup);
  const sw = addSwitch(runner, SWITCH_1, 'lan');
  const system = Object.keys(runner.readConfig().systems).find(id => id !== 'default');
  const preview = runner.previewLaunch(HOST_1, {system, engine: 'qemu', interfaces: JSON.stringify([SWITCH_1, null]),
    startupDiskEnabled: 'false'});
  assert.equal(preview.launched, false);
  assert.equal(preview.engine, 'qemu');
  assert.equal(session.nodes.has(HOST_1), false);
  assert.deepEqual(preview.interfaces.map(({index, switch: label, port}) => [index, label, port]),
    [[1, 'lan · port 1', 1], [2, 'Disconnected', null]]);
  assert.equal(preview.commands.length, 2);
  assert.match(preview.commands[0], /^qemu-img create -f qcow2 -F raw -b /);
  assert.ok(preview.commands[0].includes(path.join(runtimeDir, HOST_1, 'disk.qcow2')));
  assert.match(preview.commands[1], /^qemu-system-x86_64 /);
  assert.ok(preview.commands[1].includes(`vde,id=lan0,sock=${sw.socketDir},port=1`));
  assert.ok(preview.commands[1].includes(`unix:${path.join(runtimeDir, HOST_1, 'mon.sock')},server=on,wait=off`));
  assert.deepEqual(preview.storage.map(item => item.label), ['Base image (RAW)', 'Working disk (QCOW2 overlay)', 'Startup disk (cd-rom)']);
  assert.equal(preview.storage[2].path, 'Not created');
  assert.equal(preview.console.socket, path.join('runtime', 'sessions', 'test', HOST_1, 'serial0.sock'));

  const withIso = runner.previewLaunch(HOST_1, {system, engine: 'qemu', startupDiskEnabled: 'true'});
  assert.match(withIso.commands[0], /^genisoimage -quiet -R -J -V /);
  assert.ok(withIso.commands.at(-1).includes('media=cdrom'));
});

test('launch preview rejects unknown options, engines and systems', t => {
  const {runner, cleanup} = setup();
  t.after(cleanup);
  assert.throws(() => runner.previewLaunch(HOST_1, {system: 'alpine', engine: 'qemu', extra: '1'}), /Unknown host preview option/);
  assert.throws(() => runner.previewLaunch(HOST_1, {system: 'alpine', engine: 'qemu', startupDiskEnabled: 'yes'}), /true or false/);
  assert.throws(() => runner.previewLaunch(SWITCH_1, {system: 'alpine', engine: 'qemu'}), /Expected a host ID/);
  assert.throws(() => runner.previewLaunch(HOST_1, {system: 'alpine', engine: 'vbox'}), /VirtualBox is unavailable/);
  assert.throws(() => runner.previewLaunch(HOST_1, {system: 'no-such-system', engine: 'qemu'}), /Unknown system or engine/);
});

test('the QEMU monitor refuses hosts that are not running', async t => {
  const {runner, cleanup} = setup();
  t.after(cleanup);
  runner.createNode(HOST_1, 'host');
  await assert.rejects(runner.monitor(HOST_1, 'info status'), /only for a running QEMU host/);
  await assert.rejects(runner.monitor(SWITCH_1, 'info status'), /only for a running QEMU host/);
});
