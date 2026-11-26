// TOD04: why a control is disabled (observation, Follow, an administrator's control) and its tooltip.
const assert = require('node:assert/strict');
const test = require('node:test');
const {moduleSource, read} = require('./web-ui-source');

const load = () => import('../../public/disabled-reason.js');
const owner = {observing: false, login: null, following: false, holding: false, admin: null, taking: false};
const observer = {...owner, observing: true, login: 'toto'};
const VIEW = {view: true, write: false};
const WRITE = {view: false, write: true};

test('the owner: no reason in a free session; under control, the view and the write actions, naming the admin', async () => {
  const {controlReason, canWrite} = await load();
  const controlled = {...owner, admin: 'root'};
  for (const kind of [VIEW, WRITE]) assert.equal(controlReason(kind, owner), '');
  assert.equal(controlReason(VIEW, controlled), 'root controls your view');
  assert.equal(controlReason(WRITE, controlled), 'root controls your session');
  assert.equal(controlReason(WRITE, controlled), 'root controls your session');
  assert.equal(canWrite(owner), true);
  assert.equal(canWrite(controlled), false, 'one driver at a time');
});

test('an observer: view controls disabled while following, write actions always', async () => {
  const {controlReason} = await load();
  const following = {...observer, following: true};
  assert.equal(controlReason(VIEW, following), 'The view follows toto; uncheck Follow to change it');
  assert.equal(controlReason(VIEW, observer), '', 'Follow unchecked');
  for (const state of [following, observer, {...following, admin: 'other'}]) {
    assert.equal(controlReason(WRITE, state), 'Read-only: you observe the session of toto');
  }
});

test('the admin in control: free view, every write action of the owner, Reset session included (UXS02)', async () => {
  const {controlReason, canWrite} = await load();
  const holding = {...observer, holding: true, admin: 'root'};
  assert.equal(controlReason(VIEW, holding), '');
  assert.equal(controlReason(WRITE, holding), '');
  assert.equal(controlReason({view: false, write: true, ownerOnly: true}, holding), '', 'no owner-only action any more');
  assert.equal(canWrite(holding), true);
  assert.equal(canWrite(observer), false, 'an observer without control');
  assert.equal(canWrite({...observer, admin: 'other'}), false, 'another admin holds control');
});

