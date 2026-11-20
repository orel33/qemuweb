'use strict';

// Recorded and forged replies of `guest-network-get-interfaces` (study GAG01, docs/guest-agent.md).
const stats = {'tx-packets': 0, 'tx-errs': 0, 'rx-bytes': 0, 'rx-dropped': 0, 'rx-packets': 0, 'rx-errs': 0, 'tx-bytes': 0, 'tx-dropped': 0};
const lo = {name: 'lo', 'hardware-address': '00:00:00:00:00:00', statistics: stats,
  'ip-addresses': [{'ip-address-type': 'ipv4', 'ip-address': '127.0.0.1', prefix: 8}, {'ip-address-type': 'ipv6', 'ip-address': '::1', prefix: 128}]};

// MEASURED on debian13-legacy after `ip addr add 10.1.2.3/24 dev eth0` (MAC 52:54:00:aa:bb:01).
const debianLegacy = [lo, {name: 'eth0', 'hardware-address': '52:54:00:aa:bb:01', statistics: stats,
  'ip-addresses': [{'ip-address-type': 'ipv4', 'ip-address': '10.1.2.3', prefix: 24}, {'ip-address-type': 'ipv6', 'ip-address': 'fe80::5054:ff:feaa:bb01', prefix: 64}]}];

// MEASURED on debian13-cloud with the user-mode network (DHCP).
const debianCloudDhcp = [lo, {name: 'eth0', 'hardware-address': '52:54:00:12:34:56', statistics: stats,
  'ip-addresses': [{'ip-address-type': 'ipv4', 'ip-address': '10.0.2.15', prefix: 24}, {'ip-address-type': 'ipv6', 'ip-address': 'fec0::5054:ff:fe12:3456', prefix: 64}, {'ip-address-type': 'ipv6', 'ip-address': 'fe80::5054:ff:fe12:3456', prefix: 64}]}];

// MEASURED on alpine after `ip addr add 192.168.7.9/28 dev eth0; ip addr del 10.0.2.15/24 dev eth0`.
const alpineChanged = [{...lo, 'ip-addresses': [lo['ip-addresses'][0]]}, {name: 'eth0', 'hardware-address': '52:54:00:12:34:56', statistics: stats,
  'ip-addresses': [{'ip-address-type': 'ipv4', 'ip-address': '192.168.7.9', prefix: 28}]}];

// MEASURED on openwrt: the LAN port has only a link-local address until the startup script sets one.
const openwrtBare = [lo, {name: 'eth0', 'hardware-address': '52:54:00:aa:bb:01', statistics: stats,
  'ip-addresses': [{'ip-address-type': 'ipv6', 'ip-address': 'fe80::5054:ff:feaa:bb01', prefix: 64}]}];

// FORGED by a script of ours on the agent port: a false address, markup as an address and as a name, absurd prefixes.
const hostile = [
  {name: 'eth0', 'hardware-address': '52:54:00:aa:bb:01', 'ip-addresses': [
    {'ip-address-type': 'ipv4', 'ip-address': '8.8.8.8', prefix: 24},
    {'ip-address-type': 'ipv4', 'ip-address': '<img src=x onerror=alert(1)>', prefix: 24},
    {'ip-address-type': 'ipv4', 'ip-address': '10.0.0.1', prefix: 99999},
    {'ip-address-type': 'ipv4', 'ip-address': '10.0.0.2', prefix: -1},
    {'ip-address-type': 'ipv4', 'ip-address': '10.0.0.3', prefix: '24'},
    {'ip-address-type': 'ipv4', 'ip-address': '999.1.1.1', prefix: 24},
    {'ip-address-type': 'ipv6', 'ip-address': '2001:DB8::5', prefix: 64},
    {'ip-address-type': 'ipv6', 'ip-address': 'fe80::1%eth0', prefix: 64},
    {'ip-address-type': 'ipv6', 'ip-address': '2001:db8::1', prefix: 129},
    {'ip-address-type': 'packet', 'ip-address': '1.1.1.1', prefix: 24},
    null, 'text', 7]},
  {name: '<script>alert(1)</script>'.repeat(40), 'hardware-address': 'zz', 'ip-addresses': [{'ip-address-type': 'ipv4', 'ip-address': '10.9.9.9', prefix: 8}]},
  {name: 'eth1;rm -rf', 'hardware-address': '52:54:00:aa:bb:02', 'ip-addresses': 'not a list'}
];

module.exports = {lo, debianLegacy, debianCloudDhcp, alpineChanged, openwrtBare, hostile};
