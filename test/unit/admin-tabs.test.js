// Pure rules of the tabs of /admin (public/admin-tabs-rules.js): fragment, keyboard, badges, refresh.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {publicDir} = require('./web-ui-source');

// The rules file is an ES module without imports: drop `export` and read the functions from a vm context.
function loadRules() {
  const source = fs.readFileSync(path.join(publicDir, 'admin-tabs-rules.js'), 'utf8').replace(/^export /gm, '');
  return vm.runInNewContext(`${source}\n({TABS, tabFromHash, tabForKey, badgeFor, tabLabel, panelsToRefresh})`);
}
// The vm context has its own Object and Array prototypes: bring every result into this realm so that strict comparisons work.
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const rules = loadRules();
const TABS = plain(rules.TABS);
const wrap = fn => (...args) => plain(fn(...args.map(plain)));
const {tabFromHash, tabForKey, badgeFor, tabLabel, panelsToRefresh} = Object.fromEntries(
  ['tabFromHash', 'tabForKey', 'badgeFor', 'tabLabel', 'panelsToRefresh'].map(name => [name, wrap(rules[name])]));

test('the tabs are Sessions, Accounts, Runners, WebSocket, Logs, each with a panel id present in admin.html', () => {
  assert.deepEqual(TABS.map(tab => tab.label), ['Sessions', 'Accounts', 'Runners', 'WebSocket', 'Logs']);
  const html = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');
  for (const tab of TABS) assert.match(html, new RegExp(`<section id="${tab.panel}"`), tab.id);
  assert.match(html, /id="admin-tabs" role="tablist"/);
  assert.match(html, /<title>QemuWeb · Admin<\/title>/);
});

test('the URL fragment gives the tab; unknown or empty means Sessions', () => {
  for (const tab of TABS) assert.equal(tabFromHash(`#${tab.id}`), tab.id);
  assert.equal(tabFromHash('runners'), 'runners');
  for (const hash of ['', '#', '#nope', '#Runners', '#runners/x', undefined, null]) assert.equal(tabFromHash(hash), 'sessions', String(hash));
});

test('arrow keys wrap, Home and End jump, other keys do nothing', () => {
  assert.equal(tabForKey(TABS, 'sessions', 'ArrowRight'), 'accounts');
  assert.equal(tabForKey(TABS, 'logs', 'ArrowRight'), 'sessions');
  assert.equal(tabForKey(TABS, 'sessions', 'ArrowLeft'), 'logs');
  assert.equal(tabForKey(TABS, 'runners', 'ArrowLeft'), 'accounts');
  assert.equal(tabForKey(TABS, 'runners', 'Home'), 'sessions');
  assert.equal(tabForKey(TABS, 'runners', 'End'), 'logs');
  for (const key of ['Enter', ' ', 'a', 'ArrowDown', 'Tab']) assert.equal(tabForKey(TABS, 'runners', key), null, key);
});

test('the Runners badge counts offline, lost and paused runners; warning when one is offline or lost', () => {
  const runner = (state, paused = false) => ({state, paused});
  assert.equal(badgeFor('runners', {runners: [runner('online'), runner('starting')]}), null);
  assert.deepEqual(badgeFor('runners', {runners: [runner('online'), runner('offline')]}), {count: 1, level: 'warning', text: '1 offline'});
  assert.deepEqual(badgeFor('runners', {runners: [runner('lost'), runner('offline'), runner('online', true)]}), {count: 3, level: 'warning', text: '2 offline, 1 paused'});
  assert.deepEqual(badgeFor('runners', {runners: [runner('online', true)]}), {count: 1, level: 'neutral', text: '1 paused'});
  assert.equal(badgeFor('runners', {runners: [runner('revoked')]}), null);
  assert.equal(badgeFor('runners', {}), null);
});

test('the WebSocket badge counts connections on polling', () => {
  assert.equal(badgeFor('websocket', {total: 2, websocket: 2, polling: 0, items: []}), null);
  assert.deepEqual(badgeFor('websocket', {total: 3, websocket: 1, polling: 2, items: []}), {count: 2, level: 'warning', text: '2 on polling'});
  assert.equal(badgeFor('websocket', null), null);
});

test('the Sessions and Accounts badges are neutral counts; Logs has none', () => {
  const sessions = [{login: 'a', active: true}, {login: 'b', active: false}, {login: 'c', active: true}];
  assert.deepEqual(badgeFor('sessions', sessions), {count: 2, level: 'neutral', text: '2 active'});
  assert.equal(badgeFor('sessions', [{active: false}]), null);
  assert.deepEqual(badgeFor('accounts', [{login: 'a', disabled: true}, {login: 'b'}]), {count: 1, level: 'neutral', text: '1 disabled'});
  assert.equal(badgeFor('accounts', [{login: 'b'}]), null);
  assert.equal(badgeFor('logs', []), null);
});

test('the accessible name of a tab carries the badge text', () => {
  assert.equal(tabLabel('Runners', {count: 2, level: 'warning', text: '2 offline'}), 'Runners, 2 offline');
  assert.equal(tabLabel('Runners', null), 'Runners');
});

test('only the visible tab refreshes, and none while the page is hidden', () => {
  assert.deepEqual(panelsToRefresh({activeId: 'runners', pageVisible: true}), ['runners']);
  assert.deepEqual(panelsToRefresh({activeId: 'runners', pageVisible: false}), []);
  assert.deepEqual(panelsToRefresh({activeId: null, pageVisible: true}), []);
});

test('admin.js has one tab-driven refresh and no interval refreshing every panel', () => {
  const source = fs.readFileSync(path.join(publicDir, 'admin.js'), 'utf8');
  assert.doesNotMatch(source, /setInterval/);
  assert.doesNotMatch(source, /POLL_MS/);
  const tabs = fs.readFileSync(path.join(publicDir, 'admin-tabs.js'), 'utf8');
  assert.match(tabs, /visibilitychange/);
  assert.match(tabs, /history\.replaceState/);
  assert.match(tabs, /hashchange/);
});

test('ADM02: the log view is resizable in height, remembered in the browser; the Download link has its icon', () => {
  const html = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');
  const css = fs.readFileSync(path.join(publicDir, 'css', 'app.css'), 'utf8');
  const admin = fs.readFileSync(path.join(publicDir, 'admin.js'), 'utf8');
  const rule = css.match(/\.admin-log-view \{[^}]*\}/)[0];
  for (const declaration of [/height: 60vh/, /min-height: 160px/, /max-height: 85vh/, /resize: vertical/]) assert.match(rule, declaration);
  assert.match(css, /@media \(max-width: 640px\) \{ \.admin-log-view \{ height: 260px !important; resize: none; \} \}/, 'a phone keeps a fixed height');
  assert.match(admin, /const LOG_HEIGHT_KEY = 'qemuweb\.admin-log-height';/);
  assert.match(admin, /try \{ height = Number\(localStorage\.getItem\(LOG_HEIGHT_KEY\)\); \} catch \(_\) \{\}/);
  assert.match(admin, /try \{ localStorage\.setItem\(LOG_HEIGHT_KEY, String\(Math\.round\(chosen\)\)\); \} catch \(_\) \{\}/);
  assert.match(admin, /restoreLogHeight\(\);/);
  const link = html.match(/<a id="log-download"[^>]*>([\s\S]*?)<\/a>/);
  assert.match(link[0], /title="Download the raw JSON lines file"/);
  assert.match(link[1], /^<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"[^>]*>.*<\/svg>Download$/, 'the icon, then the text');
  assert.doesNotMatch(link[0], /aria-label/, 'the accessible name stays the text');
});
