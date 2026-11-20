// The Load and Save dialogs of the Web interface: the pure rules (public/file-kinds.js: kind of a file by
// extension and content, which flow takes it, what the Save checkbox shows) and the wiring of the page (one Load
// button and one Save button, the removed topology buttons gone, the Examples dropdown, the replace confirmation, the checkbox).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {publicDir, moduleSource} = require('./web-ui-source');

const load = () => import('../../public/file-kinds.js');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const bytes = text => new Uint8Array(Buffer.from(text));
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

test('the kind of a local file is its extension, either case; anything else has no kind', async () => {
  const {kindOfFileName} = await load();
  assert.equal(kindOfFileName('lan.zip'), 'session');
  assert.equal(kindOfFileName('LAN.ZIP'), 'session');
  assert.equal(kindOfFileName('net.topo'), 'topology');
  assert.equal(kindOfFileName('Net.Topo'), 'topology');
  for (const name of ['notes.txt', 'lan.zip.bak', 'zip', '', 'a.topo.txt', undefined]) assert.equal(kindOfFileName(name), null, String(name));
});

test('the kind is confirmed by content: a ZIP starts with PK\\x03\\x04, a topology is UTF-8 text without NUL', async () => {
  const {contentProblem} = await load();
  assert.equal(contentProblem('session', ZIP), '');
  assert.match(contentProblem('session', bytes('SWITCH sw\n')), /not a ZIP archive/, 'a .zip that is text');
  assert.match(contentProblem('session', new Uint8Array([0x50, 0x4b])), /not a ZIP archive/);
  assert.match(contentProblem('session', new Uint8Array()), /not a ZIP archive/);
  assert.equal(contentProblem('topology', bytes('### LAN\nSWITCH sw\n')), '');
  assert.equal(contentProblem('topology', bytes('# accents é ✓\n')), '');
  assert.equal(contentProblem('topology', new Uint8Array()), '');
  assert.match(contentProblem('topology', ZIP), /not a topology/, 'a .topo that is binary');
  assert.match(contentProblem('topology', bytes('SWITCH s\0')), /binary/);
  assert.match(contentProblem('topology', new Uint8Array([0xff, 0xfe, 0x41])), /UTF-8/);
});

test('the browser and the server agree on the content of a kind', async () => {
  const {contentProblem} = await load();
  const server = require('../../server/examples');
  const samples = [ZIP, bytes('SWITCH sw\n'), bytes('x\0y'), new Uint8Array([0xc3, 0x28]), new Uint8Array(), bytes('PK'), bytes('# é\n')];
  for (const kind of ['session', 'topology']) {
    for (const sample of samples) assert.equal(contentProblem(kind, sample) === '', server.contentError(kind, Buffer.from(sample)) === null, `${kind} ${[...sample]}`);
  }
});

test('which flow takes which kind', async () => {
  const {loadFlow, kindLabel} = await load();
  assert.equal(loadFlow('session'), 'archive', 'a .zip goes into the review dialog of a session');
  assert.equal(loadFlow('topology'), 'topology', 'a .topo goes into the topology load');
  assert.equal(loadFlow(null), null);
  assert.deepEqual([kindLabel('session'), kindLabel('topology')], ['Session', 'Topology']);
});

test('the replace confirmation is required for a session ZIP when the session is not empty, never for a topology', async () => {
  const {needsReplaceConfirmation} = await load();
  assert.equal(needsReplaceConfirmation('session', 0), false, 'an empty session: no confirmation');
  assert.equal(needsReplaceConfirmation('session', 1), true);
  assert.equal(needsReplaceConfirmation('session', 7), true);
  assert.equal(needsReplaceConfirmation('topology', 0), false);
  assert.equal(needsReplaceConfirmation('topology', 5), false, 'a topology is added to the session');
  assert.equal(needsReplaceConfirmation(null, 5), false);
});

