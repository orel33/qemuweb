// The Load and Save dialogs of the Web interface: the pure rules (public/file-kinds.js: kind of a file by
// extension and content, which flow takes it, what the Save checkbox shows) and the wiring of the page (one Load
// button and one Save button, the removed topology buttons gone, the Examples list, the checkbox).
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

test('which flow takes which kind, and which kind needs an empty session', async () => {
  const {loadFlow, needsEmptySession, kindLabel} = await load();
  assert.equal(loadFlow('session'), 'archive', 'a .zip goes into the review dialog of a session');
  assert.equal(loadFlow('topology'), 'topology', 'a .topo goes into the topology load');
  assert.equal(loadFlow(null), null);
  assert.equal(needsEmptySession('session'), true);
  assert.equal(needsEmptySession('topology'), false);
  assert.deepEqual([kindLabel('session'), kindLabel('topology')], ['Session', 'Topology']);
});

test('the Save checkbox rule: checked hides the session options and downloads the topology, unchecked is the session ZIP', async () => {
  const {saveChoice} = await load();
  assert.deepEqual(saveChoice(true), {sessionOptions: false, confirmLabel: 'Download .topo', fileName: 'network.topo'});
  assert.deepEqual(saveChoice(false), {sessionOptions: true, confirmLabel: 'Download ZIP', fileName: 'qemuweb-session.zip'});
});

test('sizes of the Examples list are shown in B, KB, MB, GB', async () => {
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

test('the Load dialog: a picker of .topo and .zip, the empty-session message, the Examples list, Cancel', () => {
  const dialog = /<dialog[^>]*id="load-dialog"[\s\S]*?<\/dialog>/.exec(html)?.[0];
  assert.ok(dialog, 'dialog element');
  assert.match(dialog, /<input id="load-file" type="file" accept="\.topo,\.zip">/);
  assert.match(dialog, /A session can only be loaded into an empty session/);
  assert.match(dialog, /<section id="load-examples"[^>]*hidden>[\s\S]*<h3[^>]*>Examples<\/h3>[\s\S]*<ul id="load-example-list"/);
  assert.match(dialog, /aria-labelledby="load-dialog-title"/);
  assert.match(dialog, /id="close-load-dialog"/);
  assert.match(dialog, /<p id="load-error" role="alert" hidden>/);
  const source = moduleSource('load-dialog');
  assert.match(source, /\/api\/examples'/);
  assert.match(source, /startArchiveLoad\(file, \{example\}\)/);
  assert.match(source, /startTopologyLoad\(/);
  assert.match(source, /contentProblem\(kind, head\)/);
  assert.doesNotMatch(source, /innerHTML/, 'example names and descriptions are set as text');
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
  const options = /<div id="save-session-options">[\s\S]*?id="archive-working-disk-warning"/.exec(html)?.[0];
  assert.match(options, /id="include-working-disks"/, 'the working disk option is inside the part the checkbox hides');
  assert.match(html, /id="session-archive-estimate"/);
  const archive = moduleSource('archive');
  assert.match(archive, /try \{ return localStorage\.getItem\(topologyOnlyKey\) === 'true'; \} catch \(_\) \{ return false; \}/);
  assert.match(archive, /try \{ localStorage\.setItem\(topologyOnlyKey, String\(topologyOnlyChoice\.checked\)\); \} catch/);
  assert.match(archive, /downloadTopology\(saveChoice\(true\)\.fileName\)/);
  assert.match(archive, /qemuweb-session\.zip/);
});

test('the dialogs are native <dialog> elements with labels, and a phone width rule exists for the example list', () => {
  for (const id of ['load-dialog', 'session-archive-dialog', 'topology-dialog']) assert.match(html, new RegExp(`<dialog[^>]*id="${id}"[^>]*aria-labelledby=`), id);
  const css = fs.readFileSync(path.join(publicDir, 'css', 'app.css'), 'utf8');
  assert.match(css, /\.example-item \{[^}]*grid-template-columns/);
  assert.match(css, /\.confirm-dialog \{ width: min\(440px, 94vw\)/, 'the dialog never exceeds the phone width');
  assert.match(css, /\.example-list \{[^}]*overflow-y: auto/);
});

test('no import statement of the new modules spans several lines', () => {
  for (const name of ['file-kinds', 'load-dialog', 'archive', 'topology']) {
    assert.doesNotMatch(moduleSource(name), /^import \{[^}\n]*$/m, name);
  }
});
