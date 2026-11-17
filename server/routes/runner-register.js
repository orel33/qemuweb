'use strict';

// POST /api/runner/register {token, name}: a runner machine exchanges the one-time registration
// token created in /admin/runners for its own identity {runnerId, authToken} (the token is shown
// once; only its hash is kept, server/runner-store.js). The only unauthenticated route of the
// API besides login: the token is the credential, checked in constant time
// (server/runner-registration.js), and attempts are limited per address.
const express = require('express');

// Fixed-window limiter: at most `max` attempts per `windowMs` for one key.
function createRateLimiter({max = 10, windowMs = 60000, now = Date.now} = {}) {
  const windows = new Map();
  return key => {
    const time = now();
    for (const [other, window] of windows) if (window.start + windowMs <= time) windows.delete(other);
    const window = windows.get(key) || {start: time, count: 0};
    windows.set(key, window);
    return ++window.count <= max;
  };
}

function createRegisterRouter({tokens, store, audit, allow = createRateLimiter()}) {
  const router = express.Router();
  router.post('/', express.json({limit: '4kb'}), (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!allow(req.ip || 'unknown')) return res.status(429).json({error: 'Too many attempts; try again in a minute.'});
    const by = tokens.redeem(req.body?.token);
    if (!by) {
      console.warn(`Runner registration refused: invalid or expired token (${req.ip || 'unknown address'}).`);
      return res.status(403).json({error: 'Invalid or expired registration token.'});
    }
    try {
      const {record, authToken} = store.add({name: req.body?.name});
      audit.record(by, 'register-runner', {runnerId: record.id, name: record.name}, 'ok');
      res.json({runnerId: record.id, authToken, name: record.name});
    } catch (error) {
      console.error(`Runner registration failed: ${error.message}`);
      res.status(500).json({error: 'Registration failed; see the server log.'});
    }
  });
  return router;
}

module.exports = {createRegisterRouter, createRateLimiter};
