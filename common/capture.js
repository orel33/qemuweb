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

// The optional filter of the live view: a tcpdump (BPF) expression typed by the user, passed to
// tcpdump as ONE argument, never through a shell. Only the characters of such expressions are
// accepted (words, numbers, addresses, ports, brackets, comparison and logic operators), at most
// FILTER_MAX of them, and it cannot start with '-' (it would look like an option; the runner also
// puts '--' before it). Returns the trimmed expression ('' for none) or throws an Error whose
// message is shown to the user.
const FILTER_MAX = 200;
const FILTER_CHARACTERS = /^[A-Za-z0-9 .:/_()[\]&|!<>=+*%^,-]+$/;
function validateFilter(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('The filter must be text.');
  const filter = value.trim();
  if (filter.length > FILTER_MAX) throw new Error(`The filter is too long (at most ${FILTER_MAX} characters).`);
  if (filter && !FILTER_CHARACTERS.test(filter)) throw new Error('The filter has characters a tcpdump expression does not use: letters, digits, spaces and . : / _ - ( ) [ ] & | ! < > = + * % ^ , are accepted.');
  if (filter.startsWith('-')) throw new Error('The filter cannot start with "-".');
  return filter;
}

// Live view identifiers are chosen by the server and checked by the runner.
const LIVE_ID = /^[0-9a-f]{16}$/;
const MAX_LIVE = 4;

module.exports = {FILTER_MAX, validateFilter, LIVE_ID, MAX_LIVE, LIMITS, WATCH_INTERVAL_MS, MAX_INTERFACES, CAPTURE_ID, isCaptureId, interfaceIndex, captureId};
