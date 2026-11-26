'use strict';

// Host and switch identifiers: h-/s- followed by 8 hex characters.
const crypto = require('crypto');

function entityKind(id, expectedKind) {
  if (typeof id !== 'string' || !/^[hs]-[0-9a-f]{8}$/.test(id)) throw new Error('Invalid host or switch ID; expected h- or s- followed by 8 lowercase hex characters.');
  const kind = id[0] === 'h' ? 'host' : 'switch';
  if (expectedKind && kind !== expectedKind) throw new Error(`Expected a ${expectedKind === 'host' ? 'host' : 'switch'} ID.`);
  return kind;
}

// A new ID (32 random bits), never one of `used` (a Set or Map of the IDs taken in the session).
function newEntityId(kind, used = new Set()) {
  let id;
  do id = `${kind === 'switch' ? 's' : 'h'}-${crypto.randomBytes(4).toString('hex')}`;
  while (used.has(id));
  return id;
}

module.exports = {entityKind, newEntityId};
