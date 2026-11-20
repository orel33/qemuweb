'use strict';

// The whole VirtualBox start of a host loaded from a session ZIP (VBX02), from Resume all to startvm, through the real
// runner (runner/node-lifecycle.js, runner/engines/vbox.js) and the FAKE VBoxManage of test/unit/vbox-fake.js, which
// models the media registry, the machines, their storage slots and the startup files. Two failures met on a real machine are
// reproduced here: "Parent medium ... is not found in the media registry" (the base image was not registered) and "No
// storage device attached to device slot 0 on port 1 of controller 'Guest setup'" (a detach of a DVD drive that was never created).
// Every call, in order, with its precondition:
//   showvminfo                   the machine is not registered yet (a runner never saw this ZIP's disk)
//   internalcommands sethduuid   the saved disk.vdi is in the node directory
//   createmedium --diffparent    registers the base image (probe in the node directory)
//   list hdds                    the base UUID is registered
//   createvm, modifyvm           the machine exists, then memory, cpus, NICs, serial port
//   storagectl SATA              the machine exists
//   storageattach hdd            controller SATA exists; the parent of the disk is registered
//   storagectl 'Guest setup'     the machine exists
//   storageattach dvddrive       controller 'Guest setup' exists; creates the drive, with the ISO or emptydrive
//   modifyvm --boot*             the machine exists
//   closemedium (probe)          the probe is registered; the attached disk keeps the base registered
//   showvminfo                   the machine is powered off
//   modifyvm                     the settings of this start (a machine created just before it skips the next step)
//   storageattach dvddrive       (machine that existed) the drive exists: new ISO or emptydrive
//   startvm                      boot disk attached, every medium file exists
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createSessionRunner} = require('../../runner/session-runner');
const {Session} = require('../../runner/session');
const {createSessionSnapshot} = require('../../runner/archive-snapshot');
const {installFake, vdi, BASE_UUID} = require('./vbox-fake');

const projectRoot = path.join(__dirname, '..', '..');
const HOST = 'h-0000000000000001';
const CHILD_UUID = '0a19a6ce-c842-4786-bd8b-e0a78f4802c5';

function setup(t, {startupDiskEnabled}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-vbox-resume-'));
  const root = path.join(dir, 'project');
  fs.mkdirSync(path.join(root, 'images'), {recursive: true});
  fs.copyFileSync(path.join(projectRoot, 'config.json'), path.join(root, 'config.json'));
  fs.writeFileSync(path.join(root, 'images', 'debian13-legacy.raw'), 'raw');
  fs.writeFileSync(path.join(root, 'images', 'debian13-legacy.vdi'), vdi({type: 1, uuid: BASE_UUID}));
  const fake = installFake(dir, {modelVms: true});
  const geniso = path.join(dir, 'genisoimage');
  fs.writeFileSync(geniso, `#!${process.execPath}\nconst a = process.argv.slice(2); require('fs').writeFileSync(a[a.indexOf('-o') + 1], 'iso');\n`, {mode: 0o755});
  const session = new Session({runtimeRoot: path.join(dir, 'runtime'), id: '0000000000000001', engine: 'qemu'});
  fs.mkdirSync(session.runtimeDir, {recursive: true});
  const commands = {VBOXMANAGE: fake.bin, GENISOIMAGE: geniso};
  const runner = createSessionRunner({session, commands, root, runtimeRoot: path.join(dir, 'runtime'), configPath: path.join(root, 'config.json')});
  const snapshot = createSessionSnapshot({session, runner, commands, emit() {}});
  t.after(() => { runner.stopResourceSampling(); fs.rmSync(dir, {recursive: true, force: true}); });

  // A ZIP saved with the disks of both engines, extracted, then loaded under VirtualBox.
  const stage = fs.mkdtempSync(path.join(dir, 'stage-'));
  fs.mkdirSync(path.join(stage, HOST, 'startup'), {recursive: true});
  fs.writeFileSync(path.join(stage, 'session.json'), JSON.stringify({schemaVersion: 1, engine: 'vbox', hosts: [HOST], switches: []}));
  fs.writeFileSync(path.join(stage, HOST, 'startup', 'start.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(stage, HOST, 'host.json'), JSON.stringify({schemaVersion: 2, id: HOST, name: 'syl', system: 'debian13-legacy',
    config: startupDiskEnabled ? {startupDiskEnabled: true} : {}, network: {interfaces: [{switchId: null, port: null, mac: '02:00:00:00:00:01'}]}}));
  fs.writeFileSync(path.join(stage, HOST, 'disk.qcow2'), 'qcow2');
  fs.writeFileSync(path.join(stage, HOST, 'disk.vdi'), vdi({type: 4, uuid: CHILD_UUID, parent: BASE_UUID}));
  snapshot.installArchive(snapshot.archivedSessionFiles(stage, ['session.json', `${HOST}/host.json`, `${HOST}/startup/start.sh`, `${HOST}/disk.qcow2`, `${HOST}/disk.vdi`]), stage);
  const node = runner.getNode(HOST);
  const start = () => {
    const started = runner.start(HOST, 'vbox', 'debian13-legacy', {interfaces: [null]});
    started.generation++; // the console connection attempts end here
    return started;
  };
  const names = from => fake.calls().slice(from).map(args => (args[0] === 'internalcommands' ? args.slice(0, 2).join(' ') : args[0] === 'list' ? 'list hdds' : args[0]));
  return {runner, node, fake, start, names, dir};
}

