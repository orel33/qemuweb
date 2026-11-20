'use strict';

// The network addresses a guest reports about itself (qemu-guest-agent `guest-network-get-interfaces`, or the
// VirtualBox Guest Additions properties turned into the same shape). EVERYTHING here is untrusted: the guest
// is root-controlled and may send anything. The result is informational only (shown, never used for routing or
// any decision) and holds nothing but strings that match the patterns below, so it is safe as text in a page.
// Design and measurements: docs/guest-agent.md.
const net = require('net');

const LIMITS = {
  // Bytes read from the agent per call; more drops the connection (a guest can write ~900 MB/s).
  replyBytes: 64 * 1024,
  interfaces: 16,
  addressesPerInterface: 8,
  // Addresses kept per NIC of the node.
  perNic: 4
};
const NAME = /^[A-Za-z0-9_.:@-]{1,15}$/;
const MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const TEXT_CHARS = /^[0-9a-f:.]+$/i;

function isInteger(value, min, max) { return Number.isInteger(value) && value >= min && value <= max; }

// "ip/prefix" for one reported address, or null when it is invalid or not worth showing: loopback, IPv6
// link-local and the unspecified address are dropped.
function cleanAddress(entry) {
  if (entry === null || typeof entry !== 'object') return null;
  const type = entry['ip-address-type'];
  const text = entry['ip-address'];
  const prefix = entry.prefix;
  if (typeof text !== 'string' || text.length > 45 || !TEXT_CHARS.test(text)) return null;
  if (type === 'ipv4') {
    if (!net.isIPv4(text) || !isInteger(prefix, 0, 32) || text.startsWith('127.') || text === '0.0.0.0') return null;
    return `${text}/${prefix}`;
  }
  if (type === 'ipv6') {
    const lower = text.toLowerCase();
    if (!net.isIPv6(lower) || !isInteger(prefix, 0, 128) || lower === '::1' || lower === '::' || /^fe[89ab][0-9a-f]:/.test(lower)) return null;
    return `${lower}/${prefix}`;
  }
  return null;
}

// The interfaces of a reply as {name, mac, addresses[]}. Throws when the reply is not a list. Bounded: at most
// LIMITS.interfaces interfaces and LIMITS.addressesPerInterface addresses each; an entry that fails a pattern
// is dropped, never repaired.
function parseGuestInterfaces(value) {
  if (!Array.isArray(value)) throw new Error('The guest did not return a list of interfaces.');
  const interfaces = [];
  for (const raw of value.slice(0, LIMITS.interfaces)) {
    if (raw === null || typeof raw !== 'object') continue;
    const name = typeof raw.name === 'string' && NAME.test(raw.name) ? raw.name : null;
    const mac = typeof raw['hardware-address'] === 'string' && MAC.test(raw['hardware-address'].toLowerCase()) ? raw['hardware-address'].toLowerCase() : null;
    if (!name && !mac) continue;
    const list = Array.isArray(raw['ip-addresses']) ? raw['ip-addresses'].slice(0, LIMITS.addressesPerInterface) : [];
    const addresses = [...new Set(list.map(cleanAddress).filter(Boolean))];
    interfaces.push({name, mac, addresses});
  }
  return interfaces;
}

// The NIC index of an interface: its MAC first (the runner chose the MAC of each NIC), else the name `ethN`
// when no interface claimed that NIC by MAC. nics: [{mac}] in index order.
function nicIndexOf(face, nics, claimed) {
  if (face.mac) {
    const byMac = nics.findIndex(nic => String(nic.mac).toLowerCase() === face.mac);
    if (byMac >= 0) return byMac;
  }
  const named = /^eth(\d{1,2})$/.exec(face.name || '');
  if (named && Number(named[1]) < nics.length && !claimed.has(Number(named[1]))) return Number(named[1]);
  return -1;
}

// {"<nic index>": ["192.168.0.1/24", ...]} for the NICs that have an address: IPv4 first, then IPv6, at most
// LIMITS.perNic each. Interfaces that match no NIC (lo, a bridge with another MAC, a tunnel) are ignored.
function matchAddresses(interfaces, nics) {
  const claimed = new Set();
  for (const face of interfaces) {
    const index = face.mac ? nics.findIndex(nic => String(nic.mac).toLowerCase() === face.mac) : -1;
    if (index >= 0) claimed.add(index);
  }
  const result = {};
  for (const face of interfaces) {
    const index = nicIndexOf(face, nics, claimed);
    if (index < 0) continue;
    result[index] = [...(result[index] || []), ...face.addresses];
  }
  for (const [index, list] of Object.entries(result)) {
    const unique = [...new Set(list)].sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')));
    if (unique.length) result[index] = unique.slice(0, LIMITS.perNic);
    else delete result[index];
  }
  return result;
}

const sameAddresses = (a, b) => JSON.stringify(a) === JSON.stringify(b);

module.exports = {LIMITS, cleanAddress, parseGuestInterfaces, matchAddresses, sameAddresses};
