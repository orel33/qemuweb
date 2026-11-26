'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {entityKind, newEntityId} = require('../../common/node-id');

test('new node IDs round-trip through entityKind', () => {
  const host = newEntityId('host');
  const sw = newEntityId('switch');
  assert.match(host, /^h-[0-9a-f]{8}$/);
  assert.match(sw, /^s-[0-9a-f]{8}$/);
  assert.equal(entityKind(host), 'host');
  assert.equal(entityKind(sw), 'switch');
  assert.notEqual(newEntityId('host'), newEntityId('host'));
});

test('a new node ID is never one of the IDs already used', () => {
  const crypto = require('node:crypto');
  const original = crypto.randomBytes;
  const draws = [Buffer.from('0000000a', 'hex'), Buffer.from('0000000a', 'hex'), Buffer.from('0000000b', 'hex')];
  crypto.randomBytes = () => draws.shift();
  try { assert.equal(newEntityId('host', new Set(['h-0000000a'])), 'h-0000000b', 'the taken ID is drawn again'); }
  finally { crypto.randomBytes = original; }
  assert.equal(draws.length, 0);
});

test('entityKind rejects malformed IDs and unexpected kinds', () => {
  assert.throws(() => entityKind('h-xyz'), /Invalid host or switch ID/);
  assert.throws(() => entityKind('h-0123456789abcdef'), /8 lowercase hex characters/, 'the 16-character IDs of earlier versions');
  assert.throws(() => entityKind('h-0123ABCD'), /Invalid host or switch ID/);
  assert.throws(() => entityKind(42), /Invalid host or switch ID/);
  assert.throws(() => entityKind(newEntityId('host'), 'switch'), /Expected a switch ID/);
  assert.equal(entityKind(newEntityId('switch'), 'switch'), 'switch');
});
