'use strict';

// The QEMU command line and the node state with the guest agent channel (GAG01): the channel is declared at
// boot only for a system whose image carries the agent; the socket path stays inside the 107 byte budget; the
// addresses are part of the node list and of the events the server forwards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createQemu} = require('../../runner/engines/qemu');
const {createSessionRunner} = require('../../runner/session-runner');
const {NODE_FILES, SOCKET_LIMIT} = require('../../common/runtime-dir');
const {moduleSource} = require('./web-ui-source');

function qemuFixture() {
  const ctx = {runtime: {tempFile: (node, name) => path.join(node.runtimeDir, name), appendLog() {}, publishState() {}, execLogged() {}, removeConsoleSockets() {}},
    disks: {qemuOverlayArgs: () => []}, session: {nodes: new Map()}, commands: {QEMU_IMG: 'qemu-img', QEMU_SYSTEM_X86_64: 'qemu-system-x86_64'}, capture: {hostStopped() {}}, guestAgent: {unwatch() {}}};
  const qemu = createQemu(ctx);
  const node = {runtimeDir: '/run/qw/sessions/s/h-1', monitorPath: '/run/qw/sessions/s/h-1/mon.sock', socketPath: '/run/qw/sessions/s/h-1/serial0.sock',
    socketPath1: '/run/qw/sessions/s/h-1/serial1.sock', guestAgentPath: '/run/qw/sessions/s/h-1/qga.sock', qemuAcceleration: 'kvm',
    qemuOptions: {extraOptions: ['-machine', 'q35', '-cpu', 'host', '-nic', 'none'], display: 'none', memory: 1024, smp: 1, rtcBase: 'utc', diskInterface: 'virtio', bootDisk: 'c', networkModel: 'virtio-net-pci'},
    launchSettings: {serialPorts: ['ttyS0']}, guestIsoAttached: false, guestIso: null, networkInterfaces: []};
  return {qemu, node};
}

test('the channel is on the command line when the system has the agent, in this exact form', () => {
  const {qemu, node} = qemuFixture();
  const args = qemu.qemuArgs(node, {guestAgent: true}, '/run/disk.qcow2');
  const at = args.indexOf('-chardev');
  assert.ok(at >= 0);
  assert.deepEqual(args.slice(at, at + 6), ['-chardev', 'socket,id=qga,path=/run/qw/sessions/s/h-1/qga.sock,server=on,wait=off',
    '-device', 'virtio-serial-pci', '-device', 'virtserialport,chardev=qga,name=org.qemu.guest_agent.0']);
});

test('without the agent in the image there is no channel, no virtio-serial device and no extra socket', () => {
  const {qemu, node} = qemuFixture();
  for (const image of [{guestAgent: false}, {}, undefined]) {
    const args = qemu.qemuArgs(node, image, '/run/disk.qcow2');
    assert.ok(!args.includes('-chardev'));
    assert.ok(!args.some(arg => /virtio-serial|virtserialport|qga/.test(arg)));
  }
});

test('qga.sock is a node file and the longest path of the runtime budget does not grow', () => {
  assert.equal(NODE_FILES.qga, 'qga.sock');
  const node = path.join('/tmp/qw-someone/3002/sessions', '0'.repeat(16), `h-${'0'.repeat(16)}`);
  assert.ok(Buffer.byteLength(path.join(node, NODE_FILES.qga)) < Buffer.byteLength(path.join(node, NODE_FILES.serial0)));
  assert.ok(Buffer.byteLength(path.join(node, NODE_FILES.qga)) <= SOCKET_LIMIT);
});

test('a node has its agent socket path, the node list carries the addresses, and the socket is cleaned up', t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-ga-'));
  t.after(() => fs.rmSync(runtimeRoot, {recursive: true, force: true}));
  const runtimeDir = path.join(runtimeRoot, 'sessions', 'test');
  fs.mkdirSync(runtimeDir, {recursive: true});
  const session = {nodes: new Map(), engine: 'qemu', runtimeDir, saveMetadata() {}};
  const commands = {QEMU_IMG: 'qemu-img', QEMU_SYSTEM_X86_64: 'qemu-system-x86_64', GENISOIMAGE: 'genisoimage', VBOXMANAGE: 'VBoxManage'};
  const runner = createSessionRunner({session, commands, root: path.join(__dirname, '..', '..'), runtimeRoot, configPath: path.join(__dirname, '..', '..', 'config.json')});
  const node = runner.createNode('h-0000000000000001', 'host');
  assert.equal(node.guestAgentPath, path.join(node.runtimeDir, 'qga.sock'));
  assert.deepEqual(runner.listNodes().find(entry => entry.id === node.id).addresses, {});
  node.guestAddresses = {0: ['10.0.0.1/24']};
  assert.deepEqual(runner.listNodes().find(entry => entry.id === node.id).addresses, {0: ['10.0.0.1/24']});
  fs.writeFileSync(node.guestAgentPath, '');
  node.machine = null;
  require('../../runner/session-runtime').createSessionRuntime({session, runtimeRoot, events: runner.events}).removeConsoleSockets(node);
  assert.ok(!fs.existsSync(node.guestAgentPath), 'a leftover qga.sock is removed with the other sockets');
});

test('the runner sends guest-info and the server forwards it to the session room', () => {
  const root = path.join(__dirname, '..', '..');
  assert.match(fs.readFileSync(path.join(root, 'runner', 'service.js'), 'utf8'), /RUNNER_EVENTS = \[[^\]]*'guest-info'/);
  assert.match(fs.readFileSync(path.join(root, 'server', 'sockets.js'), 'utf8'), /'captures', 'guest-info'\]/);
  assert.ok(moduleSource('socket').includes('guest-info'), 'the browser listens for guest-info');
});
