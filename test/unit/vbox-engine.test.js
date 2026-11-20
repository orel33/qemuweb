'use strict';

// The VirtualBox engine (runner/engines/vbox.js) with a FAKE VBoxManage, a script in a temporary
// directory that records its arguments and fails on demand: no VirtualBox is used. Covers every
// command of the start sequence, the cleanup after a failed start (never --delete on
// unregistervm, nothing outside the run directory removed), the explanation of each known
// failure, and the KVM exclusion rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createVirtualBox} = require('../../runner/engines/vbox');
const {explainVirtualBoxFailure} = require('../../runner/engines/vbox-errors');
const {kvmExclusion, BUSY} = require('../../runner/engines/kvm-exclusion');

const PARENT = '/images/alpine.vdi';
const FAKE = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
// The media registry (VirtualBox.xml): files with a VDI header have a UUID and a parent UUID; others have none.
const registryFile = path.join(dir, 'registry.json');
const registry = fs.existsSync(registryFile) ? JSON.parse(fs.readFileSync(registryFile, 'utf8')) : {};
const save = () => fs.writeFileSync(registryFile, JSON.stringify(registry));
const uuid = (buffer, at) => { const h = x => Buffer.from(x).reverse().toString('hex'); const b = buffer.subarray(at, at + 16);
  return h(b.subarray(0, 4)) + '-' + h(b.subarray(4, 6)) + '-' + h(b.subarray(6, 8)) + '-' + b.subarray(8, 10).toString('hex') + '-' + b.subarray(10, 16).toString('hex'); };
