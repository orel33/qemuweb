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
  vm.runInContext(['hostCaptureBlocker', 'captureBlocker', 'formatBytes', 'interfaceLabel', 'preselectInterface', 'captureButtonState', 'shouldAutoDownload', 'captureOwnership', 'staleCaptures', 'closePlan', 'captureControls'].map(name => functionSource(source, name)).join('\n'), context);
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

test('a capture is saved once when it ended with packets: on Stop, at the size limit, when the host stopped', () => {
  const {shouldAutoDownload} = load();
  const stopped = (extra = {}) => ({id: 'a', state: 'stopped', bytes: 5000, ...extra});
  for (const reason of ['user', 'size-limit', 'host-stopped']) assert.equal(shouldAutoDownload(stopped({reason}), new Set()), true, reason);
  assert.equal(shouldAutoDownload(stopped(), new Set(['a'])), false, 'once');
  assert.equal(shouldAutoDownload({id: 'a', state: 'recording', bytes: 5000}, new Set()), false, 'not while recording');
  assert.equal(shouldAutoDownload(stopped({bytes: 24}), new Set()), false, 'a PCAP header alone is nothing');
});

test('a capture belongs to the tab that started it; a young or leased one of another tab is left alone', () => {
  const {captureOwnership} = load();
  const now = Date.parse('2026-01-01T00:00:30Z');
  const recording = (extra = {}) => ({id: 'a', state: 'recording', startedAt: '2026-01-01T00:00:00Z', ...extra});
  assert.equal(captureOwnership(recording(), new Set(['a']), new Set(), now), 'mine');
  assert.equal(captureOwnership(recording(), new Set(), new Set(['a']), now), 'other', 'leased by another tab');
  assert.equal(captureOwnership(recording(), new Set(), new Set(), now), 'free', 'nobody leases it any more');
  assert.equal(captureOwnership(recording({startedAt: '2026-01-01T00:00:25Z'}), new Set(), new Set(), now), 'other', 'its tab has not leased it yet');
  assert.equal(captureOwnership({id: 'a', state: 'stopped', startedAt: '2026-01-01T00:00:29Z'}, new Set(), new Set(), now), 'free', 'a finished leftover');
});

test('opening the dialog deletes finished files nobody leases, never a recording or another tab\'s file', () => {
  const {staleCaptures} = load();
  const captures = [{id: 'rec', state: 'recording'}, {id: 'old', state: 'stopped'}, {id: 'theirs', state: 'stopped'}];
  assert.deepEqual(staleCaptures(captures, new Set(['theirs'])).map(item => item.id), ['old']);
  assert.deepEqual(staleCaptures(captures, new Set()).map(item => item.id), ['old', 'theirs']);
});

test('closing the dialog stops and deletes what it started, deletes leftovers, leaves other tabs alone', () => {
  const {closePlan} = load();
  const captures = [{id: 'mine-rec', state: 'recording'}, {id: 'mine-old', state: 'stopped'}, {id: 'other-rec', state: 'recording'}, {id: 'other-done', state: 'stopped'}, {id: 'left', state: 'stopped'}];
  const plan = closePlan(captures, new Set(['mine-rec', 'mine-old']), new Set(['other-rec', 'other-done']));
  assert.deepEqual(plan.stop.map(item => item.id), ['mine-rec'], 'only its own recording is stopped (and asks for a confirmation)');
  assert.deepEqual(plan.remove.map(item => item.id), ['mine-rec', 'mine-old', 'left']);
  assert.deepEqual(closePlan([{id: 'x', state: 'stopped'}], new Set(), new Set()).stop, [], 'nothing recording: no question');
});

