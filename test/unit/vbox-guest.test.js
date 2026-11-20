'use strict';

// VirtualBox guest addresses from the Guest Additions properties (runner/engines/vbox-guest.js): INERT code
// (guestAgent:vbox is false for every system), tested with a fake VBoxManage and a recorded-by-hand output of
// `VBoxManage guestproperty enumerate`. A later authorised VirtualBox measurement must confirm the real output.
const test = require('node:test');
const assert = require('node:assert/strict');
const {netmaskToPrefix, parseGuestProperties, queryVirtualBox} = require('../../runner/engines/vbox-guest');
const {parseGuestInterfaces, matchAddresses} = require('../../common/guest-addresses');

const OUTPUT = [
  'Name: /VirtualBox/GuestInfo/Net/Count, value: 2, timestamp: 1700000000000000000, flags:',
  'Name: /VirtualBox/GuestInfo/Net/0/V4/IP, value: 192.168.0.1, timestamp: 1700000000000000001, flags:',
  'Name: /VirtualBox/GuestInfo/Net/0/V4/Netmask, value: 255.255.255.0, timestamp: 1700000000000000001, flags:',
  'Name: /VirtualBox/GuestInfo/Net/0/V4/Broadcast, value: 192.168.0.255, timestamp: 1700000000000000001, flags:',
  'Name: /VirtualBox/GuestInfo/Net/0/MAC, value: 52540000AA01, timestamp: 1700000000000000001, flags:',
  'Name: /VirtualBox/GuestInfo/Net/0/Name, value: eth0, timestamp: 1700000000000000001, flags:',
  'Name: /VirtualBox/GuestInfo/Net/0/Status, value: Up, timestamp: 1700000000000000001, flags:',
  'Name: /VirtualBox/GuestInfo/Net/1/V4/IP, value: 10.1.1.9, timestamp: 1700000000000000002, flags:',
  'Name: /VirtualBox/GuestInfo/Net/1/V4/Netmask, value: 255.255.255.128, timestamp: 1700000000000000002, flags:',
  'Name: /VirtualBox/GuestInfo/Net/1/MAC, value: 52540000AA02, timestamp: 1700000000000000002, flags:',
  'Name: /VirtualBox/GuestInfo/Net/1/Name, value: eth1, timestamp: 1700000000000000002, flags:'
].join('\n');

test('a netmask becomes a prefix length; a mask that is not contiguous is refused', () => {
  assert.equal(netmaskToPrefix('255.255.255.0'), 24);
  assert.equal(netmaskToPrefix('255.255.255.128'), 25);
  assert.equal(netmaskToPrefix('255.0.0.0'), 8);
  assert.equal(netmaskToPrefix('255.255.255.255'), 32);
  assert.equal(netmaskToPrefix('0.0.0.0'), 0);
  for (const bad of ['255.0.255.0', '256.0.0.0', '255.255.255', 'abc', '', '255.255.255.0.0', '-1.0.0.0']) assert.equal(netmaskToPrefix(bad), null, bad);
});

test('the properties give the same shape as the QEMU agent, so the same validation and matching apply', () => {
  const interfaces = parseGuestProperties(OUTPUT);
  assert.deepEqual(interfaces[0], {name: 'eth0', 'hardware-address': '52:54:00:00:aa:01', 'ip-addresses': [{'ip-address-type': 'ipv4', 'ip-address': '192.168.0.1', prefix: 24}]});
  const nics = [{mac: '52:54:00:00:aa:01'}, {mac: '52:54:00:00:aa:02'}];
  assert.deepEqual(matchAddresses(parseGuestInterfaces(interfaces), nics), {0: ['192.168.0.1/24'], 1: ['10.1.1.9/25']});
});

test('hostile or odd property values are dropped by the validation', () => {
  const hostile = OUTPUT.replace('value: 192.168.0.1,', 'value: <b>x</b>,').replace('value: 255.255.255.128', 'value: 255.0.255.0').replace('value: 52540000AA02', 'value: not-a-mac');
  const interfaces = parseGuestInterfaces(parseGuestProperties(hostile));
  assert.deepEqual(matchAddresses(interfaces, [{mac: '52:54:00:00:aa:01'}, {mac: '52:54:00:00:aa:02'}]), {});
  assert.equal(parseGuestProperties('garbage\nName: /elsewhere, value: x, timestamp: 1, flags:\n').length, 0);
});

test('the fake VBoxManage is asked for the Net properties of the VM only', async () => {
  const seen = [];
  const run = (command, args, options, callback) => { seen.push({command, args, options}); callback(null, OUTPUT); };
  const interfaces = await queryVirtualBox({commands: {VBOXMANAGE: 'VBoxManage'}}, {vmName: 'qemuweb-1-s-h'}, run);
  assert.equal(interfaces.length, 2);
  assert.deepEqual(seen[0].args, ['guestproperty', 'enumerate', 'qemuweb-1-s-h', '--patterns', '/VirtualBox/GuestInfo/Net/*']);
  assert.equal(seen[0].options.maxBuffer, 64 * 1024);
  await assert.rejects(queryVirtualBox({commands: {VBOXMANAGE: 'VBoxManage'}}, {vmName: 'x'}, (c, a, o, callback) => callback(new Error('VBoxManage failed'))), /failed/);
});