const header = file => { try { const b = fs.readFileSync(file); return b.length >= 456 && b.readUInt32LE(64) === 0xbeda107f ? {uuid: uuid(b, 392), parent: uuid(b, 424)} : null; } catch (_) { return null; } };
const NIL = '00000000-0000-0000-0000-000000000000';
const register = file => { const h = header(file); if (h) registry[file] = h; };
if (args[0] === 'createmedium') {
  const parent = args[args.indexOf('--diffparent') + 1], file = args[args.indexOf('--filename') + 1];
  register(parent);
  fs.writeFileSync(file, 'diff');
  if (registry[parent]) registry[file] = {uuid: 'probe-' + path.basename(file), parent: registry[parent].uuid};
  save();
}
if (args[0] === 'openmedium' && plan.openmediumRegisters !== false) { register(args[2]); save(); }
if (args[0] === 'closemedium') { delete registry[args[2]]; for (const [f, m] of Object.entries(registry)) if (!Object.values(registry).some(x => x.parent === m.uuid) && m.parent === NIL) delete registry[f]; save(); }
if (args[0] === 'list' && args[1] === 'hdds' && !plan.listEmpty) process.stdout.write(Object.entries(registry).map(([f, m]) => 'UUID:           ' + m.uuid + '\\nParent UUID:    ' + m.parent + '\\nLocation:       ' + f + '\\n').join('\\n'));
if (args[0] === 'storageattach' && args.includes('hdd')) {
  const file = args[args.indexOf('--medium') + 1], h = header(file);
  if (h && h.parent !== NIL && !Object.values(registry).some(m => m.uuid === h.parent)) {
    process.stderr.write("VBoxManage: error: Parent medium with UUID {" + h.parent + "} of the medium '" + file + "' is not found in the media registry ('/home/orel/.config/VirtualBox/VirtualBox.xml')\\n");
    process.exit(1);
  }
  register(file); save();
}
if ([].concat(plan.failOn).includes(args[0]) && (!plan.failOnce || !fs.existsSync(path.join(dir, 'failed')))) {
  fs.writeFileSync(path.join(dir, 'failed'), '');
  process.stderr.write(plan.message + '\\n');
  process.exit(1);
}
`;

function setup(t, {failOn = null, message = '', failOnce = false, listEmpty = false, nodeOptions = {}} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-vbox-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const bin = path.join(dir, 'VBoxManage');
  fs.writeFileSync(bin, FAKE, {mode: 0o755});
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({failOn, message, failOnce, listEmpty}));
  const runtimeDir = path.join(dir, 'run', 'h1');
  fs.mkdirSync(runtimeDir, {recursive: true});
  const log = [];
  const {execFileSync} = require('node:child_process');
  const sw = {kind: 'switch', socketDir: path.join(dir, 'vde')};
  const node = {id: 'h1', kind: 'host', vmName: 'qw-test', runtimeDir, socketPath: path.join(runtimeDir, 'serial0.sock'),
    launchSettings: {memory: 256, cpus: 1, clock: 'utc'}, guestIsoAttached: false,
    networkInterfaces: [{switchId: 's1', mac: '52:54:00:12:34:56', port: 3}], ...nodeOptions};
  const image = {virtualbox: {osType: 'Linux_64', networkModel: 'virtio', firmware: 'bios', diskBus: 'sata',
    diskController: 'IntelAhci', cdromBus: 'ide', cdromController: 'PIIX4'}, images: {vdi: 'images/alpine.vdi'}};
  const tempFile = (_, name) => path.join(runtimeDir, name);
  const ctx = {
    runtime: {
      tempFile,
      appendLog: (_, line) => log.push(String(line)),
      execLogged: (_, command, args, options) => { log.push(`$ ${[command, ...args].join(' ')}`); return execFileSync(command, args, options); }
    },
    catalog: {imagePath: file => `/${file}`},
    disks: {cleanupRunFiles: (item, img) => { for (const file of img.runFiles || []) fs.rmSync(file, {force: true}); img.runFiles = []; item.runDisk = null; }},
    commands: {VBOXMANAGE: bin},
    session: {nodes: new Map([['s1', sw]])}
  };
  const calls = () => (fs.existsSync(path.join(dir, 'calls.jsonl'))
    ? fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []);
  return {engine: createVirtualBox(ctx), node, image, log, calls, dir, runtimeDir, sw};
}

test('a start runs the VBoxManage commands in order, ending with a headless startvm', t => {
  const {engine, node, image, calls, runtimeDir} = setup(t);
  engine.spawnVirtualBox(node, image);
  const names = calls().map(args => args.slice(0, args[0] === 'storagectl' || args[0] === 'storageattach' ? 3 : 1).join(' '));
  assert.deepEqual(names.map(name => name.split(' ')[0]),
    ['createvm', 'modifyvm', 'createmedium', 'storagectl', 'storageattach', 'storagectl', 'modifyvm', 'startvm']);
  const [createvm, modifyvm, createmedium, ctlDisk, attach, ctlCd, boot, startvm] = calls();
  assert.deepEqual(createvm, ['createvm', '--name', 'qw-test', '--basefolder', path.join(runtimeDir, 'vbox-vm'), '--ostype', 'Linux_64', '--register']);
  assert.deepEqual(createmedium, ['createmedium', 'disk', '--filename', path.join(runtimeDir, 'disk.vdi'), '--diffparent', PARENT, '--format', 'VDI']);
  assert.deepEqual(ctlDisk, ['storagectl', 'qw-test', '--name', 'SATA', '--add', 'sata', '--controller', 'IntelAhci']);
  assert.deepEqual(attach, ['storageattach', 'qw-test', '--storagectl', 'SATA', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', path.join(runtimeDir, 'disk.vdi')]);
  assert.deepEqual(ctlCd, ['storagectl', 'qw-test', '--name', 'Guest setup', '--add', 'ide', '--controller', 'PIIX4']);
  assert.deepEqual(boot, ['modifyvm', 'qw-test', '--boot1', 'disk', '--boot2', 'dvd', '--boot3', 'none', '--boot4', 'none']);
  assert.deepEqual(startvm, ['startvm', 'qw-test', '--type', 'headless']);
  assert.deepEqual(modifyvm.slice(0, 12), ['modifyvm', 'qw-test', '--memory', '256', '--cpus', '1', '--rtcuseutc', 'on', '--firmware', 'bios', '--nic1', 'generic']);
  assert.deepEqual(modifyvm.slice(-5), ['0x3F8', '4', '--uartmode1', 'server', node.socketPath]);
  assert.deepEqual(node.machine, {kind: 'vbox', vmDir: path.join(runtimeDir, 'vbox-vm')});
});

test('the guest setup ISO is attached only when present', t => {
  const {engine, node, image, calls} = setup(t, {nodeOptions: {guestIsoAttached: true, guestIso: '/run/startup.iso'}});
  engine.spawnVirtualBox(node, image);
  const attach = calls().filter(args => args[0] === 'storageattach' && args.includes('dvddrive'));
  assert.deepEqual(attach, [['storageattach', 'qw-test', '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', '/run/startup.iso']]);
});

test('the NICs use the generic VDE driver on the switch socket directory and port', t => {
  const {engine, node, image, sw} = setup(t);
  const args = engine.virtualBoxNetworkArgs(node, image);
  assert.deepEqual(args.slice(0, 11), ['--nic1', 'generic', '--nictype1', 'virtio', '--macaddress1', '525400123456', '--cableconnected1', 'on',
    '--nicgenericdrv1', 'VDE', '--nicproperty1']);
  assert.equal(args[11], `network=${sw.socketDir}[3]`);
  assert.deepEqual(args.slice(12), ['--nic2', 'none', '--nic3', 'none', '--nic4', 'none']);
});

test('a start that fails halfway unregisters the VM, removes the disk and the folder, and never deletes with unregistervm', t => {
  const {engine, node, image, calls, runtimeDir} = setup(t, {failOn: 'storageattach', message: 'VBoxManage: error: Could not attach'});
  fs.mkdirSync(path.join(runtimeDir, 'vbox-vm', 'qw-test'), {recursive: true});
  assert.throws(() => engine.spawnVirtualBox(node, image), /Could not attach/);
  const sent = calls();
  const after = sent.slice(sent.findIndex(args => args[0] === 'storageattach') + 1);
  assert.deepEqual(after, [['controlvm', 'qw-test', 'poweroff'], ['unregistervm', 'qw-test'], ['closemedium', 'disk', path.join(runtimeDir, 'disk.vdi')]]);
  assert.ok(!fs.existsSync(path.join(runtimeDir, 'disk.vdi')), 'the differencing disk is gone');
  assert.ok(!fs.existsSync(path.join(runtimeDir, 'vbox-vm')), 'the VM folder is gone');
  assert.equal(node.runDisk, null);
  assert.equal(node.machine, undefined);
});

test('the cleanup runs when the very first command fails, and the parent image is never passed to a removing call', t => {
  const {engine, node, image, calls} = setup(t, {failOn: 'createvm', message: 'VBoxManage: error: boom'});
  assert.throws(() => engine.spawnVirtualBox(node, image), /boom/);
  assert.ok(calls().some(args => args[0] === 'unregistervm'));
  for (const args of calls()) {
    if (['unregistervm', 'closemedium'].includes(args[0])) assert.ok(!args.includes('--delete') && !args.includes(PARENT), args.join(' '));
  }
});

test('removing a machine passes no --delete, and refuses a disk outside the run directory', t => {
  const {engine, node, image, calls, dir, runtimeDir} = setup(t);
  const own = path.join(runtimeDir, 'disk.vdi');
  const foreign = path.join(dir, 'foreign.vdi');
  fs.writeFileSync(own, 'x');
  fs.writeFileSync(foreign, 'x');
  image.runFiles = [own, foreign];
  engine.removeVirtualBoxMachine(node, image, {poweroff: true});
  assert.ok(!fs.existsSync(own));
  assert.ok(fs.existsSync(foreign), 'a file outside the run directory is kept');
  assert.deepEqual(calls(), [['controlvm', 'qw-test', 'poweroff'], ['unregistervm', 'qw-test'], ['closemedium', 'disk', own]]);
  assert.ok(!calls().some(args => args.includes('--delete')));
});

const KNOWN_FAILURES = [
  ['VERR_VMX_IN_VMX_ROOT_MODE', 'VBoxManage: error: VT-x is being used by another hypervisor (VERR_VMX_IN_VMX_ROOT_MODE).', /holds the virtualization hardware \(KVM\)/],
  ['VERR_SVM_IN_USE', 'VBoxManage: error: AMD-V is being used by another hypervisor (VERR_SVM_IN_USE).', /holds the virtualization hardware \(KVM\)/],
  ['access denied', 'VBoxManage: error: Failed to open /dev/vboxdrv (VERR_ACCESS_DENIED)', /cannot open \/dev\/vboxdrv: add yourself to the group vboxusers/],
  ['not accessible', 'The VirtualBox kernel driver is not accessible to the current user.', /cannot open \/dev\/vboxdrv/],
  ['module mismatch', 'VBoxManage: error: The VirtualBox kernel driver version mismatch (VERR_VM_DRIVER_VERSION_MISMATCH)', /kernel module is missing or does not match.*vboxconfig/],
  ['module missing', 'VBoxManage: error: Kernel driver not installed (VERR_VM_DRIVER_NOT_INSTALLED)', /kernel module is missing or does not match.*vboxconfig/],
  ['VDE', 'VBoxManage: error: Failed to connect to the VDE SWITCH', /cannot connect to its VDE switch/]
];

for (const [label, message, expected] of KNOWN_FAILURES) {
  test(`a failed startvm (${label}) shows an explanation, then the VBoxManage text, in the Log`, t => {
    const {engine, node, image, log} = setup(t, {failOn: 'startvm', message});
    assert.throws(() => engine.spawnVirtualBox(node, image), error => expected.test(error.message) && !/VBoxManage: error/.test(error.message));
    assert.match(explainVirtualBoxFailure(message), expected);
    const explanation = log.findIndex(line => line.startsWith('# ') && expected.test(line));
    const original = log.findIndex(line => line.includes(message));
    assert.ok(explanation >= 0 && original > explanation, log.join('\n'));
  });
}

test('an unknown failure keeps the VBoxManage error line as the message, and is in the Log', t => {
  const {engine, node, image, log} = setup(t, {failOn: 'modifyvm', message: 'VBoxManage: error: Invalid NIC type (VERR_NOPE)'});
  assert.throws(() => engine.spawnVirtualBox(node, image), {message: 'VirtualBox: Invalid NIC type (VERR_NOPE)'});
  assert.ok(log.some(line => line.includes('Invalid NIC type')));
  assert.equal(explainVirtualBoxFailure('something else'), null);
});

test('a VM that VirtualBox cannot find does not stop the removal of the disk and the folder', t => {
  const {engine, node, image, runtimeDir} = setup(t, {failOn: 'unregistervm', message: 'VBoxManage: error: Could not find a registered machine'});
  const disk = path.join(runtimeDir, 'disk.vdi');
  fs.writeFileSync(disk, 'x');
  image.runFiles = [disk];
  engine.removeVirtualBoxMachine(node, image);
  assert.ok(!fs.existsSync(disk));
});

const host = (hostname, engine, acceleration, running) => ({kind: 'host', id: `id-${hostname}`, hostname, engine, qemuAcceleration: acceleration, machine: running ? {} : null});

test('KVM exclusion: a VirtualBox start names the QEMU/KVM hosts of the same session only', () => {
  const self = host('me', 'vbox', null, false);
  const own = [self, host('syl', 'qemu', 'kvm', true), host('ren', 'qemu', 'kvm', true), host('idle', 'qemu', 'kvm', false), host('tcg', 'qemu', 'tcg', true), {kind: 'switch', machine: {}}];
  assert.equal(kvmExclusion(own, own, self, 'vbox', null).message, 'VirtualBox cannot start while your QEMU hosts use KVM: stop syl, ren first.');
  assert.equal(kvmExclusion(own.filter(item => !['syl', 'ren'].includes(item.hostname)), own, self, 'vbox', null), null, 'TCG and stopped hosts do not conflict');
  assert.equal(kvmExclusion([self, host('vb', 'vbox', null, true)], [self], self, 'vbox', null), null, 'two VirtualBox hosts coexist');
});

test('KVM exclusion: the QEMU/KVM start names the VirtualBox hosts of the same session only', () => {
  const qemu = host('q', 'qemu', 'kvm', false);
  const vb = host('vb', 'vbox', null, true);
  const mine = [qemu, vb];
  assert.equal(kvmExclusion(mine, mine, qemu, 'qemu', 'kvm').message, 'A QEMU/KVM host cannot start while your VirtualBox hosts are running: stop vb first.');
  assert.equal(kvmExclusion(mine, mine, qemu, 'qemu', 'tcg'), null, 'TCG does not use VT-x');
});

test('KVM exclusion: hosts of another session are never named, whatever their number', () => {
  const self = host('me', 'vbox', null, false);
  const ownRunning = host('mine', 'qemu', 'kvm', true);
  const secret = host('secret-host', 'qemu', 'kvm', true);
  const others = [secret, host('other-2', 'qemu', 'kvm', true), host('other-3', 'qemu', 'kvm', true)];
  const leak = text => /secret|other-|id-secret|session|user/i.test(text);
  // Another session only: one fixed sentence, identical for one host or three.
  const one = kvmExclusion([self, secret], [self], self, 'vbox', null);
  const three = kvmExclusion([self, ...others], [self], self, 'vbox', null);
  assert.equal(one.message, BUSY);
  assert.equal(three.message, one.message);
  assert.ok(!leak(one.message));
  // Both: only the own host is named, then the same "try again later", identical for one or three foreign hosts.
  const both = kvmExclusion([self, ownRunning, secret], [self, ownRunning], self, 'vbox', null);
  const bothMany = kvmExclusion([self, ownRunning, ...others], [self, ownRunning], self, 'vbox', null);
  assert.equal(both.message, 'VirtualBox cannot start while your QEMU hosts use KVM: stop mine first, or try again later.');
  assert.equal(bothMany.message, both.message);
  assert.ok(!leak(both.message));
  // The reverse direction.
  const qemu = host('q', 'qemu', 'kvm', false);
  const foreignVbox = host('secret-host', 'vbox', null, true);
  assert.equal(kvmExclusion([qemu, foreignVbox], [qemu], qemu, 'qemu', 'kvm').message, BUSY);
  // Only the administrator's diagnostics carry the names.
  assert.match(both.diagnostics, /secret-host/);
});

test('the refusal reaches the host Log and the error without any foreign name; the details go to the runner journal', () => {
  const lifecycleSource = fs.readFileSync(path.join(__dirname, '..', '..', 'runner', 'node-lifecycle.js'), 'utf8');
  const refuse = lifecycleSource.slice(lifecycleSource.indexOf('function refuseKvmConflict'), lifecycleSource.indexOf('function start('));
  assert.match(refuse, /console\.error\(`\[runner\] admin diagnostics: \$\{conflict\.diagnostics\}`\)/);
  assert.match(refuse, /appendLog\(node, `# \$\{conflict\.message\}`\)/);
  assert.match(refuse, /throw new Error\(conflict\.message\)/);
  assert.ok(!/diagnostics/.test(refuse.replace(/console\.error[^\n]*\n/, '')), 'diagnostics only go to console.error');
});

