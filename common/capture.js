'use strict';

// Traffic capture rules shared by the runner and the server (design: docs/architecture.md,
// "Traffic capture").

// Limits of one node. Placeholders until the per-user quotas of the hardening milestone; they live
// here and nowhere else.
//   maxBytes    size of one capture file. The runner polls the file every WATCH_INTERVAL_MS and
//               removes the filter once it reached this size, so a burst can overshoot a little.
//   maxPerNode  capture files kept per node (recording or finished): a fifth start is refused
//               until one is deleted.
const LIMITS = Object.freeze({maxBytes: 100 * 1024 * 1024, maxPerNode: 4});
const WATCH_INTERVAL_MS = 500;
// A host has at most four Ethernet interfaces (runner/network/nics.js).
const MAX_INTERFACES = 4;

// A capture ID is also its file name without the extension: <interface>-<UTC time>[-<n>], built by
// the runner (never taken from a user), for example eth0-20261120T101530Z.
const CAPTURE_ID = /^eth[0-3]-\d{8}T\d{6}Z(?:-[1-9]\d?)?$/;
const isCaptureId = value => typeof value === 'string' && CAPTURE_ID.test(value);

// The interface index of an "eth<N>" name or a number, or null.
function interfaceIndex(value) {
  const index = typeof value === 'string' && /^eth[0-3]$/.test(value) ? Number(value.slice(3)) : value;
  return Number.isInteger(index) && index >= 0 && index < MAX_INTERFACES ? index : null;
}

// Capture IDs of one interface, built from its index, a Date and a number to tell two captures
// started in the same second apart.
function captureId(index, date, repeat = 0) {
  const stamp = date.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
  return `eth${index}-${stamp}${repeat ? `-${repeat}` : ''}`;
}

module.exports = {LIMITS, WATCH_INTERVAL_MS, MAX_INTERFACES, CAPTURE_ID, isCaptureId, interfaceIndex, captureId};
