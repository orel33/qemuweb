'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {DEFAULT_ROLE, validateDhcpDns, preStartScript} = require('../../openwrt-lan-role');

const switchId = 's-0123456789abcdef';
const interfaces = [{switchId}];
const valid = {...DEFAULT_ROLE, enabled: true};
const check = (role, options = {}) => validateDhcpDns(role, {imageId: 'openwrt', interfaces, ...options});

test('valid OpenWrt LAN role creates a self-contained script without a gateway', () => {
  const role = check(valid);
  const script = preStartScript(role);
  assert.match(script, /network\.qemuweb_lan\.device=eth0/);
  assert.match(script, /dhcp\.qemuweb_lan\.start=100/);
  assert.match(script, /dhcp\.qemuweb_lan\.limit=100/);
  assert.match(script, /dhcp\.qemuweb_lan\.instance=qemuweb_dns/);
  assert.match(script, /dhcp_option=3/);
  assert.match(script, /dhcp_option=6,192\.168\.10\.1/);
  assert.doesNotMatch(script, /network\.qemuweb_lan\.gateway=/);
});

test('rejects invalid pool, server, domain and disconnected Ethernet 0', () => {
  assert.throws(() => check({...valid, poolStart: '192.168.11.100'}), /subnet/);
  assert.throws(() => check({...valid, poolStart: '192.168.10.1'}), /server address/);
  assert.throws(() => check({...valid, lanAddress: '192.168.10.0\/24'}), /usable/);
  assert.throws(() => check({...valid, domain: 'bad domain'}), /domain/);
  assert.throws(() => validateDhcpDns(valid, {imageId: 'openwrt', interfaces: [null]}), /Ethernet 0/);
  assert.throws(() => validateDhcpDns(valid, {imageId: 'alpine', interfaces}), /only for OpenWrt/);
});

test('rejects another saved or running managed server on the same switch', () => {
  const saved = {id: 'h-a', kind: 'vm', dhcpDns: valid, networkInterfaces: interfaces};
  assert.throws(() => check(valid, {hostId: 'h-b', sessions: new Map([['h-a', saved]])}), /already uses/);
  const running = {id: 'h-a', kind: 'vm', dhcpDns: {...DEFAULT_ROLE}, networkInterfaces: interfaces,
    machine: {}, activeConfig: {dhcpDns: valid, networkInterfaces: interfaces}};
  assert.throws(() => check(valid, {hostId: 'h-b', sessions: new Map([['h-a', running]])}), /already uses/);
});