// A disk.vdi loaded from a session archive has no VirtualBox machine around it (VBX02). The fake VBoxManage models
// the media registry: a differencing disk can only be attached when its parent UUID is registered.
const BASE_UUID = '4d9d2447-07ee-443b-9fd6-3f74435be80a';
const NIL = '00000000-0000-0000-0000-000000000000';
function uuidBytes(text) {
  const g = text.split('-').map(part => Buffer.from(part, 'hex'));
  return Buffer.concat([Buffer.from(g[0]).reverse(), Buffer.from(g[1]).reverse(), Buffer.from(g[2]).reverse(), g[3], g[4]]);
}
function vdi({type, uuid, parent = NIL}) {
  const buffer = Buffer.alloc(512);
  buffer.writeUInt32LE(0xbeda107f, 64); buffer.writeUInt32LE(type, 76); buffer.writeBigUInt64LE(4096n, 368);
  uuidBytes(uuid).copy(buffer, 392); uuidBytes(parent).copy(buffer, 424);
  return buffer;
}
// The base image the fake reaches at imagePath('images/alpine.vdi') = '/images/alpine.vdi': a directory of its own.
function loaded(t, options = {}) {
  const {parent, ...planOptions} = options;
  const ctx = setup(t, {failOn: 'showvminfo', ...planOptions});
  const base = path.join(ctx.dir, 'base.vdi');
  fs.writeFileSync(base, vdi({type: 1, uuid: BASE_UUID}));
  ctx.engine = createVirtualBox({
    runtime: {tempFile: (_, name) => path.join(ctx.runtimeDir, name), appendLog: (_, line) => ctx.log.push(String(line)),
      execLogged: (_, command, args, opts) => { ctx.log.push(`$ ${[command, ...args].join(' ')}`); return require('node:child_process').execFileSync(command, args, opts); }},
    catalog: {imagePath: () => base}, disks: {cleanupRunFiles() {}}, commands: {VBOXMANAGE: path.join(ctx.dir, 'VBoxManage')},
    session: {nodes: new Map()}
  });
  const disk = path.join(ctx.runtimeDir, 'disk.vdi');
  fs.writeFileSync(disk, vdi({type: 4, uuid: '0a19a6ce-c842-4786-bd8b-e0a78f4802c5', parent: parent || BASE_UUID}));
  return {...ctx, base, disk, registry: () => (fs.existsSync(path.join(ctx.dir, 'registry.json')) ? JSON.parse(fs.readFileSync(path.join(ctx.dir, 'registry.json'), 'utf8')) : {})};
}

