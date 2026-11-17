'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {baseNodeId, consoleChannel, consoleId, portChannel, portName, validatePorts, PORTS} = require('../../common/console-id');

const host = 'h-0123456789abcdef';

test('channel 0 console ID is the node ID, channel 1 appends :1', () => {
  assert.equal(consoleId(host), host);
  assert.equal(consoleId(host, 0), host);
  assert.equal(consoleId(host, 1), `${host}:1`);
  assert.throws(() => consoleId(host, 2), /Invalid console channel/);
  assert.throws(() => consoleId(host, -1), /Invalid console channel/);
});

test('baseNodeId and consoleChannel parse console IDs', () => {
  assert.equal(baseNodeId(host), host);
  assert.equal(baseNodeId(`${host}:1`), host);
  assert.equal(consoleChannel(host), 0);
  assert.equal(consoleChannel(`${host}:1`), 1);
  assert.equal(consoleChannel('s-0123456789abcdef'), 0);
});

test('port names and channel indexes map to each other', () => {
  assert.deepEqual(PORTS, ['ttyS0', 'ttyS1']);
  assert.equal(portChannel('ttyS0'), 0);
  assert.equal(portChannel('ttyS1'), 1);
  for (const name of ['ttyS2', 'ttyUSB0', '', null, 1]) assert.equal(portChannel(name), null, String(name));
  assert.equal(portName(0), 'ttyS0');
  assert.equal(portName(1), 'ttyS1');
  for (const channel of [-1, 2, 0.5, '1', null]) assert.equal(portName(channel), null, String(channel));
});

test('validatePorts requires a contiguous prefix starting with ttyS0, within the system limit', () => {
  assert.deepEqual(validatePorts(['ttyS0']), ['ttyS0']);
  assert.deepEqual(validatePorts(['ttyS0', 'ttyS1']), ['ttyS0', 'ttyS1']);
  for (const bad of [['ttyS1'], ['ttyS0', 'ttyS0'], ['ttyS0', 'ttyS2'], ['ttyS1', 'ttyS0'], ['ttyS0', 'ttyS1', 'ttyS2'], [], 'ttyS0', null]) {
    assert.throws(() => validatePorts(bad), /Serial ports must be a list starting with ttyS0/, JSON.stringify(bad));
  }
  assert.throws(() => validatePorts(['ttyS0', 'ttyS1'], ['ttyS0']), /This system exposes only ttyS0\./);
  assert.doesNotThrow(() => validatePorts(['ttyS0'], ['ttyS0', 'ttyS1']));
});

test('consoleChannel rejects malformed or unsupported IDs', () => {
  for (const id of [`${host}:2`, `${host}:`, `${host}:01`, `${host}:1:1`, 'h-xyz', '', null, 42]) {
    assert.equal(consoleChannel(id), null, String(id));
  }
});
