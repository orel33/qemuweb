'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {baseNodeId, consoleChannel, consoleId} = require('../../common/console-id');

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

test('consoleChannel rejects malformed or unsupported IDs', () => {
  for (const id of [`${host}:2`, `${host}:`, `${host}:01`, `${host}:1:1`, 'h-xyz', '', null, 42]) {
    assert.equal(consoleChannel(id), null, String(id));
  }
});
