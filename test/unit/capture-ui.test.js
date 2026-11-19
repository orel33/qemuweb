// Traffic capture in the Web interface (public/captures.js and its users): the reasons a capture
// cannot start, sizes, and the places the controls and indicators are wired. The module needs a
// DOM, so its pure functions are evaluated with stubs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {moduleSource, functionSource, publicDir} = require('./web-ui-source');

function load({canCapture = true, captures = [], limits = {maxPerNode: 4}} = {}) {
  const source = moduleSource('captures');
  const context = {canCapture: () => canCapture, capturesOf: () => captures, isRecording: capture => capture.state !== 'stopped', limits};
  vm.createContext(context);
  vm.runInContext(`${functionSource(source, 'captureBlocker')}\n${functionSource(source, 'formatBytes')}`, context);
  return context;
}
const host = (extra = {}) => ({id: 'h-1', kind: 'host', engine: 'qemu', running: true, busy: false, pendingRestart: false, interfaces: ['s-1', null], ...extra});

test('a capture cannot start on a stopped, busy, VirtualBox, unconnected or observed host, and says why', () => {
  const {captureBlocker} = load();
  assert.equal(captureBlocker(host(), 0), null);
  assert.match(captureBlocker(host({running: false}), 0), /stopped/);
  assert.match(captureBlocker(host({engine: 'vbox'}), 0), /QEMU hosts only/);
  assert.match(captureBlocker(host({busy: true}), 0), /busy/);
  assert.match(captureBlocker(host({pendingRestart: true}), 0), /restart/);
  assert.match(captureBlocker(host(), 1), /not connected/);
  assert.match(captureBlocker(host(), 3), /not connected/);
  assert.match(load({canCapture: false}).captureBlocker(host(), 0), /Read-only observation/);
});

test('the four-capture limit blocks a new capture, not the stop of a running one', () => {
  const four = ['a', 'b', 'c', 'd'].map((id, index) => ({id, index, state: 'stopped'}));
  assert.match(load({captures: four}).captureBlocker(host(), 0), /at most 4 captures/);
  const running = [{id: 'a', index: 0, state: 'recording'}, ...four.slice(1)];
  assert.equal(load({captures: running}).captureBlocker(host(), 0), null, 'the interface being captured offers Stop');
});

test('sizes are shown in B, KB and MB', () => {
  const {formatBytes} = load();
  assert.equal(formatBytes(24), '24 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(100 * 1024 * 1024), '100.0 MB');
});

test('the controls and indicators are wired in the page', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  for (const id of ['capture-controls', 'show-captures', 'captures-dialog', 'captures-list', 'close-captures']) assert.match(html, new RegExp(`id="${id}"`), id);
  const nav = html.match(/<nav class="machines"[\s\S]*?<\/nav>/)[0];
  assert.ok(nav.includes('id="show-captures"'), 'the session list button is in the bottom toolbar');
  const edit = moduleSource('graphic-edit');
  assert.match(edit, /label: 'Capture'/);
  assert.match(edit, /label: 'Stop capture'/);
  assert.match(edit, /captureBlocker\(host, link\.nicIndex\)/);
  assert.match(moduleSource('graphic-view'), /recording: recordingIndicator/);
  assert.match(fs.readFileSync(path.join(publicDir, 'topology-graphic.js'), 'utf8'), /recordingMark/);
  assert.match(moduleSource('socket'), /socket\.on\('captures', setCaptures\)/);
  assert.match(moduleSource('host-settings'), /showHostCaptures\(captureControls, machine\.id\)/);
  assert.match(moduleSource('app'), /^initCaptures\(\);$/m);
});
