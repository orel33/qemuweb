'use strict';

// The Engine select of the header (public/engine-select.js): the pure rules (value, disabled,
// reason from the runner's engines and the state of the session), the markup (same line as QemuWeb and
// the beta badge, a real label), its removal from General Settings, and every update point of the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {moduleSource} = require('./web-ui-source');

const publicDir = path.join(__dirname, '..', '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'css', 'app.css'), 'utf8');

// The module without its imports and exports, in a context without DOM.
const source = moduleSource('engine-select').replace(/^import .*$/gm, '').replace(/^export /gm, '');
const api = vm.runInNewContext(`${source}\n({engineSelectState, hostsInUse, unavailableHostsWarning, engineSettingsNote, engineName, FROZEN_REASON})`,
  {document: {getElementById: () => null}});
const plain = value => JSON.parse(JSON.stringify(value));
const both = ['qemu', 'vbox'];

test('the options read "QEMU - KVM" and "VirtualBox" with the values qemu and vbox', () => {
  const state = plain(api.engineSelectState({engine: 'qemu', availableEngines: both, inUse: false, observing: false}));
  assert.deepEqual(state.options.map(option => [option.value, option.text]), [['qemu', 'QEMU - KVM'], ['vbox', 'VirtualBox']]);
  assert.equal(state.value, 'qemu');
  assert.equal(state.disabled, false);
  assert.equal(state.reason, '');
  assert.deepEqual(state.options.map(option => option.disabled), [false, false]);
  assert.equal(api.engineSelectState({engine: 'vbox', availableEngines: both, inUse: false, observing: false}).value, 'vbox');
});

test('the select is frozen, with its reason, while a host is up or busy', () => {
  const state = plain(api.engineSelectState({engine: 'qemu', availableEngines: both, inUse: true, observing: false}));
  assert.equal(state.disabled, true);
  assert.equal(state.reason, 'Stop all hosts to change the engine');
  assert.equal(api.FROZEN_REASON, 'Stop all hosts to change the engine');
  assert.equal(state.value, 'qemu', 'it keeps showing the engine');
});

test('an engine the runner does not have is a disabled option with a tooltip; one engine only disables the select', () => {
  const state = plain(api.engineSelectState({engine: 'qemu', availableEngines: ['qemu'], inUse: false, observing: false}));
  assert.deepEqual(state.options.map(option => [option.value, option.disabled, option.title]),
    [['qemu', false, ''], ['vbox', true, 'VirtualBox is unavailable on this server']]);
  assert.equal(state.disabled, true);
  assert.match(state.reason, /Only one engine is available/);
  const vboxOnly = plain(api.engineSelectState({engine: 'vbox', availableEngines: ['vbox'], inUse: false, observing: false}));
  assert.equal(vboxOnly.options[0].title, 'QEMU is unavailable on this server');
  assert.equal(vboxOnly.disabled, true);
});

test('an administrator observing sees the observed engine, read-only; before the settings are known nothing is enabled', () => {
  const state = plain(api.engineSelectState({engine: 'vbox', availableEngines: both, inUse: false, observing: true}));
  assert.equal(state.value, 'vbox');
  assert.equal(state.disabled, true);
  assert.match(state.reason, /observed session/);
  const unknown = plain(api.engineSelectState({engine: 'qemu', availableEngines: [], inUse: false, observing: false}));
  assert.equal(unknown.disabled, true);
  assert.equal(unknown.reason, '');
  assert.equal(api.engineSelectState({engine: 'kvm', availableEngines: both, inUse: false, observing: false}).value, '', 'an unknown engine selects nothing');
});

test('a host with a machine up or an action in progress freezes the select; stopped hosts and switches do not', () => {
  const hosts = [{kind: 'host', running: false, busy: false}, {kind: 'switch', running: true}];
  assert.equal(api.hostsInUse(hosts), false);
  assert.equal(api.hostsInUse([...hosts, {kind: 'host', running: true}]), true);
  assert.equal(api.hostsInUse([...hosts, {kind: 'host', running: false, busy: true, operation: 'starting'}]), true);
  assert.equal(api.hostsInUse(new Map([['a', {kind: 'host', running: true}]]).values()), true);
  assert.equal(api.hostsInUse([]), false);
});

test('the warning names the hosts that cannot start with the new engine', () => {
  assert.equal(api.unavailableHostsWarning([]), '');
  assert.equal(api.unavailableHostsWarning(undefined), '');
  assert.equal(api.unavailableHostsWarning([{message: 'alpine: no VirtualBox image on this server'}, {message: 'web: no VirtualBox image on this server'}]),
    'These hosts cannot start with this engine: alpine: no VirtualBox image on this server; web: no VirtualBox image on this server.');
});

test('Host Settings says which engine its values are for, and that the other engine keeps its own', () => {
  assert.equal(api.engineSettingsNote('qemu'), 'These settings are for QEMU - KVM; the VirtualBox settings of this host are kept separately.');
  assert.equal(api.engineSettingsNote('vbox'), 'These settings are for VirtualBox; the QEMU - KVM settings of this host are kept separately.');
  assert.equal(api.engineSettingsNote('x'), '');
  assert.equal(api.engineName('vbox'), 'VirtualBox');
  assert.match(html, /<p id="settings-engine-note" class="settings-engine-note"><\/p>/);
  assert.match(moduleSource('host-settings'), /getElementById\('settings-engine-note'\)\.textContent = engineSettingsNote\(machine\.engine\);/);
});

test('the header has the labelled select after the beta badge, in the h1 line; /admin has none', () => {
  assert.match(html, /aria-label="Beta version">BETA<\/span><span class="engine-picker" id="engine-picker" hidden><label for="session-engine">Engine:<\/label><select id="session-engine" disabled aria-label="Session engine"><option value="qemu">QEMU - KVM<\/option><option value="vbox">VirtualBox<\/option><\/select><\/span><\/h1>/);
  assert.ok(!html.includes('engine-badge'), 'the badge is replaced');
  for (const file of fs.readdirSync(publicDir).filter(name => name.endsWith('.html') && name !== 'index.html')) {
    assert.ok(!fs.readFileSync(path.join(publicDir, file), 'utf8').includes('session-engine'), file);
  }
  assert.ok(!fs.existsSync(path.join(publicDir, 'engine-badge.js')));
  // Same font and colour as the user name of the header (shared custom properties), same height as the header buttons.
  assert.match(css, /--header-font: [^;]+; --header-text: #b8c7d8;/);
  assert.match(css, /\.account-name \{[^}]*color: var\(--header-text\); font: var\(--header-font\);/);
  assert.match(css, /\.engine-picker \{[^}]*color: var\(--header-text\); font: var\(--header-font\);/);
  assert.match(css, /\.engine-picker select \{[^}]*font: var\(--header-font\); color: var\(--header-text\);/);
  assert.doesNotMatch(css, /\.engine-picker[^{]*\{[^}]*(?:top: 2px|position: relative)/, 'no positioning hack; the height is the --control one of the select rule');
  assert.match(css, /button, select \{ height: var\(--control\);/);
  assert.doesNotMatch(css, /\.engine-badge/);
  // Narrow widths: the label is kept for screen readers but not shown; the select stays reachable.
  assert.match(css, /@media \(max-width: 640px\) \{ \.engine-picker label \{ position: absolute;/);
  assert.doesNotMatch(css, /\.engine-picker(?!\[hidden\])[^{]*\{[^}]*display: none/, 'the select is never hidden at narrow widths');
});

test('General Settings no longer has the engine; naming scheme and console font remain', () => {
  const dialog = html.slice(html.indexOf('id="general-settings-panel"'), html.indexOf('id="qemu-options-panel"'));
  assert.ok(!/engine/i.test(dialog), 'no engine select or error line in the dialog');
  for (const id of ['naming-scheme', 'console-font-family', 'console-font-size', 'general-settings-error']) assert.ok(dialog.includes(`id="${id}"`), id);
  const settings = moduleSource('general-settings');
  assert.ok(!/engine/i.test(settings), 'the module has no engine code');
  assert.ok(!html.includes('default-engine') && !html.includes('engine-settings-error'));
});

test('the select is initialized at page start and updated by every change of the session state', () => {
  const nodes = moduleSource('nodes');
  assert.match(nodes, /store\.availableEngines = sessionSettings\.availableEngines \|\| \[\];/);
  assert.match(nodes, /showPage\(\);\s*updateEngineSelect\(\);/);
  assert.match(nodes, /bindEngineSelect\(\{/);
  assert.match(nodes, /onError: message => showStatusError\(`Cannot change the session engine: \$\{message\}`\)/);
  // A host starting, stopping or loading changes busy/running, which refreshes the controls and the select.
  assert.match(moduleSource('workspace'), /export function updateControls\(\) \{\s*updateEngineSelect\(\);/);
  assert.match(moduleSource('socket'), /renderTabs\(\);\s*updateEngineSelect\(\);/);
  assert.match(moduleSource('systems'), /updateEngineSelect\(\);/);
  // Another tab: the event reloads the system list, the hosts and the select.
  assert.match(moduleSource('socket'), /socket\.on\('general-settings-changed', event => \{[\s\S]{0,200}followEngineChange\(event\.engine\)/);
  const select = moduleSource('engine-select');
  assert.match(select, /select\.addEventListener\('change', async \(\) => \{[\s\S]{0,300}jsonRequest\('PUT', \{engine\}\)/);
  assert.match(select, /finally \{ shown = ''; updateEngineSelect\(\); \}/, 'a refusal puts the select back on the real engine');
  assert.match(select, /if \(signature === shown\) return;/, 'an open list is not rebuilt by an update that changes nothing');
  assert.match(select, /hostsInUse\(machines\.values\(\)\)/);
  assert.match(select, /inUse: hostsInUse\(machines\.values\(\)\), observing/);
});

test('the module is registered for the unit tests and its imports are on one line', () => {
  assert.ok(fs.readFileSync(path.join(__dirname, 'web-ui-source.js'), 'utf8').includes("'engine-select'"));
  for (const line of moduleSource('engine-select').split('\n')) if (line.startsWith('import ')) assert.match(line, /from '[^']+';$/);
});
