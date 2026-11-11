'use strict';

const DEFAULT_ROLE = Object.freeze({enabled: false, lanAddress: '192.168.10.1/24', poolStart: '192.168.10.100', poolEnd: '192.168.10.199', domain: 'lab.test'});

function ipv4(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) throw new Error('Enter a valid IPv4 address.');
  const octets = value.split('.').map(Number);
  if (octets.some(octet => octet > 255)) throw new Error('Enter a valid IPv4 address.');
  return octets.reduce((number, octet) => (number * 256 + octet) >>> 0, 0);
}

function validateDhcpDns(value, {imageId, interfaces, hostId, sessions} = {}) {
  if (value === undefined) value = DEFAULT_ROLE;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean') throw new Error('Invalid OpenWrt DHCP/DNS settings.');
  if (Object.keys(value).some(key => !['enabled', 'lanAddress', 'poolStart', 'poolEnd', 'domain'].includes(key))) throw new Error('Invalid OpenWrt DHCP/DNS settings.');
  if (!value.enabled) return {...DEFAULT_ROLE, ...value, enabled: false};
  if (imageId !== 'openwrt') throw new Error('DHCP/DNS is available only for OpenWrt.');
  const firstInterface = interfaces?.[0];
  const switchId = typeof firstInterface === 'string' ? firstInterface : (firstInterface?.id || firstInterface?.switchId);
  if (!switchId) throw new Error('Connect Ethernet 0 to a switch before enabling DHCP/DNS.');
  if (typeof value.lanAddress !== 'string' || !/^\d+(?:\.\d+){3}\/(?:[1-9]|[12]\d|30)$/.test(value.lanAddress)) throw new Error('Enter the LAN address with an IPv4 prefix from /1 to /30.');
  const [address, prefixText] = value.lanAddress.split('/');
  const prefix = Number(prefixText);
  const server = ipv4(address);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const network = (server & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const first = ipv4(value.poolStart);
  const last = ipv4(value.poolEnd);
  if (server <= network || server >= broadcast) throw new Error('LAN server address must be a usable address in its subnet.');
  if (first <= network || last >= broadcast || first > last) throw new Error('DHCP pool must contain usable addresses in the LAN subnet, in ascending order.');
  if (((first & mask) >>> 0) !== network || ((last & mask) >>> 0) !== network) throw new Error('DHCP pool must be inside the LAN subnet.');
  if (first <= server && server <= last) throw new Error('DHCP pool cannot contain the LAN server address.');
  if (typeof value.domain !== 'string' || value.domain.length > 253 || !/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/.test(value.domain) ||
      value.domain.split('.').some(label => label.length > 63 || label.startsWith('-') || label.endsWith('-'))) throw new Error('Enter a valid local DNS domain.');
  if (sessions && [...sessions.values()].some(other => other.id !== hostId && other.kind === 'vm' && (
    (other.dhcpDns?.enabled && other.networkInterfaces?.[0]?.switchId === switchId) ||
    (other.machine && other.activeConfig?.dhcpDns?.enabled && other.activeConfig.networkInterfaces?.[0]?.switchId === switchId)
  ))) {
    throw new Error('Another QemuWeb DHCP/DNS host already uses this switch.');
  }
  return {enabled: true, lanAddress: value.lanAddress, poolStart: value.poolStart, poolEnd: value.poolEnd, domain: value.domain.toLowerCase()};
}

function preStartScript(role) {
  if (!role?.enabled) return null;
  const [address, prefixText] = role.lanAddress.split('/');
  const prefix = Number(prefixText);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const netmask = [24, 16, 8, 0].map(shift => (mask >>> shift) & 255).join('.');
  const network = (ipv4(address) & mask) >>> 0;
  const offset = ipv4(role.poolStart) - network;
  const limit = ipv4(role.poolEnd) - ipv4(role.poolStart) + 1;
  return `#!/bin/sh
# QemuWeb RHV62: managed OpenWrt LAN service. This file is self-contained.
set -eu
command -v uci >/dev/null
touch /etc/qemuweb-dhcp-dns-managed
uci -q delete network.qemuweb_lan || true
uci -q delete dhcp.qemuweb_dns || true
uci -q delete dhcp.qemuweb_lan || true
# Older prepared images have a disabled dhcp.lan section on eth0. OpenWrt
# applies its no-dhcp-interface=eth0 rule to every dnsmasq instance, so remove
# that disabled section before activating the dedicated QemuWeb instance.
if [ "$(uci -q get dhcp.lan.ignore 2>/dev/null || true)" = 1 ]; then
  uci -q delete dhcp.lan || true
fi
uci set network.qemuweb_lan=interface
uci set network.qemuweb_lan.device=eth0
uci set network.qemuweb_lan.proto=static
uci set network.qemuweb_lan.ipaddr=${address}
uci set network.qemuweb_lan.netmask=${netmask}
uci -q delete network.qemuweb_lan.gateway || true
uci set dhcp.qemuweb_dns=dnsmasq
uci -q delete dhcp.qemuweb_dns.interface || true
uci add_list dhcp.qemuweb_dns.interface=qemuweb_lan
uci add_list dhcp.qemuweb_dns.notinterface=loopback
uci set dhcp.qemuweb_dns.leasefile=/tmp/dhcp.leases.qemuweb
uci set dhcp.qemuweb_dns.nonwildcard=1
uci set dhcp.qemuweb_dns.localservice=1
uci set dhcp.qemuweb_dns.domain=${role.domain}
uci set dhcp.qemuweb_dns.local=/${role.domain}/
uci set dhcp.qemuweb_dns.expandhosts=1
uci set dhcp.qemuweb_dns.noresolv=1
uci set dhcp.qemuweb_dns.authoritative=1
uci set dhcp.qemuweb_dns.port=53
uci set dhcp.qemuweb_lan=dhcp
uci set dhcp.qemuweb_lan.instance=qemuweb_dns
uci set dhcp.qemuweb_lan.interface=qemuweb_lan
uci set dhcp.qemuweb_lan.start=${offset}
uci set dhcp.qemuweb_lan.limit=${limit}
uci set dhcp.qemuweb_lan.leasetime=12h
uci set dhcp.qemuweb_lan.ignore=0
uci set dhcp.qemuweb_lan.dhcpv6=disabled
uci set dhcp.qemuweb_lan.ra=disabled
uci -q delete dhcp.qemuweb_lan.dhcp_option || true
uci add_list dhcp.qemuweb_lan.dhcp_option=3
uci add_list dhcp.qemuweb_lan.dhcp_option=6,${address}
uci commit network
uci commit dhcp
/etc/init.d/dnsmasq enable
/etc/init.d/network reload
ifup qemuweb_lan
/etc/init.d/dnsmasq restart
`;
}

module.exports = {DEFAULT_ROLE, validateDhcpDns, preStartScript};
