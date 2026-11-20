'use strict';

// VirtualBox: the addresses of a guest from the Guest Additions property store, turned into the shape of the
// QEMU guest agent reply so that common/guest-addresses.js validates both the same way. INERT for now:
// `guestAgent:vbox` is false for every system and nothing was measured under VirtualBox (docs/guest-agent.md,
// section 9). Keys: /VirtualBox/GuestInfo/Net/<n>/{V4/IP,V4/Netmask,MAC,Name}.
const {execFile} = require('child_process');

const PROPERTY = /^Name: \/VirtualBox\/GuestInfo\/Net\/(\d{1,2})\/(V4\/IP|V4\/Netmask|MAC|Name), value: (.{0,64}?), timestamp: \d+, flags:/;

// "255.255.255.0" -> 24; null for anything that is not a contiguous mask.
function netmaskToPrefix(mask) {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mask);
  if (!parts) return null;
  const octets = parts.slice(1).map(Number);
  if (octets.some(octet => octet > 255)) return null;
  const bits = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  // Contiguous ones then zeros: the inverse is 2^k - 1.
  const inverse = (~bits) >>> 0;
  if ((inverse & (inverse + 1)) !== 0) return null;
  return 32 - (inverse === 0 ? 0 : 32 - Math.clz32(inverse));
}

// The output of `VBoxManage guestproperty enumerate <vm> --patterns '/VirtualBox/GuestInfo/Net/*'`.
function parseGuestProperties(text) {
  const byIndex = new Map();
  for (const line of String(text).split('\n').slice(0, 200)) {
    const match = PROPERTY.exec(line);
    if (!match) continue;
    const entry = byIndex.get(match[1]) || {};
    entry[match[2]] = match[3];
    byIndex.set(match[1], entry);
  }
  return [...byIndex.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, entry]) => {
    const mac = /^[0-9A-Fa-f]{12}$/.test(entry.MAC || '') ? entry.MAC.toLowerCase().match(/../g).join(':') : null;
    const prefix = entry['V4/Netmask'] === undefined ? null : netmaskToPrefix(entry['V4/Netmask']);
    const addresses = entry['V4/IP'] !== undefined && prefix !== null ? [{'ip-address-type': 'ipv4', 'ip-address': entry['V4/IP'], prefix}] : [];
    return {name: entry.Name, 'hardware-address': mac, 'ip-addresses': addresses};
  });
}

// Runs VBoxManage for one VM; resolves the interfaces. `run` is injectable (tests use a fake VBoxManage).
function queryVirtualBox(ctx, node, run = execFile) {
  return new Promise((resolve, reject) => {
    run(ctx.commands.VBOXMANAGE, ['guestproperty', 'enumerate', node.vmName, '--patterns', '/VirtualBox/GuestInfo/Net/*'],
      {timeout: 3000, maxBuffer: 64 * 1024, encoding: 'utf8'}, (error, stdout) => {
        if (error) reject(error);
        else resolve(parseGuestProperties(stdout));
      });
  });
}

module.exports = {netmaskToPrefix, parseGuestProperties, queryVirtualBox};
