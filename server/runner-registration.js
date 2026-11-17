'use strict';

// Registration tokens of remote runners: created by an administrator in /admin/runners, shown once,
// valid for one registration and for a limited time (15 minutes, 1 hour or 24 hours). Kept in
// memory only (a server restart invalidates them) and compared in constant time, as sha256 hashes.
//   create({minutes, by})   {id, token, expiresAt}: the token is returned this once
//   redeem(token)           the creator's login when the token is valid, and invalidates it; else null
//   pending()               [{id, createdAt, expiresAt, by}] of the unexpired tokens, never a secret
//   cancel(id)              invalidates a token that was not used
const crypto = require('crypto');

const LIFETIMES_MINUTES = [15, 60, 1440];
const MAX_PENDING = 20;

function createRegistrationTokens({now = Date.now} = {}) {
  const tokens = [];
  const digest = token => crypto.createHash('sha256').update(String(token)).digest();
  const prune = () => {
    for (let index = tokens.length - 1; index >= 0; index--) if (tokens[index].expiresAt <= now()) tokens.splice(index, 1);
  };

  return {
    create({minutes, by}) {
      if (!LIFETIMES_MINUTES.includes(minutes)) throw Object.assign(new Error(`The lifetime must be ${LIFETIMES_MINUTES.join(', ')} minutes.`), {status: 400});
      prune();
      if (tokens.length >= MAX_PENDING) throw Object.assign(new Error('Too many pending registration tokens; cancel some.'), {status: 409});
      const token = crypto.randomBytes(24).toString('base64url');
      const entry = {id: crypto.randomBytes(4).toString('hex'), hash: digest(token), createdAt: now(), expiresAt: now() + minutes * 60000, by};
      tokens.push(entry);
      return {id: entry.id, token, expiresAt: new Date(entry.expiresAt).toISOString()};
    },
    redeem(token) {
      prune();
      if (typeof token !== 'string' || token.length > 256) return null;
      const hash = digest(token);
      // Every pending token is compared, so that the time does not tell which one matched.
      let found = null;
      for (const entry of tokens) if (crypto.timingSafeEqual(entry.hash, hash)) found = entry;
      if (!found) return null;
      tokens.splice(tokens.indexOf(found), 1);
      return found.by;
    },
    pending() {
      prune();
      return tokens.map(({id, createdAt, expiresAt, by}) => ({id, createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(), by}));
    },
    cancel(id) {
      const index = tokens.findIndex(entry => entry.id === id);
      if (index < 0) return false;
      tokens.splice(index, 1);
      return true;
    }
  };
}

module.exports = {createRegistrationTokens, LIFETIMES_MINUTES};
