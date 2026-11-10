const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {parseTopology, formatTopology} = require('../../topology');

test('example topologies preserve ordered links on roundtrip', () => {
  for (const file of ['topo/lan.topo', 'topo/gw.topo']) {
    const first = parseTopology(fs.readFileSync(file, 'utf8'), ['debian13-legacy']);
    assert.deepEqual(parseTopology(formatTopology(first), ['debian13-legacy']), first);
  }
});

test('invalid links, duplicate names, unsupported directives and unresolved systems are rejected', () => {
  const systems = ['debian13-legacy'];
  assert.throws(() => parseTopology('SWITCH s1\nHOST debian13-legacy h1 missing', systems), /unknown switch/);
  assert.throws(() => parseTopology('SWITCH s1\nSWITCH s1', systems), /duplicate/);
  assert.throws(() => parseTopology('EXEC rm -rf /', systems), /unsupported/);
  assert.throws(() => parseTopology('HOST debian h1', systems), /Unknown system IDs/);
  assert.throws(() => parseTopology('HOST debian h1', systems, {debian: 'debian13-legacy'}), /Unknown system IDs/);
});
