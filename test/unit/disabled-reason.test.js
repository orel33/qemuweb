// TOD04: why a control is disabled (observation, Follow, an administrator's control) and its tooltip.
const assert = require('node:assert/strict');
const test = require('node:test');
const {moduleSource, read} = require('./web-ui-source');

const load = () => import('../../public/disabled-reason.js');
const owner = {observing: false, login: null, following: false, holding: false, admin: null, taking: false};
const observer = {...owner, observing: true, login: 'toto'};
const VIEW = {view: true, write: false};
const WRITE = {view: false, write: true};

test('the owner: no reason in a free session; under control, the view controls only, naming the admin', async () => {
  const {controlReason} = await load();
  const controlled = {...owner, admin: 'root'};
  for (const kind of [VIEW, WRITE]) assert.equal(controlReason(kind, owner), '');
  assert.equal(controlReason(VIEW, controlled), 'root controls your view');
  assert.equal(controlReason(WRITE, controlled), '');
});

test('an observer: view controls disabled while following, write actions always', async () => {
  const {controlReason} = await load();
  const following = {...observer, following: true};
  assert.equal(controlReason(VIEW, following), 'The view follows toto; uncheck Follow to change it');
  assert.equal(controlReason(VIEW, observer), '', 'Follow unchecked');
  for (const state of [following, observer, {...following, admin: 'other'}]) assert.equal(controlReason(WRITE, state), 'Read-only: you observe the session of toto');
});

test('the admin in control: free view, write actions still disabled, for another reason', async () => {
  const {controlReason} = await load();
  const holding = {...observer, holding: true, admin: 'root'};
  assert.equal(controlReason(VIEW, holding), '');
  assert.equal(controlReason(WRITE, holding), 'You control the consoles of toto; this action stays with the user');
});

test('a control of both classes gives the reason Follow cannot lift; one of none has no reason', async () => {
  const {controlReason} = await load();
  const following = {...observer, following: true};
  assert.match(controlReason({view: true, write: true}, following), /^Read-only/);
  assert.equal(controlReason({view: true, write: true}, {...owner, admin: 'root'}), 'root controls your view');
  assert.equal(controlReason({view: false, write: false}, following), '');
});

test('Take control and Follow', async () => {
  const {takeControlReason, followReason} = await load();
  assert.equal(takeControlReason(observer), '');
  assert.equal(takeControlReason({...observer, admin: 'other'}), 'other already controls this session');
  assert.equal(takeControlReason({...observer, admin: 'root', holding: true}), '', 'Release control is usable');
  assert.equal(takeControlReason({...observer, taking: true}), 'Taking control…');
  assert.equal(followReason(observer), '');
  assert.match(followReason({...observer, holding: true}), /^You hold control/);
});

// An element with a title, and a MutationObserver that reports when told to.
let report = null;
globalThis.MutationObserver = class { constructor(callback) { report = callback; } observe() {} };
function fakePage(title) {
  let value = title;
  const element = {getAttribute: () => value, setAttribute: (name, text) => { assert.equal(name, 'title'); value = text; }, removeAttribute: () => { value = null; }};
  return {element, notify: () => report([{target: element}]), title: () => value};
}

test('the reason replaces the tooltip and the normal one comes back, or none when there was none', async () => {
  const {showReason} = await load();
  for (const normal of ['Next page', null]) {
    const page = fakePage(normal);
    showReason(page.element, '');
    assert.equal(page.title(), normal);
    showReason(page.element, 'A');
    showReason(page.element, 'A');
    showReason(page.element, 'B');
    page.notify();
    assert.equal(page.title(), 'B');
    showReason(page.element, '');
    page.notify();
    assert.equal(page.title(), normal);
  }
});

test('a tooltip the page changes meanwhile does not hide the reason and is the one put back', async () => {
  const {showReason} = await load();
  const page = fakePage('Layout: 1 terminal');
  showReason(page.element, 'A');
  page.element.setAttribute('title', 'Layout: 4 terminals');
  page.notify();
  assert.equal(page.title(), 'A');
  showReason(page.element, '');
  assert.equal(page.title(), 'Layout: 4 terminals');
  showReason(page.element, 'A');
  page.element.setAttribute('title', 'Layout: 2 terminals');
  showReason(page.element, '');
  assert.equal(page.title(), 'Layout: 2 terminals', 'changed just before the control is enabled again');
});

test('observe.js shows the reason on every disabled control, on the summary of a menu, and the mouse reaches it', () => {
  const observe = moduleSource('observe');
  assert.match(observe, /querySelector\(':scope > summary'\) \|\| element/);
  assert.match(observe, /showReason\(target, reason\)/);
  const css = read('css/app.css');
  assert.doesNotMatch(css, /\.(view-control|write-action) \{[^}]*pointer-events: none/);
});
