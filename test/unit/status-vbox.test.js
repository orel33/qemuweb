'use strict';

// scripts/status.sh and VirtualBox hosts: the pure parts of scripts/status-vbox.js with the real
// `ps` lines of a QemuWeb runner (pid 1478098) running two VirtualBox hosts, and a VM of the
// user's own that must never be shown.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {defaultRuntime} = require('../../common/runtime-dir');
const {parseVBoxHeadless, vboxProcessesOf, runnerSessionsDir, memoryFromShowVmInfo, hostMemoryMb, hostTag, readVirtualBoxMemory} = require('../../scripts/status-vbox');

const HEADLESS_1 = '/usr/lib/virtualbox/VBoxHeadless --comment qemuweb-1478098-7535bdff74b4f486-h-d1cacd841664407c --startvm a34c81c3-5414-4b9f-810d-6d999d37b156 --vrde config';
const HEADLESS_2 = '/usr/lib/virtualbox/VBoxHeadless --comment qemuweb-1478098-7535bdff74b4f486-h-c0abdd91a8684ce2 --startvm af201149-3b0b-4df8-bf06-7b463909c3fa --vrde config';
const FOREIGN = '/usr/lib/virtualbox/VBoxHeadless --comment My Ubuntu --startvm 11111111-2222-3333-4444-555555555555 --vrde config';
const OTHER_RUNNER = '/usr/lib/virtualbox/VBoxHeadless --comment qemuweb-999-7535bdff74b4f486-h-aaaaaaaaaaaaaaaa --startvm 22222222-2222-3333-4444-555555555555 --vrde config';

test('a QemuWeb VBoxHeadless command line gives its VM name, uuid, runner, session and node', () => {
  assert.deepEqual(parseVBoxHeadless(HEADLESS_1), {name: 'qemuweb-1478098-7535bdff74b4f486-h-d1cacd841664407c', uuid: 'a34c81c3-5414-4b9f-810d-6d999d37b156',
    runnerPid: 1478098, sessionId: '7535bdff74b4f486', nodeId: 'h-d1cacd841664407c'});
  assert.equal(parseVBoxHeadless(HEADLESS_2).nodeId, 'h-c0abdd91a8684ce2');
});

test('the VirtualBox daemon, the user\'s own VMs and other programs are never QemuWeb hosts', () => {
  assert.equal(parseVBoxHeadless('/usr/lib/virtualbox/VBoxSVC --auto-shutdown --inherit-startup-pipe 6'), null);
  assert.equal(parseVBoxHeadless(FOREIGN), null, 'a VM named "My Ubuntu"');
  assert.equal(parseVBoxHeadless('/usr/lib/virtualbox/VBoxHeadless --startvm 11111111-2222-3333-4444-555555555555'), null, 'no --comment');
  assert.equal(parseVBoxHeadless('/usr/lib/virtualbox/VBoxHeadless --comment qemuweb-12-notasession-h-d1cacd841664407c --startvm x'), null, 'a malformed name');
  assert.equal(parseVBoxHeadless('/usr/bin/vim --comment qemuweb-1478098-7535bdff74b4f486-h-d1cacd841664407c'), null, 'another program');
  assert.equal(parseVBoxHeadless('[iprt-VBoxTscThread]'), null);
});

test('the VMs of a runner are those whose name carries its pid; the others are left out', () => {
  const entries = [HEADLESS_1, HEADLESS_2, FOREIGN, OTHER_RUNNER].map((args, index) => ({pid: 100 + index, args, vbox: parseVBoxHeadless(args)}));
  assert.deepEqual(vboxProcessesOf(entries, 1478098).map(entry => entry.pid), [100, 101]);
  assert.deepEqual(vboxProcessesOf(entries, 999).map(entry => entry.pid), [103]);
  assert.deepEqual(vboxProcessesOf(entries, 5), []);
});

test('the sessions directory of a runner: --runtime, the socket it dials, else the default directory of its port', () => {
  assert.equal(runnerSessionsDir('node /p/runner/main.js --runtime /data/rt --port 3002'), '/data/rt/sessions');
  assert.equal(runnerSessionsDir('node runner/main.js --connect /srv/rt/runner-3002.sock'), '/srv/rt/sessions');
  assert.equal(runnerSessionsDir('node /p/runner/main.js --port 3002'), path.join(defaultRuntime(3002), 'sessions'));
  assert.equal(runnerSessionsDir('node /p/runner/main.js --port 3010'), path.join(defaultRuntime(3010), 'sessions'));
});

test('the host line of a VirtualBox VM mirrors QEMU: the same tag position, the memory in MB', () => {
  const vbox = {args: HEADLESS_1, vbox: {...parseVBoxHeadless(HEADLESS_1), memoryMb: 512}};
  const qemu = {args: '/usr/bin/qemu-system-x86_64 -machine q35 -m 1024 -smp 1', vbox: null};
  assert.equal(hostTag(vbox), 'host (vbox)');
  assert.equal(hostTag(qemu), 'host (qemu)');
  assert.equal(hostTag(vbox).length, hostTag(qemu).length, 'same width, same column');
  assert.equal(hostMemoryMb(vbox), 512);
  assert.equal(hostMemoryMb(qemu), 1024);
  assert.equal(hostMemoryMb({args: HEADLESS_1, vbox: {memoryMb: null}}), null);
  assert.equal(hostMemoryMb({args: '/usr/bin/vde_switch -s x', vbox: null}), null);
});

test('the configured memory comes from showvminfo, read once per VM, and an unavailable VBoxManage is not an error', () => {
  assert.equal(memoryFromShowVmInfo('name="x"\nmemory=512\ncpus=1\n'), 512);
  assert.equal(memoryFromShowVmInfo('nothing'), null);
  let calls = 0;
  const run = () => { calls++; return 'memory=256\n'; };
  assert.equal(readVirtualBoxMemory('uuid-a', run), 256);
  assert.equal(readVirtualBoxMemory('uuid-a', run), 256);
  assert.equal(calls, 1);
  assert.equal(readVirtualBoxMemory('uuid-b', () => { throw new Error('no VBoxManage'); }), null);
});

test('status.js finds the VMs through the runner pid, counts them as hosts and never starts or changes anything', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'status.js'), 'utf8');
  assert.match(source, /vboxProcessesOf\(table\.values\(\), runner\.pid\)/);
  assert.match(source, /item\.vbox \|\| \/qemu-system\//, 'a VM counts as a host');
  assert.match(source, /hostTag\(qemu\)\.padEnd\(12\)/);
  const vboxCalls = source.match(/execFileSync\('VBoxManage'[^)]*\)/g) || [];
  assert.deepEqual(vboxCalls.map(call => /'showvminfo'/.test(call)), [true], 'the only VBoxManage call is showvminfo');
  for (const name of ['startvm', 'controlvm', 'unregistervm', 'closemedium', '--delete']) assert.ok(!source.includes(name), name);
});
