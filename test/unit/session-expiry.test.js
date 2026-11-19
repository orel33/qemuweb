// What a page does on a 401 (public/session-expiry.js): the login page for a password login, one reload for an
// identity from the authenticating front end (its SSO session expired), never two within 30 seconds.
const assert = require('node:assert/strict');
const test = require('node:test');

const load = () => import('../../public/session-expiry.js');

test('a proxy identity reloads the page once on a 401', async () => {
  const {unauthorizedAction} = await load();
  assert.equal(unauthorizedAction({via: 'proxy', now: 1e6, lastReload: null}), 'reload');
  assert.equal(unauthorizedAction({via: 'proxy', now: 1e6, lastReload: undefined}), 'reload');
});

test('no second automatic reload within 30 seconds, one again after', async () => {
  const {unauthorizedAction, RELOAD_GUARD_MS} = await load();
  assert.equal(RELOAD_GUARD_MS, 30000);
  const last = 1e6;
  assert.equal(unauthorizedAction({via: 'proxy', now: last + 1, lastReload: last}), 'none');
  assert.equal(unauthorizedAction({via: 'proxy', now: last + 29999, lastReload: last}), 'none');
  assert.equal(unauthorizedAction({via: 'proxy', now: last + 30000, lastReload: last}), 'reload');
  assert.equal(unauthorizedAction({via: 'proxy', now: last - 5000, lastReload: last}), 'reload', 'a time in the future (clock change) is no guard');
  assert.equal(unauthorizedAction({via: 'proxy', now: last + 1, lastReload: NaN}), 'reload');
});

test('password mode, an unknown identity and no identity go to the login page, whatever the last reload', async () => {
  const {unauthorizedAction} = await load();
  for (const via of ['password', null, undefined]) {
    assert.equal(unauthorizedAction({via, now: 1e6, lastReload: null}), 'login');
    assert.equal(unauthorizedAction({via, now: 1e6 + 1, lastReload: 1e6}), 'login');
  }
});
