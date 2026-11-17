'use strict';

// Console identifiers. A host has one console per serial port: channel 0 (ttyS0) is named by
// the node ID alone, channel 1 (ttyS1) by the node ID followed by ':1' (h-<16 hex>:1). The
// identifier is used by the sockets layer and the runner (select-node, input, clear-console,
// console.* commands, 'serial' and 'serial-reset' events); node ids stay plain everywhere else.
// Shared by the runner and the tests (require) and by the browser (classic script served at
// /console-id.js, global ConsoleId).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConsoleId = api;
})(this, function () {
  const MAX_CHANNEL = 1;
  const PATTERN = /^([hs]-[0-9a-f]{16})(?::([0-9]+))?$/;

  // The node ID of a console ID (a plain node ID is its own base).
  function baseNodeId(id) {
    return typeof id === 'string' && id.includes(':') ? id.slice(0, id.indexOf(':')) : id;
  }

  // The serial channel of a console ID: 0 for a plain node ID, 1 for '<id>:1', null if invalid.
  function consoleChannel(id) {
    const match = typeof id === 'string' ? PATTERN.exec(id) : null;
    if (!match) return null;
    if (match[2] === undefined) return 0;
    return match[2] === '1' ? 1 : null;
  }

  // The console ID of a node and channel; channel 0 is the node ID itself.
  function consoleId(nodeId, channel = 0) {
    if (!Number.isInteger(channel) || channel < 0 || channel > MAX_CHANNEL) throw new Error('Invalid console channel.');
    return channel === 0 ? nodeId : `${nodeId}:${channel}`;
  }

  return {baseNodeId, consoleChannel, consoleId, MAX_CHANNEL};
});
