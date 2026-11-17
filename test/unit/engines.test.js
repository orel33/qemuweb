'use strict';

// Which engines a runner can run, from its resolved commands (runner/preflight.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const {availableEngines} = require('../../runner/preflight');

test('QEMU needs its emulator and its disk tool, VirtualBox needs VBoxManage', () => {
  assert.deepEqual(availableEngines({QEMU_SYSTEM_X86_64: '/bin/qemu', QEMU_IMG: '/bin/qemu-img'}), ['qemu']);
  assert.deepEqual(availableEngines({QEMU_SYSTEM_X86_64: '/bin/qemu', QEMU_IMG: '/bin/qemu-img', VBOXMANAGE: '/bin/vbox'}), ['qemu', 'vbox']);
  assert.deepEqual(availableEngines({QEMU_SYSTEM_X86_64: null, QEMU_IMG: null, VBOXMANAGE: '/bin/vbox'}), ['vbox']);
  assert.deepEqual(availableEngines({QEMU_SYSTEM_X86_64: '/bin/qemu', QEMU_IMG: null}), []);
  assert.deepEqual(availableEngines({}), []);
});