test('a control of both classes gives the reason Follow cannot lift; one of none has no reason', async () => {
  const {controlReason} = await load();
  const following = {...observer, following: true};
  assert.match(controlReason({view: true, write: true}, following), /^Read-only/);
  assert.equal(controlReason({view: true, write: true}, {...owner, admin: 'root'}), 'root controls your session', 'the write reason first');
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

test('CTL01: the write actions are greyed while the page may not write; Reset session is a plain write action (UXS02)', () => {
  const css = read('css/app.css');
  assert.match(css, /body\[data-write-blocked="true"\] \.write-action \{ opacity: \.45; \}/);
  assert.doesNotMatch(css, /body\.observing \.write-action/);
  assert.doesNotMatch(css, /owner-only/);
  assert.match(read('index.html'), /id="reset-session" class="icon-button write-action"/);
  assert.doesNotMatch(read('index.html'), /owner-only|id="delete-session"|id="exit-all"/);
  const observe = moduleSource('observe');
  assert.match(observe, /document\.body\.dataset\.writeBlocked = String\(!canWrite\(\)\)/);
  assert.doesNotMatch(observe, /ownerOnly|owner-only/);
});

test('CTL03: the owner\'s banner, short: the control first, else who observes (one, two, or how many), logins in bold', async () => {
  const {ownerBanner} = await load();
  assert.equal(ownerBanner({admin: null, observers: []}), null, 'nobody: no banner');
  assert.equal(ownerBanner({admin: null}), null);
  const control = ownerBanner({admin: 'root', observers: ['boss', 'root']});
  assert.equal(control.kind, 'control', 'the control banner replaces the observation');
  assert.equal(control.text, 'root is controlling your session');
  assert.deepEqual(control.parts, [{login: 'root'}, ' is controlling your session']);
  assert.match(control.title, /your keyboard and your actions are blocked, and root drives your view/, 'the explanation is the tooltip');
  assert.deepEqual(ownerBanner({admin: null, observers: ['root']}),
    {kind: 'observed', parts: [{login: 'root'}, ' is', ' observing your session'], text: 'root is observing your session',
      title: 'Read-only observation by root: they see your consoles and your view, and cannot type or act.'});
  const two = ownerBanner({admin: null, observers: ['boss', 'root']});
  assert.equal(two.text, 'boss and root are observing your session');
  assert.deepEqual(two.parts.filter(part => typeof part !== 'string'), [{login: 'boss'}, {login: 'root'}]);
  const three = ownerBanner({admin: null, observers: ['a', 'b', 'c']});
  assert.equal(three.text, '3 administrators are observing your session');
  assert.ok(three.parts.every(part => typeof part === 'string'), 'no login in the text, only a count');
  assert.match(three.title, /by a, b, c:/, 'the tooltip names them');
});

test('CTL03: the observer\'s banner, the same sentence form: observing, controlling, or another admin controlling', async () => {
  const {observerBanner} = await load();
  const observing = observerBanner({...observer, following: true});
  assert.equal(observing.kind, 'observing');
  assert.deepEqual(observing.parts, ['You are observing the session of ', {login: 'toto'}]);
  assert.equal(observing.text, 'You are observing the session of toto');
  assert.match(observing.title, /^Read-only: .*Your view follows the view of toto; uncheck Follow to change it\.$/);
  assert.match(observerBanner({...observer, following: false}).title, /Follow is unchecked: your view is your own\.$/);
  const controlling = observerBanner({...observer, holding: true, admin: 'root'});
  assert.equal(controlling.kind, 'controlling');
  assert.equal(controlling.text, 'You are controlling the session of toto');
  assert.match(controlling.title, /Release control to give it back\.$/);
  const other = observerBanner({...observer, admin: 'root', following: true});
  assert.equal(other.kind, 'other');
  assert.deepEqual(other.parts, [{login: 'root'}, ' is controlling the session of ', {login: 'toto'}]);
  assert.equal(other.title, 'Read-only: root holds control of the session of toto.');
});

test('CTL03: banner parts are rendered with the logins in <strong>, only them bold', async () => {
  const {renderBannerParts} = await load();
  const created = [];
  const saved = globalThis.document;
  globalThis.document = {
    createTextNode: text => ({text}),
    createElement: tag => { const element = {tag, textContent: ''}; created.push(element); return element; }
  };
  try {
    let children = null;
    renderBannerParts({replaceChildren: (...nodes) => { children = nodes; }}, [{login: 'root'}, ' is controlling your session']);
    assert.deepEqual(children, [{tag: 'strong', textContent: 'root'}, {text: ' is controlling your session'}]);
    renderBannerParts({replaceChildren: (...nodes) => { children = nodes; }});
    assert.deepEqual(children, [], 'no banner: emptied');
  } finally { globalThis.document = saved; }
  const css = read('css/app.css');
  assert.match(css, /\.observe-status strong, \.control-banner strong \{ font-weight: 700; \}/);
  assert.match(css, /\.control-banner \{[^}]*font-weight: 400; \}/);
  assert.match(css, /\.observe-banner \{[^}]*font-weight: 400; \}/);
  assert.match(css, /\.observe-banner\[data-kind="controlling"\] \{ background: #f08a5d; \}/);
});

test('CTL02: the owner\'s page shows the banner from the control state and session-observers', () => {
  const observe = moduleSource('observe');
  assert.match(observe, /const shown = ownerBanner\(\{admin: control\?\.admin \|\| null, observers\}\);/);
  assert.match(observe, /controlBanner\.dataset\.kind = shown\?\.kind \|\| '';/);
  assert.match(observe, /renderBannerParts\(controlBanner, shown\?\.parts\);/);
  assert.match(observe, /const shown = observerBanner\(controlState\(\)\);\s*renderBannerParts\(status, shown\.parts\);\s*status\.title = shown\.title;\s*banner\.dataset\.kind = shown\.kind;/);
  assert.doesNotMatch(read('index.html'), /observe-user|observe-title/, 'one sentence on the observer\'s banner');
  assert.match(observe, /const admins = ViewState\.normalizeObservers\(payload\);\s*if \(!admins\) return;/);
  assert.match(moduleSource('socket'), /socket\.on\('session-observers', applyObservers\);/);
  assert.match(read('index.html'), /class="control-banner" id="control-banner" role="status"/);
  assert.match(read('css/app.css'), /\.control-banner\[data-kind="observed"\] \{ background: #f2b84b; \}/);
});
