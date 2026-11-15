'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {entityKind, newEntityId} = require('../../common/node-id');

test('new node IDs round-trip through entityKind', () => {
  const host = newEntityId('host');
  const sw = newEntityId('switch');
  assert.match(host, /^h-[0-9a-f]{16}$/);
  assert.match(sw, /^s-[0-9a-f]{16}$/);
  assert.equal(entityKind(host), 'host');
  assert.equal(entityKind(sw), 'switch');
  assert.notEqual(newEntityId('host'), newEntityId('host'));
});

test('entityKind rejects malformed IDs and unexpected kinds', () => {
  assert.throws(() => entityKind('h-xyz'), /Invalid host or switch ID/);
  assert.throws(() => entityKind(42), /Invalid host or switch ID/);
  assert.throws(() => entityKind(newEntityId('host'), 'switch'), /Expected a switch ID/);
  assert.equal(entityKind(newEntityId('switch'), 'switch'), 'switch');
});
