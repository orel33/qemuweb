'use strict';

// The addresses a guest reports (common/guest-addresses.js): validation of untrusted data, bounds and the
// match with the NICs of a node, from the real replies recorded in the GAG01 study and from forged ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const {LIMITS, cleanAddress, parseGuestInterfaces, matchAddresses, sameAddresses} = require('../../common/guest-addresses');
const fixtures = require('../fixtures/guest-agent-replies');

const nics = [{mac: '52:54:00:aa:bb:01'}, {mac: '52:54:00:aa:bb:02'}];

test('the real Debian reply gives the address with its prefix on the NIC that owns the MAC', () => {
  assert.deepEqual(matchAddresses(parseGuestInterfaces(fixtures.debianLegacy), nics), {0: ['10.1.2.3/24']});
});

test('loopback and IPv6 link-local are dropped, a global IPv6 address is kept after the IPv4 one', () => {
  assert.deepEqual(matchAddresses(parseGuestInterfaces(fixtures.debianCloudDhcp), [{mac: '52:54:00:12:34:56'}]), {0: ['10.0.2.15/24', 'fec0::5054:ff:fe12:3456/64']});
  assert.deepEqual(matchAddresses(parseGuestInterfaces(fixtures.openwrtBare), nics), {}, 'a link-local address alone shows nothing');
});

test('a changed address replaces the old one (Alpine after ip addr add and del)', () => {
  assert.deepEqual(matchAddresses(parseGuestInterfaces(fixtures.alpineChanged), [{mac: '52:54:00:12:34:56'}]), {0: ['192.168.7.9/28']});
});

test('the MAC is the key; the name ethN is the fallback only when no interface claims that NIC by MAC', () => {
  const guest = [{name: 'eth1', 'hardware-address': '52:54:00:aa:bb:01', 'ip-addresses': [{'ip-address-type': 'ipv4', 'ip-address': '10.0.0.1', prefix: 24}]}];
  assert.deepEqual(matchAddresses(parseGuestInterfaces(guest), nics), {0: ['10.0.0.1/24']}, 'the MAC wins over the name eth1');
  const renamed = [{name: 'eth1', 'hardware-address': '02:00:00:00:00:99', 'ip-addresses': [{'ip-address-type': 'ipv4', 'ip-address': '10.0.0.2', prefix: 24}]}];
  assert.deepEqual(matchAddresses(parseGuestInterfaces(renamed), nics), {1: ['10.0.0.2/24']}, 'unknown MAC: the name decides');
  const both = [...parseGuestInterfaces(guest), ...parseGuestInterfaces([{name: 'eth0', 'hardware-address': '02:00:00:00:00:98', 'ip-addresses': [{'ip-address-type': 'ipv4', 'ip-address': '10.0.0.3', prefix: 24}]}])];
  assert.deepEqual(matchAddresses(both, nics), {0: ['10.0.0.1/24']}, 'eth0 is already claimed by MAC: the name fallback does not steal it');
  const byName = [{name: 'eth9', 'hardware-address': null, 'ip-addresses': [{'ip-address-type': 'ipv4', 'ip-address': '10.0.0.4', prefix: 24}]}];
  assert.deepEqual(matchAddresses(parseGuestInterfaces(byName), nics), {}, 'a NIC index the node does not have is ignored');
});

test('a MAC compare ignores case, and an interface with no matching NIC is ignored (lo, tunnels)', () => {
  const guest = [{name: 'tun0', 'hardware-address': '02:00:00:00:00:77', 'ip-addresses': [{'ip-address-type': 'ipv4', 'ip-address': '10.8.0.1', prefix: 24}]},
    {name: 'eth0', 'hardware-address': '52:54:00:AA:BB:01', 'ip-addresses': [{'ip-address-type': 'ipv4', 'ip-address': '10.0.0.5', prefix: 24}]}];
  assert.deepEqual(matchAddresses(parseGuestInterfaces(guest), [{mac: '52:54:00:AA:BB:01'}]), {0: ['10.0.0.5/24']});
});

