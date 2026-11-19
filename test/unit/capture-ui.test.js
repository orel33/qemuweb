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
  vm.runInContext(['hostCaptureBlocker', 'captureBlocker', 'formatBytes', 'interfaceLabel', 'preselectInterface', 'captureButtonState'].map(name => functionSource(source, name)).join('\n'), context);
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

test('interfaces are named by the switch they are connected to', () => {
  const {interfaceLabel} = load();
  assert.equal(interfaceLabel(0, 'lan'), 'Ethernet 0 · to switch lan');
  assert.equal(interfaceLabel(1, ''), 'Ethernet 1 · not connected');
  assert.equal(interfaceLabel(2, undefined), 'Ethernet 2 · not connected');
});

test('the dialog preselects the interface being recorded, else the first connected one', () => {
  const {preselectInterface} = load();
  const recording = index => ({index, state: 'recording'});
  assert.equal(preselectInterface(host({interfaces: [null, 's-1']}), []), 1, 'the only connected interface');
  assert.equal(preselectInterface(host({interfaces: ['s-1', 's-2']}), []), 0);
  assert.equal(preselectInterface(host({interfaces: ['s-1', 's-2']}), [recording(1)]), 1, 'the recording one wins');
  assert.equal(preselectInterface(host({interfaces: ['s-1', 's-2']}), [{index: 1, state: 'stopped'}]), 0, 'a stopped capture does not');
  assert.equal(preselectInterface(host({interfaces: [null, null]}), []), 0, 'none connected: Ethernet 0, with its reason');
  assert.equal(preselectInterface(host({interfaces: undefined}), []), 0);
});

test('the pane button is hidden for a switch or an empty pane, disabled with a reason, red while recording', () => {
  const {captureButtonState} = load();
  assert.equal(captureButtonState(undefined, []).hidden, true);
  assert.equal(captureButtonState(null, []).hidden, true);
  assert.equal(captureButtonState({id: 's-1', kind: 'switch'}, []).hidden, true);
  const idle = captureButtonState(host(), []);
  assert.deepEqual({hidden: idle.hidden, disabled: idle.disabled, recording: idle.recording}, {hidden: false, disabled: false, recording: 0});
  assert.equal(captureButtonState(host({running: false}), []).disabled, false, 'a stopped host still has files to download');
  const vbox = captureButtonState(host({engine: 'vbox'}), []);
  assert.equal(vbox.disabled, true);
  assert.match(vbox.title, /QEMU hosts only/);
  const observer = load({canCapture: false}).captureButtonState(host(), []);
  assert.equal(observer.hidden, false);
  assert.equal(observer.disabled, true);
  assert.match(observer.title, /Read-only observation/);
  const two = captureButtonState(host(), [{state: 'recording'}, {state: 'recording'}, {state: 'stopped'}]);
  assert.equal(two.recording, 2);
  assert.match(two.title, /recording 2 interfaces/);
  assert.match(captureButtonState(host(), [{state: 'recording'}]).title, /recording 1 interface$/);
});

test('the Capture dialog and the pane button are wired in the page; the old places are gone', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  for (const id of ['capture-dialog', 'capture-tab-host', 'capture-tab-all', 'capture-panel-host', 'capture-panel-all', 'capture-interface', 'capture-toggle', 'capture-state', 'capture-hint', 'capture-files', 'capture-all-files', 'capture-status', 'close-capture-dialog', 'pane-capture-icon']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /<dialog class="confirm-dialog capture-dialog"/);
  assert.match(html, /Records what this interface sends and receives\. Open the file in Wireshark\./);
  for (const gone of ['capture-controls', 'show-captures', 'captures-dialog', 'captures-list', 'close-captures']) assert.doesNotMatch(html, new RegExp(gone), `${gone} was removed`);
  const dialog = moduleSource('capture-dialog');
  assert.match(dialog, /Open live view/);
  assert.match(dialog, /setPaneView\(pane, 'capture'\);\s*chooseLiveCapture\(pane, capture\.id\)/);
  assert.match(dialog, /captureBlocker\(machine, current\.index\)/, 'the dialog reuses the CAP01 reasons');
  assert.match(dialog, /Start capture/);
  assert.match(dialog, /Stop capture/);
  assert.match(moduleSource('capture-button'), /createCaptureButton/);
  assert.match(moduleSource('terminal'), /pane\.captureButton = createCaptureButton\(pane\)/);
  assert.match(moduleSource('workspace'), /updateCaptureButton\(pane\)/);
  assert.match(moduleSource('host-settings'), /^(?![\s\S]*[Cc]apture)/, 'Host Settings has no capture section');
  const edit = moduleSource('graphic-edit');
  assert.match(edit, /label: 'Capture'/);
  assert.match(edit, /label: 'Stop capture'/);
  assert.match(edit, /captureBlocker\(host, link\.nicIndex\)/);
  assert.match(edit, /openCaptureDialog\(link\.hostId, \{index: link\.nicIndex\}\)/);
  assert.match(moduleSource('graphic-view'), /recording: recordingIndicator/);
  assert.match(fs.readFileSync(path.join(publicDir, 'topology-graphic.js'), 'utf8'), /recordingMark/);
  assert.match(moduleSource('socket'), /socket\.on\('captures', setCaptures\)/);
  assert.match(moduleSource('app'), /^initCaptureDialog\(\);$/m);
});

test('the scrollbar drawn by xterm.js is hidden: the pane slider is the only one', () => {
  const css = fs.readFileSync(path.join(publicDir, 'css', 'app.css'), 'utf8');
  assert.match(css, /\.terminal \.xterm-scrollable-element > \.scrollbar \{ display: none !important; \}/);
  assert.match(css, /\.terminal \.xterm-viewport \{[^}]*scrollbar-width: none/);
});

test('the Capture view is one more view of every pane, for QEMU hosts and the right to capture only', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.equal((html.match(/data-view="capture"/g) || []).length, 4);
  assert.equal((html.match(/data-view="capture"[^>]*hidden/g) || []).length, 4, 'hidden until a QEMU host is shown');
  const terminal = moduleSource('terminal');
  assert.match(terminal, /\['console', 'console2', 'monitor', 'log', 'capture'\]\.includes\(view\)/);
  assert.match(terminal, /view === 'capture'\) return MonitorTerminal\.isSupported\(machine\) && canCapture\(\) \? view : 'console'/);
  assert.match(terminal, /pane\.view === 'capture' && \(!monitorSupported \|\| !canCapture\(\)\)/, 'the view falls back to the console');
  assert.match(terminal, /if \(pane\.view === 'capture'\) leaveCaptureView\(pane\)/, 'leaving the view ends the live capture');
  assert.match(moduleSource('workspace'), /leaveCaptureView\(pane\);\s*pane\.view = 'console'/, 'changing the node ends it too');
  assert.match(fs.readFileSync(path.join(publicDir, 'view-state.js'), 'utf8'), /PANE_VIEWS = \['console', 'console2', 'monitor', 'log', 'capture'\]/);
  const live = moduleSource('capture-live');
  assert.match(live, /socket\.emit\('capture-live', \{nodeId: pane\.machineId, captureId, filter\}/);
  assert.match(live, /socket\.emit\('capture-live-stop'\)/);
  assert.match(live, /FILTER_MAX = 200/);
});
