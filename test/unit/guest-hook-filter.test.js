'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {filterGuestHookSerial, plainSerialLine} = require('../../runner/console/guest-hook-filter');

const freshNode = () => ({serialFilterPending: '', serialFilterPassThrough: false});

test('startup hook markers are hidden while other serial output passes through', () => {
  const node = freshNode();
  const output = filterGuestHookSerial(node, 'hello\nQEMUWEB_START_BEGIN /mnt/cdrom/start.sh\nworld\nQEMUWEB_START_EXIT 0\n');
  assert.equal(output, 'hello\nworld\n');
});

test('timestamped and service-prefixed marker lines are hidden', () => {
  const node = freshNode();
  assert.equal(filterGuestHookSerial(node, '[    9.1] qemuweb-guest-start[123]: QEMUWEB_START_EXIT 0\nlogin: '), 'login: ');
});

test('markers split across chunks are still hidden', () => {
  const node = freshNode();
  const first = filterGuestHookSerial(node, 'QEMUWEB_START_');
  const second = filterGuestHookSerial(node, 'BEGIN x\nprompt# ');
  assert.equal(first + second, 'prompt# ');
});

test('carriage returns and terminal controls do not wait for a newline', () => {
  const node = freshNode();
  assert.equal(filterGuestHookSerial(node, '\r'), '\r');
  assert.equal(filterGuestHookSerial(node, '\x1b[0m'), '\x1b[0m');
});

test('plainSerialLine strips ANSI sequences and carriage returns', () => {
  assert.equal(plainSerialLine('\x1b[1;32mok\x1b[0m\r'), 'ok');
});
