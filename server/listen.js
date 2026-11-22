'use strict';

// What the server says about the address it listens on (--bind): the line of "Checking configuration…", the warning of a
// non-loopback address, and the URLs of the banner. The refusals (--no-auth, --auth proxy) are in server/options.js.
const {isLoopback, isWildcard, urlHost, runnerHost} = require('../common/bind');

const kindOf = bind => (isLoopback(bind) ? 'loopback' : isWildcard(bind) ? 'all interfaces' : 'network address');

// The line "listen address", shown as a pass.
const listenLine = ({bind, port}) => `listen address  ${urlHost(bind)}:${port}  (${kindOf(bind)})`;

// The lines of the warning of a non-loopback address (none for loopback).
function listenWarning({bind, port}) {
  if (isLoopback(bind)) return [];
  return [
    `the server listens on ${isWildcard(bind) ? 'every network interface' : urlHost(bind)}, port ${port}, in clear text (HTTP): the web interface, the consoles and /runner/connect are open to the network.`,
    'Traffic, passwords, the session cookie and the runner token travel unencrypted and can be read or changed by anyone on the path.',
    'Use it only on a trusted LAN (a firewall that lets in the machines you expect), or keep --bind 127.0.0.1 behind nginx or Apache that terminate TLS (docs/deployment.md), or wait for the HTTPS support.'
  ];
}

// The "Web interface" lines of the banner: the URL of the address, or for a wildcard the loopback one and a note.
function bannerLines({bind, port}) {
  if (isWildcard(bind)) return [`  Web interface      http://${urlHost(runnerHost(bind))}:${port}`, `  Listening          on all interfaces (${urlHost(bind)}:${port}); from the network: http://<address of this machine>:${port}`];
  return [`  Web interface      http://${urlHost(bind)}:${port}`];
}

module.exports = {listenLine, listenWarning, bannerLines};