test('the confirmation text counts hosts and switches: no, 1 and N', async () => {
  const {countPhrase, replaceMessage} = await load();
  assert.deepEqual([countPhrase(0, 'host'), countPhrase(1, 'host'), countPhrase(2, 'host')], ['no host', '1 host', '2 hosts']);
  assert.deepEqual([countPhrase(0, 'switch', 'switches'), countPhrase(1, 'switch', 'switches'), countPhrase(3, 'switch', 'switches')], ['no switch', '1 switch', '3 switches']);
  assert.equal(replaceMessage(2, 1), 'Your current session has 2 hosts and 1 switch. Loading a session replaces it: they will be stopped and removed (working disks included) before the new session is loaded. To keep a copy, cancel and use Save first.');
  assert.match(replaceMessage(1, 0), /^Your current session has 1 host and no switch\./);
  assert.match(replaceMessage(0, 4), /^Your current session has no host and 4 switches\./);
});

test('an example is labelled "name · Topology|Session · size" and Load example needs a listed choice', async () => {
  const {exampleOptionLabel, canLoadExample} = await load();
  assert.equal(exampleOptionLabel({name: 'lan.zip', kind: 'session', size: 3451, description: ''}), 'lan.zip · Session · 3.4 KB');
  assert.equal(exampleOptionLabel({name: 'lan.topo', kind: 'topology', size: 372, description: 'LAN'}), 'lan.topo · Topology · 372 B');
  const list = [{name: 'lan.zip'}, {name: 'lan.topo'}];
  assert.equal(canLoadExample('', list), false, 'the placeholder');
  assert.equal(canLoadExample('lan.zip', list), true);
  assert.equal(canLoadExample('other.zip', list), false);
  assert.equal(canLoadExample('lan.zip', []), false);
  assert.equal(canLoadExample(undefined, list), false);
  assert.equal(canLoadExample(null, list), false);
});

test('the Save checkbox rule: checked disables the disk option (nothing is hidden) and downloads the topology, unchecked is the session ZIP', async () => {
  const {saveChoice} = await load();
  assert.deepEqual(saveChoice(true), {sessionOptions: false, estimate: 'Topology file: no disks', optionNote: 'Not used for a topology file', confirmLabel: 'Download topology', fileName: 'network.topo'});
  assert.deepEqual(saveChoice(false), {sessionOptions: true, estimate: null, optionNote: '', confirmLabel: 'Download ZIP', fileName: 'qemuweb-session.zip'});
});

test('sizes of the Examples dropdown are shown in B, KB, MB, GB', async () => {
  const {formatSize} = await load();
  assert.deepEqual([0, 372, 1024, 3451, 5 * 1048576, 3 * 1073741824].map(formatSize), ['0 B', '372 B', '1.0 KB', '3.4 KB', '5.0 MB', '3.00 GB']);
});

