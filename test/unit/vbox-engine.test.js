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
if (args[0] === 'createmedium') fs.writeFileSync(args[args.indexOf('--filename') + 1], 'diff');
if (plan.failOn === args[0] && (!plan.failOnce || !fs.existsSync(path.join(dir, 'failed')))) {
  fs.writeFileSync(path.join(dir, 'failed'), '');
  process.stderr.write(plan.message + '\\n');
  process.exit(1);
}
`;

function setup(t, {failOn = null, message = '', failOnce = false, nodeOptions = {}} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-vbox-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const bin = path.join(dir, 'VBoxManage');
  fs.writeFileSync(bin, FAKE, {mode: 0o755});
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({failOn, message, failOnce}));
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