test('a machine that exists is left alone', t => {
  const {engine, node, image, calls, runtimeDir} = setup(t);
  fs.writeFileSync(path.join(runtimeDir, 'disk.vdi'), 'loaded');
  engine.ensureVirtualBoxMachine(node, image);
  assert.deepEqual(calls(), [['showvminfo', 'qw-test', '--machinereadable']]);
});

test('a loaded disk gets a new machine: the base is registered through a probe (checked), the disk attached, the probe closed, not started', t => {
  const {engine, node, image, calls, disk, base, runtimeDir, registry} = loaded(t, {nodeOptions: {guestIsoAttached: true, guestIso: '/tmp/startup.iso'}});
  engine.ensureVirtualBoxMachine(node, image);
  const probe = path.join(runtimeDir, 'parent-probe.vdi');
  assert.deepEqual(calls().map(args => args[0] === 'internalcommands' ? args.slice(0, 2).join(' ') : args[0] === 'list' ? 'list hdds' : args[0]),
    ['showvminfo', 'internalcommands sethduuid', 'createmedium', 'list hdds', 'createvm', 'modifyvm', 'storagectl', 'storageattach', 'storagectl', 'modifyvm', 'closemedium']);
  const all = calls();
  assert.deepEqual(all[1], ['internalcommands', 'sethduuid', disk], 'only the node\'s own disk file gets a new identity');
  assert.deepEqual(all[2], ['createmedium', 'disk', '--filename', probe, '--diffparent', base, '--format', 'VDI']);
  assert.deepEqual(all[10], ['closemedium', 'disk', probe]);
  assert.ok(all.every(args => args[0] !== 'startvm' && args[0] !== 'openmedium'), 'no start; the registry does not depend on openmedium');
  assert.deepEqual(all[7], ['storageattach', 'qw-test', '--storagectl', 'SATA', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', disk]);
  assert.ok(!all.some(args => args.includes('dvddrive')), 'the startup CD-ROM is attached by the start path, not here');
  assert.ok(!all.flat().includes('--delete'));
  assert.ok(fs.existsSync(disk), 'the loaded disk is kept');
  assert.ok(!fs.existsSync(probe), 'the probe file is removed');
  assert.equal(registry()[base].uuid, BASE_UUID, 'the base stays registered for the attached disk');
  assert.equal(registry()[probe], undefined, 'the probe is closed');
});

test('REGRESSION (found on a real machine): a base that is not in the media registry made the attach fail with "Parent medium ... is not found"', t => {
  // What the first version did: openmedium of the base, failure ignored. On the user's machine it left the registry empty.
  const {node, image, ctx, base, disk, dir, runtimeDir} = (() => { const c = loaded(t, {}); return {...c, ctx: c}; })();
  const bin = path.join(dir, 'VBoxManage');
  const run = args => require('node:child_process').execFileSync(bin, args, {stdio: 'pipe'});
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({failOn: null, openmediumRegisters: false}));
  run(['openmedium', 'disk', base]);
  assert.deepEqual(ctx.registry(), {}, 'the openmedium that did nothing');
  assert.throws(() => run(['storageattach', 'x', '--storagectl', 'SATA', '--type', 'hdd', '--medium', disk]),
    error => error.stderr.toString().includes(`Parent medium with UUID {${BASE_UUID}} of the medium '${disk}' is not found in the media registry`));
  // The fix does not depend on it.
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({failOn: 'showvminfo', openmediumRegisters: false}));
  ctx.engine.ensureVirtualBoxMachine(node, image);
  assert.equal(ctx.registry()[base].uuid, BASE_UUID, 'the base is registered and the saved disk attached to it');
  assert.ok(fs.existsSync(disk) && runtimeDir);
});

