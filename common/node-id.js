'use strict';

// Host and switch identifiers: h-/s- followed by 16 hex characters.
const crypto = require('crypto');

function entityKind(id, expectedKind) {
  if (typeof id !== 'string' || !/^[hs]-[0-9a-f]{16}$/.test(id)) throw new Error('Invalid host or switch ID; expected h- or s- followed by 16 lowercase hex characters.');
  const kind = id[0] === 'h' ? 'host' : 'switch';
  if (expectedKind && kind !== expectedKind) throw new Error(`Expected a ${expectedKind === 'host' ? 'host' : 'switch'} ID.`);
  return kind;
}

function newEntityId(kind) {
  return `${kind === 'switch' ? 's' : 'h'}-${crypto.randomBytes(8).toString('hex')}`;
}

module.exports = {entityKind, newEntityId};
