'use strict';

// The address a server listens on (--bind) and the one a local runner dials (--host): ONE place for the rules.
// An address is a literal, IPv4 or IPv6 (net.isIP): never a host name (nothing is resolved), never a port, a
// CIDR or a zone id. Loopback (127.0.0.0/8, ::1) is the safe default; anything else is reachable from the network,
// in clear text (HTTP).
//   node common/bind.js runner-host ADDRESS   the address the local runner dials for a server bound to ADDRESS
//                                             (used by scripts/lib/runtime.sh, start.sh and demo.sh)
const net = require('net');

const DEFAULT_ADDRESS = '127.0.0.1';
const LOOPBACK_HOSTNAME = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

// The address as given, or an Error saying why it is not one.
function parseAddress(value) {
  if (typeof value !== 'string' || value === '') throw new Error('an address is required');
  if (value.includes('%')) throw new Error('no zone id (%) in an address');
  if (net.isIP(value) === 0) throw new Error('not an IPv4 or IPv6 address (a literal: no host name, no port, no mask)');
  return value;
}

const isWildcard = address => address === '0.0.0.0' || (net.isIP(address) === 6 && new URL(`http://[${address}]/`).hostname === '[::]');

function isLoopback(address) {
  if (net.isIP(address) === 4) return /^127\./.test(address);
  if (net.isIP(address) !== 6) return false;
  const host = new URL(`http://[${address}]/`).hostname;  // normalised: [::1], [::ffff:7f00:1]
  return host === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
}

// Whether a URL host name (URL.hostname, so an IPv6 literal is in brackets) is this machine: localhost, 127.x.x.x, [::1].
const isLoopbackHostname = hostname => LOOPBACK_HOSTNAME.test(hostname);

// The host part of a URL for an address: an IPv6 literal goes in brackets.
const urlHost = address => (net.isIP(address) === 6 ? `[${address}]` : address);

// The address the local runner dials for a server bound to `bind`: a wildcard is reached on loopback, a specific address on itself.
const runnerHost = bind => (isWildcard(bind) ? DEFAULT_ADDRESS : bind);

module.exports = {DEFAULT_ADDRESS, parseAddress, isWildcard, isLoopback, isLoopbackHostname, urlHost, runnerHost};

if (require.main === module) {
  const [command, address] = process.argv.slice(2);
  try {
    if (command !== 'runner-host' || address === undefined) throw new Error('Usage: node common/bind.js runner-host ADDRESS');
    console.log(runnerHost(parseAddress(address)));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