test('Play, Stop and Download are enabled by the state of the selected interface, with the reason when not', () => {
  const owners = {mine: () => 'mine', other: () => 'other'};
  const rec = (extra = {}) => ({id: 'a', index: 0, state: 'recording', bytes: 5000, startedAt: '2026-01-01T00:00:00Z', ...extra});
  const done = (extra = {}) => ({id: 'b', index: 0, state: 'stopped', bytes: 5000, startedAt: '2026-01-01T00:00:00Z', ...extra});
  // Idle, connected: only Play.
  let controls = load().captureControls(host(), [], 0, owners.mine);
  assert.deepEqual([controls.play, controls.stop === null, controls.download === null], [null, false, false]);
  assert.match(controls.stop, /Nothing is recording/);
  assert.match(controls.download, /No capture file yet/);
  // Recording, mine: Stop and Download (what was captured so far), no Play.
  controls = load({captures: [rec()]}).captureControls(host(), [rec()], 0, owners.mine);
  assert.deepEqual([controls.stop, controls.download], [null, null]);
  assert.match(controls.play, /already being captured/);
  assert.equal(controls.file.id, 'a');
  // Recording, only its header so far: Download waits.
  assert.match(load({captures: [rec({bytes: 24})]}).captureControls(host(), [rec({bytes: 24})], 0, owners.mine).download, /Nothing was captured yet/);
  // Finished: Play again and Download, not Stop.
  controls = load({captures: [done()]}).captureControls(host(), [done()], 0, owners.mine);
  assert.deepEqual([controls.play, controls.download], [null, null]);
  assert.match(controls.stop, /Nothing is recording/);
  // Another tab records: Play and Stop say why, Download is allowed.
  controls = load({captures: [rec()]}).captureControls(host(), [rec()], 0, owners.other);
  assert.match(controls.play, /another window/);
  assert.match(controls.stop, /only that window can stop it/);
  assert.equal(controls.download, null);
  assert.equal(controls.elsewhere, true);
  // The other interface has no file: Download off; its Play is the CAP01 reason when unconnected.
  controls = load({captures: [rec()]}).captureControls(host(), [rec()], 1, owners.mine);
  assert.match(controls.play, /not connected/);
  assert.match(controls.download, /No capture file yet/);
  // The reasons of CAP01 reach Play: stopped host, observer without control (which also blocks Stop and Download).
  assert.match(load().captureControls(host({running: false}), [], 0, owners.mine).play, /stopped/);
  controls = load({canCapture: false, captures: [rec()]}).captureControls(host(), [rec()], 0, owners.mine);
  assert.match(controls.stop, /Read-only observation/);
  assert.match(controls.download, /Read-only observation/);
  // A leftover nobody leases is no file to download.
  assert.match(load({captures: [done()]}).captureControls(host(), [done()], 0, () => 'free').download, /No capture file yet/);
  // The latest file of the interface is the one downloaded.
  const files = [done({id: 'old', startedAt: '2026-01-01T00:00:00Z'}), done({id: 'new', startedAt: '2026-01-01T00:05:00Z'})];
  assert.equal(load({captures: files}).captureControls(host(), files, 0, owners.mine).file.id, 'new');
});