test('hostile data: only well formed addresses survive, as plain strings', () => {
  const interfaces = parseGuestInterfaces(fixtures.hostile);
  const matched = matchAddresses(interfaces, nics);
  // The forged but well formed values pass: nothing can tell them from a real address (informational only).
  assert.deepEqual(matched[0], ['8.8.8.8/24', '2001:db8::5/64']);
  for (const list of Object.values(matched)) for (const text of list) assert.match(text, /^[0-9a-f:.]+\/\d{1,3}$/);
  assert.ok(interfaces.every(face => face.name === null || /^[A-Za-z0-9_.:@-]{1,15}$/.test(face.name)), 'no markup, no long names');
  assert.equal(interfaces.some(face => face.name === 'eth1;rm -rf'), false);
});

test('the absurd values are refused one by one', () => {
  const ok = {'ip-address-type': 'ipv4', 'ip-address': '10.0.0.1', prefix: 24};
  assert.equal(cleanAddress(ok), '10.0.0.1/24');
  for (const change of [{prefix: 33}, {prefix: -1}, {prefix: 1.5}, {prefix: '24'}, {prefix: null}, {'ip-address': '10.0.0.1 '}, {'ip-address': '010.0.0.1'}, {'ip-address': '1.2.3'},
    {'ip-address': '127.0.0.1'}, {'ip-address': '0.0.0.0'}, {'ip-address-type': 'ipx'}, {'ip-address': 4}, {'ip-address': 'a'.repeat(100)}]) {
    assert.equal(cleanAddress({...ok, ...change}), null, JSON.stringify(change));
  }
  assert.equal(cleanAddress(null), null);
  assert.equal(cleanAddress('10.0.0.1/24'), null);
  assert.equal(cleanAddress({'ip-address-type': 'ipv6', 'ip-address': '2001:db8::1', prefix: 64}), '2001:db8::1/64');
  assert.equal(cleanAddress({'ip-address-type': 'ipv6', 'ip-address': '2001:db8::1', prefix: 129}), null);
  for (const text of ['::1', '::', 'fe80::1', 'febf::1', 'fe80::1%eth0']) assert.equal(cleanAddress({'ip-address-type': 'ipv6', 'ip-address': text, prefix: 64}), null, text);
});

test('the counts are bounded: interfaces, addresses per interface and addresses kept per NIC', () => {
  const many = Array.from({length: 100}, (_, index) => ({name: `eth${index}`, 'hardware-address': `52:54:00:00:00:${index.toString(16).padStart(2, '0')}`, 'ip-addresses': []}));
  assert.equal(parseGuestInterfaces(many).length, LIMITS.interfaces);
  const addresses = Array.from({length: 200}, (_, index) => ({'ip-address-type': 'ipv4', 'ip-address': `10.0.${index}.1`, prefix: 24}));
  const [face] = parseGuestInterfaces([{name: 'eth0', 'hardware-address': '52:54:00:aa:bb:01', 'ip-addresses': addresses}]);
  assert.equal(face.addresses.length, LIMITS.addressesPerInterface);
  assert.ok(matchAddresses([face], nics)[0].length <= LIMITS.perNic);
});

test('a reply that is not a list is refused; an entry without name or MAC is skipped', () => {
  for (const value of [null, undefined, {}, 'x', 7]) assert.throws(() => parseGuestInterfaces(value), /list of interfaces/);
  assert.deepEqual(parseGuestInterfaces([{'ip-addresses': []}, 3, null]), []);
});

test('sameAddresses compares by value', () => {
  assert.ok(sameAddresses({0: ['10.0.0.1/24']}, {0: ['10.0.0.1/24']}));
  assert.ok(!sameAddresses({0: ['10.0.0.1/24']}, {}));
});
