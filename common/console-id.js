'use strict';

// Console identifiers. A host has one console per serial port: channel 0 (ttyS0) is named by
// the node ID alone, channel 1 (ttyS1) by the node ID followed by ':1' (h-<8 hex>:1). The
// identifier is used by the sockets layer and the runner (select-node, input, clear-console,
// console.* commands, 'serial' and 'serial-reset' events); node ids stay plain everywhere else.
// Shared by the runner and the tests (require) and by the browser (classic script served at
// /console-id.js, global ConsoleId).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConsoleId = api;
})(this, function () {
  // Serial ports a host can expose, in QEMU -serial order: the channel index of a port is its
  // position here (ttyS0 is the kernel console, COM1). Extend the list to allow more ports.
  const PORTS = ['ttyS0', 'ttyS1'];
  const PATTERN = /^([hs]-[0-9a-f]{8})(?::([0-9]+))?$/;

  // The channel index of a port name, null if the name is not an allowed port.
  function portChannel(name) {
    const index = PORTS.indexOf(name);
    return index < 0 ? null : index;
  }

  // The port name of a channel index, null if out of range.
  function portName(channel) {
    return Number.isInteger(channel) && channel >= 0 && channel < PORTS.length ? PORTS[channel] : null;
  }

  // Checks a list of serial ports: unique allowed names, a contiguous prefix of PORTS (it starts
  // with ttyS0). With a limit (the list a system exposes) it must also be a prefix of that list.
  function validatePorts(ports, limit = null) {
    if (!Array.isArray(ports) || ports.length === 0 || ports.some((name, index) => name !== PORTS[index])) {
      throw new Error(`Serial ports must be a list starting with ttyS0, in order (${PORTS.join(', ')}).`);
    }
    if (limit && ports.length > limit.length) throw new Error(`This system exposes only ${limit.join(', ')}.`);
    return ports;
  }

  // The node ID of a console ID (a plain node ID is its own base).
  function baseNodeId(id) {
    return typeof id === 'string' && id.includes(':') ? id.slice(0, id.indexOf(':')) : id;
  }

  // The serial channel of a console ID: 0 for a plain node ID, N for '<id>:N', null if invalid.
  function consoleChannel(id) {
    const match = typeof id === 'string' ? PATTERN.exec(id) : null;
    if (!match) return null;
    if (match[2] === undefined) return 0;
    const channel = Number(match[2]);
    return channel >= 1 && channel < PORTS.length && String(channel) === match[2] ? channel : null;
  }

  // The console ID of a node and channel; channel 0 is the node ID itself.
  function consoleId(nodeId, channel = 0) {
    if (!Number.isInteger(channel) || channel < 0 || channel >= PORTS.length) throw new Error('Invalid console channel.');
    return channel === 0 ? nodeId : `${nodeId}:${channel}`;
  }

  return {baseNodeId, consoleChannel, consoleId, portChannel, portName, validatePorts, PORTS};
});