test('the Capture dialog and the pane button are wired in the page; the old places are gone', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  for (const id of ['capture-dialog', 'capture-interface', 'capture-filter', 'capture-play', 'capture-stop', 'capture-download', 'capture-state', 'capture-note', 'capture-saved', 'capture-stop-icon', 'capture-download-icon', 'capture-live', 'capture-live-clear', 'capture-confirm', 'capture-confirm-cancel', 'capture-confirm-close', 'capture-status', 'close-capture-dialog', 'pane-capture-icon']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /<dialog class="confirm-dialog capture-dialog"/);
  assert.match(html, /The filter applies to the live view only; the PCAP file stays whole\./);
  assert.match(html, /Closing stops and discards the running capture\. Close anyway\?/);
  for (const gone of ['capture-controls', 'show-captures', 'captures-dialog', 'captures-list', 'close-captures', 'capture-tab-', 'capture-all-files', 'data-view="capture"', 'capture-toggle', 'capture-download-again']) assert.doesNotMatch(html, new RegExp(gone), `${gone} was removed`);
  const dialog = moduleSource('capture-dialog');
  assert.match(dialog, /captureControls\(machines\.get\(current\.nodeId\), capturesOf\(current\.nodeId\), current\.index, ownerOf\)/, 'the dialog takes the rules and the CAP01 reasons from captures.js');
  assert.match(dialog, /Closing the window stops and discards the capture\. Press Stop first to save it\./);
  assert.match(dialog, /dialog\.addEventListener\('cancel', event => \{ event\.preventDefault\(\); requestClose\(\); \}\)/, 'Esc asks first');
  assert.match(dialog, /emitOnSession\('capture-lease'/);
  assert.match(html, /title="Start capture" aria-label="Start capture"/);
  assert.match(html, /title="Stop capture" aria-label="Stop capture"/);
  assert.match(html, /title="Download capture \(\.pcap\)" aria-label="Download capture \(\.pcap\)"/);
  assert.match(html, /<symbol id="capture-stop-icon" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2"\/>/);
  assert.match(html, /href="#pane-play-icon"/);
  assert.doesNotMatch(html.match(/<dialog class="confirm-dialog capture-dialog"[\s\S]*?<\/dialog>/)[0], /#pane-stop-icon/, 'the power icon of the node is not the Stop of a capture');
  assert.match(dialog, /Recording\$\{elsewhere \? ' in another tab' : ''\}/);
  assert.doesNotMatch(dialog, /setPaneView|All captures/);
  assert.match(moduleSource('capture-button'), /createCaptureButton/);
  assert.match(moduleSource('terminal'), /pane\.captureButton = createCaptureButton\(pane\)/);
  assert.match(moduleSource('workspace'), /updateCaptureButton\(pane\)/);
  assert.match(moduleSource('host-settings'), /^(?![\s\S]*[Cc]apture)/, 'Host Settings has no capture section');
  const edit = moduleSource('graphic-edit');
  assert.match(edit, /label: 'Capture…'/);
  assert.match(edit, /openCaptureDialog\(link\.hostId, \{index: link\.nicIndex\}\)/);
  assert.doesNotMatch(edit, /startCapture|stopCapture|captureBlocker/, 'the popover only opens the dialog');
  assert.match(moduleSource('graphic-view'), /recording: recordingIndicator/);
  assert.match(fs.readFileSync(path.join(publicDir, 'topology-graphic.js'), 'utf8'), /recordingMark/);
  const socket = moduleSource('socket');
  assert.match(socket, /socket\.on\('captures', setCaptures\)/);
  assert.match(socket, /socket\.on\('capture-live-data', receiveLiveData\)/);
  assert.match(moduleSource('app'), /^initCaptureDialog\(\);$/m);
});

test('the pane button uses the Lucide activity icon', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /<symbol id="pane-capture-icon" viewBox="0 0 24 24"><path d="M22 12h-2\.48a2 2 0 0 0-1\.93 1\.46l-2\.35 8\.36/);
});

test('the live area keeps whole lines, the last ones, and the unfinished line', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource(moduleSource('capture-live'), 'appendLiveText'), context);
  const {appendLiveText} = context;
  let state = appendLiveText({lines: [], partial: ''}, 'one\ntw', 3);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), {lines: ['one'], partial: 'tw'});
  state = appendLiveText(state, 'o\r\nthree\nfour\nfive', 3);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), {lines: ['two', 'three', 'four'], partial: 'five'}, 'the oldest lines are dropped, \\r is ignored');
  assert.deepEqual(JSON.parse(JSON.stringify(appendLiveText({lines: ['a'], partial: ''}, '', 3))), {lines: ['a'], partial: ''});
});

test('the scrollbar drawn by xterm.js is hidden: the pane slider is the only one', () => {
  const css = fs.readFileSync(path.join(publicDir, 'css', 'app.css'), 'utf8');
  assert.match(css, /\.terminal \.xterm-scrollable-element > \.scrollbar \{ display: none !important; \}/);
  assert.match(css, /\.terminal \.xterm-viewport \{[^}]*scrollbar-width: none/);
});

test('there is no Capture view of a console pane any more', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.equal((html.match(/data-view="capture"/g) || []).length, 0);
  assert.doesNotMatch(moduleSource('terminal'), /'capture'|leaveCaptureView|showCaptureView/);
  assert.doesNotMatch(moduleSource('workspace'), /leaveCaptureView/);
  assert.match(fs.readFileSync(path.join(publicDir, 'view-state.js'), 'utf8'), /PANE_VIEWS = \['console', 'console2', 'monitor', 'log'\]/);
  const live = moduleSource('capture-live');
  assert.match(live, /emitOnSession\('capture-live', mine/);
  assert.match(live, /emitOnSession\('capture-live-stop'\)/);
});