const DVD = (vm, medium) => ['storageattach', vm, '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', medium];

test('Resume all of a loaded host with a startup disk: the machine is created around the saved disk, the base registered, the ISO in the DVD drive, then startvm', t => {
  const {node, fake, start, names} = setup(t, {startupDiskEnabled: true});
  assert.equal(node.everStarted, true);
  assert.equal(node.runDisk, path.join(node.runtimeDir, 'disk.vdi'));
  node.activeGuestIso = '/gone/startup-from-the-qemu-start.iso'; // what a start under QEMU leaves behind
  start();
  assert.deepEqual(names(0), ['showvminfo', 'internalcommands sethduuid', 'createmedium', 'list hdds', 'createvm', 'modifyvm', 'storagectl', 'storageattach',
    'storagectl', 'storageattach', 'modifyvm', 'closemedium', 'showvminfo', 'modifyvm', 'startvm']);
  const calls = fake.calls();
  assert.deepEqual(calls[9], DVD(node.vmName, node.guestIso), 'the drive is created with this start\'s ISO');
  assert.ok(fs.existsSync(node.guestIso));
  assert.ok(!calls.some(args => args[0] === 'storageattach' && args[args.indexOf('--medium') + 1] === 'none'), 'no detach with --medium none');
  assert.ok(!calls.flat().includes('--delete'));
  const state = fake.state();
  assert.equal(state.vms[node.vmName].started, true);
  assert.equal(state.vms[node.vmName].slots['Guest setup|1|0'].medium, node.guestIso);
  assert.equal(Object.values(state.registry).filter(m => m.uuid === BASE_UUID).length, 1, 'the base stays registered');
  assert.ok(!fs.existsSync(path.join(node.runtimeDir, 'parent-probe.vdi')));
  assert.ok(fs.existsSync(path.join(node.runtimeDir, 'disk.qcow2')), 'the QEMU disk is untouched');
});

test('the same without startup disk: the DVD drive is created empty', t => {
  const {node, fake, start, names} = setup(t, {startupDiskEnabled: false});
  start();
  assert.equal(names(0).filter(name => name === 'storageattach').length, 2, 'the disk and the DVD drive');
  assert.deepEqual(fake.calls().filter(args => args.includes('dvddrive')), [DVD(node.vmName, 'emptydrive')]);
  assert.equal(names(0).at(-1), 'startvm');
});

test('a second start of the same host (machine registered): the drive medium is replaced or emptied, never detached', async t => {
  const {runner, node, fake, start, names} = setup(t, {startupDiskEnabled: true});
  start();
  await runner.stop(node);
  const before = fake.calls().length;
  const firstIso = node.guestIso;
  start();
  assert.deepEqual(names(before), ['showvminfo', 'showvminfo', 'modifyvm', 'storageattach', 'startvm']);
  const second = fake.calls().slice(before)[3];
  assert.deepEqual(second, DVD(node.vmName, node.guestIso));
  assert.notEqual(node.guestIso, firstIso, 'a new ISO each start');
  // The startup disk switched off: the same slot is emptied with emptydrive.
  await runner.stop(node);
  node.guestIsoAttached = false;
  const again = fake.calls().length;
  start();
  assert.deepEqual(fake.calls().slice(again).filter(args => args[0] === 'storageattach'), [DVD(node.vmName, 'emptydrive')]);
});

test('REGRESSION (real machine): a detach with --medium none of a DVD drive that was never created fails; the start path no longer does it', t => {
  const {fake} = setup(t, {startupDiskEnabled: true});
  const {execFileSync} = require('node:child_process');
  execFileSync(fake.bin, ['createvm', '--name', 'm', '--basefolder', '/x', '--ostype', 'Linux_64', '--register']);
  execFileSync(fake.bin, ['storagectl', 'm', '--name', 'Guest setup', '--add', 'ide', '--controller', 'PIIX4']);
  assert.throws(() => execFileSync(fake.bin, ['storageattach', 'm', '--storagectl', 'Guest setup', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', 'none'], {stdio: 'pipe'}),
    error => error.stderr.toString().includes("No storage device attached to device slot 0 on port 1 of controller 'Guest setup'"));
});

test('a registry that forgot the base is not a problem: the base is registered again before the disk is attached', t => {
  const {node, fake, start} = setup(t, {startupDiskEnabled: true});
  fake.setPlan({modelVms: true, openmediumRegisters: false}); // openmedium would do nothing, the start never calls it
  start();
  assert.ok(!fake.calls().some(args => args[0] === 'openmedium'));
  assert.equal(fake.state().vms[node.vmName].started, true);
});
