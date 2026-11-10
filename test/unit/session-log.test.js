const assert = require('node:assert/strict');
const test = require('node:test');

const sessionLog = require('../../public/session-log');

test('session logs replay as terminal lines and refresh after appends', () => {
  const machine = {logs: ['QEMU started']};
  assert.equal(sessionLog.terminalText(machine), 'QEMU started\r\n');
  sessionLog.append(machine, 'monitor: info status');
  assert.equal(sessionLog.terminalText(machine), 'QEMU started\r\nmonitor: info status\r\n');
});

test('session log reset clears the replay buffer and empty logs show a placeholder', () => {
  const machine = {logs: ['old entry']};
  sessionLog.reset(machine);
  assert.deepEqual(machine.logs, []);
  assert.equal(sessionLog.terminalText(machine), 'No session log entries yet.\r\n');
});

test('session log history remains bounded to the newest entries', () => {
  const machine = {logs: ['one', 'two']};
  sessionLog.append(machine, 'three', 2);
  assert.deepEqual(machine.logs, ['two', 'three']);
});