test('the toolbar has one Load and one Save button, with the session icons and the new tooltips', () => {
  for (const id of ['load-topology', 'save-topology', 'topology-file', 'session-archive-file']) assert.doesNotMatch(html, new RegExp(`id="${id}"`), id);
  const buttons = ['load-session-archive', 'save-session-archive'].map(id => new RegExp(`<button id="${id}"[^>]*>`).exec(html)?.[0]);
  assert.match(buttons[0], /title="Load a topology or a session" aria-label="Load a topology or a session"/);
  assert.match(buttons[1], /title="Save the topology or the session" aria-label="Save the topology or the session"/);
  assert.match(buttons[0], /write-action/);
  assert.match(buttons[1], /write-action/);
  assert.equal((html.match(/<svg[^>]*><rect width="20" height="5" x="2" y="3" rx="1"\/>/g) || []).length, 2, 'the two session icons are the only archive icons');
  for (const source of ['topology', 'archive', 'load-dialog', 'app']) {
    assert.doesNotMatch(moduleSource(source), /['"]load-topology['"]|['"]save-topology['"]|['"]topology-file['"]|['"]session-archive-file['"]/, source);
  }
});

test('the Load dialog: a picker of .topo and .zip, the Examples dropdown and the replace confirmation', () => {
  const dialog = /<dialog[^>]*id="load-dialog"[\s\S]*?<\/dialog>/.exec(html)?.[0];
  assert.ok(dialog, 'dialog element');
  assert.match(dialog, /<input id="load-file" type="file" accept="\.topo,\.zip">/);
  assert.match(dialog, /<section id="load-examples" hidden>/);
  assert.match(dialog, /<label[^>]*>Examples<select id="load-example-select"><option value="" disabled selected>Choose an example\.\.\.<\/option><\/select><\/label>/);
  assert.match(dialog, /<p id="load-example-description"/);
  assert.match(dialog, /<button id="load-example-button" type="button" disabled>Load example<\/button>/);
  assert.match(dialog, /<div id="load-replace" hidden>[\s\S]*id="load-replace-cancel"[^>]*>Cancel<[\s\S]*id="load-replace-continue"[^>]*>Continue</);
  assert.match(dialog, /aria-labelledby="load-dialog-title"/);
  assert.match(dialog, /id="close-load-dialog"/);
  assert.match(dialog, /<p id="load-error" role="alert" hidden>/);
  assert.doesNotMatch(html, /can only be loaded into an empty session/, 'the up-front message is gone');
  assert.doesNotMatch(html, /load-dialog-note|load-example-list|load-examples-title|session-archive-load-blocked|first remove all hosts and switches/);
  const source = moduleSource('load-dialog');
  assert.match(source, /\/api\/examples'/);
  assert.match(source, /startArchiveLoad\(file, \{example\}\)/);
  assert.match(source, /startTopologyLoad\(/);
  assert.match(source, /contentProblem\(kind, head\)/);
  assert.match(source, /await removeAllNodes\(\)/, 'the nodes are removed with the code of the Remove all button');
  assert.doesNotMatch(source, /innerHTML/, 'example names and descriptions are set as text');
  assert.doesNotMatch(moduleSource('archive'), /LoadBlocked|blocked-dialog/);
});

test('Remove all and the Load dialog share one removal, which throws instead of showing the error itself', () => {
  const nodes = moduleSource('nodes');
  assert.equal((nodes.match(/'\/api\/nodes', \{method: 'DELETE'\}/g) || []).length, 1, 'one DELETE /api/nodes in the UI');
  assert.match(nodes, /export async function removeAllNodes\(\)/);
  assert.match(nodes, /try \{ await removeAllNodes\(\); \}\s+catch \(error\) \{ showStatusError/);
});

test('an example goes through the existing flows: the session review dialog and the topology dialog stay', () => {
  const archive = moduleSource('archive');
  assert.match(archive, /export async function startArchiveLoad\(file, \{example = null\} = \{\}\)/);
  assert.match(archive, /\/api\/examples\/load/);
  assert.match(archive, /\/api\/session-archive\/import\?autoStart=/, 'an upload still goes through the import route');
  for (const id of ['load-auto-start', 'load-discard-disks', 'confirm-session-archive-load', 'cancel-session-archive-load']) assert.match(html, new RegExp(`id="${id}"`), id);
  const topology = moduleSource('topology');
  assert.match(topology, /export async function startTopologyLoad\(\{name, text, example = null\}\)/);
  assert.match(topology, /topologyExample \? '\/api\/examples\/load' : '\/api\/topology'/);
  assert.match(topology, /\/api\/topology\/preview/);
});

test('the Save dialog: the checkbox is unchecked by default, remembered in localStorage inside try/catch', () => {
  assert.match(html, /<input id="save-topology-only" type="checkbox"> Save only the topology \(\.topo\)/);
  assert.doesNotMatch(html, /id="save-topology-only"[^>]*checked/);
  assert.doesNotMatch(html, /save-session-options/, 'no wrapper hides the session options: they are disabled');
  assert.match(html, /<label><input id="include-working-disks" type="checkbox"> Include working disks<\/label>/);
  assert.match(html, /id="session-archive-estimate"/);
  const archive = moduleSource('archive');
  assert.match(archive, /try \{ return localStorage\.getItem\(topologyOnlyKey\) === 'true'; \} catch \(_\) \{ return false; \}/);
  assert.match(archive, /try \{ localStorage\.setItem\(topologyOnlyKey, String\(topologyOnlyChoice\.checked\)\); \} catch/);
  assert.match(archive, /downloadTopology\(saveChoice\(true\)\.fileName\)/);
  assert.match(archive, /qemuweb-session\.zip/);
});

test('the dialogs are native <dialog> elements with labels, and the dropdown stays inside the phone width', () => {
  for (const id of ['load-dialog', 'session-archive-dialog', 'topology-dialog']) assert.match(html, new RegExp(`<dialog[^>]*id="${id}"[^>]*aria-labelledby=`), id);
  const css = fs.readFileSync(path.join(publicDir, 'css', 'app.css'), 'utf8');
  assert.match(css, /#load-examples select \{ max-width: 100%/);
  assert.doesNotMatch(css, /\.example-item|\.example-list/);
  assert.match(css, /\.confirm-dialog \{ width: min\(440px, 94vw\)/, 'the dialog never exceeds the phone width');
});

test('the Save checkbox disables the disk option and never hides it, the estimate or the buttons', () => {
  const archive = moduleSource('archive');
  const apply = /function applySaveChoice\(\) \{[\s\S]*?\n\}\n/.exec(archive)?.[0];
  assert.ok(apply, 'applySaveChoice');
  assert.match(apply, /archiveChoice\.disabled = !choice\.sessionOptions/);
  assert.match(apply, /archiveEstimate\.textContent = choice\.estimate/);
  assert.doesNotMatch(apply, /archiveEstimate\.hidden|saveSessionOptions|archiveConfirm\.hidden|\.hidden = !choice/, 'nothing but the amber note is hidden, and that keeps its slot');
});

test('the Save and Load dialogs keep a fixed size: reserved slots, visibility instead of display, one grid cell for the Load states', () => {
  const css = fs.readFileSync(path.join(publicDir, 'css', 'app.css'), 'utf8');
  for (const id of ['archive-working-disk-warning', 'session-archive-progress', 'session-archive-error']) {
    assert.match(css, new RegExp(`#${id}\\[hidden\\] \\{ display: (?:flex|block); visibility: hidden; \\}`), `${id} keeps its slot`);
  }
  assert.match(css, /#session-archive-error \{ min-height: 3em/);
  assert.match(css, /#session-archive-estimate \{ min-height: 1\.5em/);
  assert.match(css, /#confirm-session-archive \{ min-width: 9\.5em/);
  assert.match(css, /#load-body \{ display: grid; min-height: 16rem; \}/);
  assert.match(css, /#load-picker, #load-replace \{ grid-area: 1 \/ 1;/, 'the picker and the replace confirmation share one cell');
  for (const id of ['load-picker', 'load-replace', 'load-examples', 'load-replace-status', 'load-actions', 'load-error']) {
    assert.match(css, new RegExp(`#${id}\\[hidden\\] \\{ display: (?:flex|block); visibility: hidden; \\}`), `${id} keeps its slot`);
  }
  assert.match(css, /#session-archive-dialog, #load-dialog \{ max-height: 94vh; overflow-y: auto; \}/, 'a small screen scrolls inside instead of resizing');
  assert.match(html, /<div id="load-body">\s*<div id="load-picker">[\s\S]*<div id="load-replace" hidden>/);
  for (const name of ['load-dialog', 'archive']) assert.doesNotMatch(moduleSource(name), /offsetHeight|getBoundingClientRect|clientHeight|style\.height/, `${name}.js measures nothing`);
});

test('no import statement of the new modules spans several lines', () => {
  for (const name of ['file-kinds', 'load-dialog', 'archive', 'topology']) {
    assert.doesNotMatch(moduleSource(name), /^import \{[^}\n]*$/m, name);
  }
});