test('the base is checked in the registry: if VirtualBox does not list it, the message names the base image and the machine is cleaned up', t => {
  const {engine, node, image, calls, disk} = loaded(t, {listEmpty: true});
  assert.throws(() => engine.ensureVirtualBoxMachine(node, image),
    new RegExp(`Cannot attach the saved VirtualBox disk: VirtualBox did not register the base image base\\.vdi \\(UUID ${BASE_UUID}\\)\\. Use Reset`));
  assert.ok(!calls().some(args => args[0] === 'createvm'), 'nothing was created around an unusable disk');
  assert.ok(fs.existsSync(disk));
});

test('a saved disk whose parent is another build of the base image is refused plainly, before anything is created', t => {
  const {engine, node, image, calls, disk} = loaded(t, {parent: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'});
  assert.throws(() => engine.ensureVirtualBoxMachine(node, image),
    /The saved VirtualBox disk belongs to another build of the base image \(its parent is aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee, the base image is 4d9d2447-07ee-443b-9fd6-3f74435be80a\)\. Use Reset/);
  assert.deepEqual(calls().map(args => args[0]), ['showvminfo']);
  assert.ok(fs.existsSync(disk));
});

test('a file that is not a VDI is reported as unreadable', t => {
  const {engine, node, image, disk} = loaded(t);
  fs.writeFileSync(disk, 'not a vdi');
  assert.throws(() => engine.ensureVirtualBoxMachine(node, image), /Cannot read the saved VirtualBox disk or its base image: Not a VDI file\. Use Reset/);
});

test('when the machine cannot be created around a loaded disk, the machine and the probe go, the disk stays, and the message says how to recover', t => {
  for (const step of ['internalcommands', 'createmedium', 'createvm', 'storageattach']) {
    const {engine, node, image, calls, runtimeDir, disk} = loaded(t, {failOn: ['showvminfo', step], message: 'VBoxManage: error: Cannot register the medium'});
    assert.throws(() => engine.ensureVirtualBoxMachine(node, image), error => /Cannot attach the saved VirtualBox disk/.test(error.message) && /Use Reset/.test(error.message), step);
    assert.ok(calls().some(args => args[0] === 'unregistervm' && args.length === 2), `${step}: the machine is unregistered, without --delete`);
    assert.ok(!calls().flat().includes('--delete'), step);
    assert.ok(fs.existsSync(disk), `${step}: the saved disk stays in the node directory`);
    assert.ok(!fs.existsSync(path.join(runtimeDir, 'vbox-vm')), `${step}: the VM folder is removed`);
    assert.ok(!fs.existsSync(path.join(runtimeDir, 'parent-probe.vdi')), `${step}: the probe file is removed`);
    assert.ok(calls().filter(args => args[0] === 'closemedium').every(args => args[2].endsWith('parent-probe.vdi')), `${step}: only the probe is closed, never the disk or the base`);
  }
});

test('without the disk file there is nothing to attach', t => {
  const {engine, node, image, calls} = setup(t, {failOn: 'showvminfo'});
  assert.throws(() => engine.ensureVirtualBoxMachine(node, image), /The current host disk was not found/);
  assert.deepEqual(calls().map(args => args[0]), ['showvminfo']);
});

test('removing a machine can be given the disk to remove explicitly, still only inside the run directory', t => {
  const {engine, node, image, calls, runtimeDir, dir} = setup(t);
  const inside = path.join(runtimeDir, 'disk.vdi'), outside = path.join(dir, 'other.vdi');
  fs.writeFileSync(inside, 'x'); fs.writeFileSync(outside, 'x');
  engine.removeVirtualBoxMachine(node, {...image, runFiles: []}, {files: [inside, outside]});
  assert.ok(!fs.existsSync(inside));
  assert.ok(fs.existsSync(outside), 'a file outside the run directory is never removed');
  assert.ok(!calls().flat().includes('--delete'));
});
