// The Load menu and the Load Session, Load Topology and Save dialogs of the Web interface: the pure rules
// (public/file-kinds.js: kind of a file by extension and content, where a file goes, the Save status line, the warning
// and the timing of the closing of the previous session, the menu item states) and the wiring of the page (one Load
// and one Save button, the menu, the two Load dialogs with one structure, a fixed size).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {publicDir, moduleSource} = require('./web-ui-source');

const load = () => import('../../public/file-kinds.js');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'css', 'app.css'), 'utf8');
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

test('the kind is confirmed by content: a ZIP starts with PK\\x03\\x04, a topology is UTF-8 text without control characters', async () => {
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

test('a chosen file goes to the Load Session dialog (zip) or the Load Topology dialog (topo); a mismatch or another kind is refused', async () => {
  const {routeFile} = await load();
  assert.deepEqual(routeFile('lan.zip', ZIP), {kind: 'session', dialog: 'session'});
  assert.deepEqual(routeFile('LAN.ZIP', ZIP), {kind: 'session', dialog: 'session'});
  assert.deepEqual(routeFile('lan.topo', bytes('SWITCH sw\n')), {kind: 'topology', dialog: 'topology'});
  assert.match(routeFile('fake.zip', bytes('SWITCH sw\n')).error, /^fake\.zip: This file is not a ZIP archive/);
  assert.match(routeFile('fake.topo', ZIP).error, /^fake\.topo: This file is not a topology/);
  assert.match(routeFile('fake.topo', bytes('a\0b')).error, /binary/);
  assert.match(routeFile('notes.txt', bytes('x')).error, /Choose a \.topo \(topology\) or \.zip \(session\) file/);
  assert.equal(routeFile('fake.zip', bytes('SWITCH sw\n')).dialog, undefined);
});

test('the counts read "no host", "1 host", "2 hosts"; the nodes are counted by kind', async () => {
  const {countPhrase, nodeCounts} = await load();
  assert.deepEqual([countPhrase(0, 'host'), countPhrase(1, 'host'), countPhrase(2, 'host')], ['no host', '1 host', '2 hosts']);
  assert.deepEqual([countPhrase(0, 'switch', 'switches'), countPhrase(1, 'switch', 'switches'), countPhrase(3, 'switch', 'switches')], ['no switch', '1 switch', '3 switches']);
  assert.deepEqual(nodeCounts([{kind: 'host'}, {kind: 'host'}, {kind: 'switch'}, {kind: 'x'}]), {hosts: 2, switches: 1});
  assert.deepEqual(nodeCounts(new Map([['a', {kind: 'host'}]]).values()), {hosts: 1, switches: 0});
  assert.deepEqual(nodeCounts([]), {hosts: 0, switches: 0});
});

test('the Save status line is one message with the counts, the empty session says so', async () => {
  const {saveStatusLine} = await load();
  assert.equal(saveStatusLine(4, 2), 'Save your current session: 4 hosts and 2 switches.');
  assert.equal(saveStatusLine(1, 1), 'Save your current session: 1 host and 1 switch.');
  assert.equal(saveStatusLine(2, 0), 'Save your current session: 2 hosts and no switch.');
  assert.equal(saveStatusLine(0, 3), 'Save your current session: no host and 3 switches.');
  assert.equal(saveStatusLine(0, 0), 'Your current session is empty.');
});

test('the Save checkbox changes the rule, not the line or the button: the disk option is disabled, nothing is hidden', async () => {
  const {saveChoice} = await load();
  assert.deepEqual(saveChoice(true), {sessionOptions: false, optionNote: 'Not used for a topology file', fileName: 'network.topo'});
  assert.deepEqual(saveChoice(false), {sessionOptions: true, optionNote: '', fileName: 'qemuweb-session.zip'});
});

test('the orange warning names the session that will be closed; an empty session has none', async () => {
  const {closeWarning, closedText} = await load();
  assert.equal(closeWarning(4, 2), 'Your current session (4 hosts and 2 switches) will be closed and its working disks discarded.');
  assert.equal(closeWarning(1, 0), 'Your current session (1 host and no switch) will be closed and its working disks discarded.');
  assert.equal(closeWarning(0, 1), 'Your current session (no host and 1 switch) will be closed and its working disks discarded.');
  assert.equal(closeWarning(0, 0), '');
  assert.equal(closedText(2, 1), 'Closed 2 hosts and 1 switch');
});

test('the previous session is closed only at Load, after the file was read and checked, and only once', async () => {
  const {shouldCloseSession} = await load();
  assert.equal(shouldCloseSession({reviewed: false, confirmed: false, nodeCount: 6}), false, 'when the dialog opens');
  assert.equal(shouldCloseSession({reviewed: false, confirmed: true, nodeCount: 6}), false, 'the file was not read and checked (unreadable, invalid)');
  assert.equal(shouldCloseSession({reviewed: true, confirmed: false, nodeCount: 6}), false, 'before the user presses Load');
  assert.equal(shouldCloseSession({reviewed: true, confirmed: true, nodeCount: 6}), true);
  assert.equal(shouldCloseSession({reviewed: true, confirmed: true, nodeCount: 0}), false, 'an empty session, or one already closed by a first try');
  assert.equal(shouldCloseSession({confirmed: true, nodeCount: 6}), false);
  assert.equal(shouldCloseSession({reviewed: 'yes', confirmed: true, nodeCount: 6}), false);
});

test('the timing is wired the same way in both dialogs: nothing closes on open, a failed read or check never closes', () => {
  const archive = moduleSource('archive');
  const topology = moduleSource('topology');
  const steps = moduleSource('load-steps');
  assert.equal((steps.match(/await removeAllNodes\(\)/g) || []).length, 1, 'one removal, in the shared Close step');
  for (const [name, source] of [['archive', archive], ['topology', topology]]) {
    assert.equal((source.match(/closePreviousSession\(/g) || []).length, 1, `${name}.js closes the session in one place`);
    assert.match(source, /closePreviousSession\([A-Za-z]+, \{reviewed: [A-Za-z]+\}\)/, name);
    assert.doesNotMatch(source, /removeAllNodes/, `${name}.js never removes nodes itself`);
    assert.match(source, /The previous session was closed: the current session is empty\./, `${name}.js says the session is empty after a failed load`);
  }
  assert.match(archive, /archiveReviewed = false;/, 'a new review starts unreviewed');
  assert.match(archive, /loadSteps\.set\('read', 'error', 'Cannot read the archive: it is not a QemuWeb session\. Nothing was changed\.'\);\s+return;/);
  assert.match(archive, /Cannot check base images: [^\n]*Nothing was changed\.`\);\s+return;/);
  assert.match(topology, /topologyReviewed = true;/);
  assert.match(topology, /Nothing was changed\./);
  assert.doesNotMatch(topology, /closePrevious\b[^(]|close-previous/, 'no "Close previous sessions" option any more');
});

test('the "From Server (Examples)" item is enabled when the server has examples, else disabled with its reason', async () => {
  const {serverItemState} = await load();
  assert.deepEqual(serverItemState([{name: 'lan.zip'}]), {disabled: false, label: 'From Server (Examples)'});
  assert.deepEqual(serverItemState([]), {disabled: true, label: 'No examples on the server'});
  assert.deepEqual(serverItemState(null), {disabled: true, label: 'No examples on the server'});
  assert.deepEqual(serverItemState(undefined), {disabled: true, label: 'No examples on the server'});
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

test('sizes of the examples are shown in B, KB, MB, GB', async () => {
  const {formatSize} = await load();
  assert.deepEqual([0, 372, 1024, 3451, 5 * 1048576, 3 * 1073741824].map(formatSize), ['0 B', '372 B', '1.0 KB', '3.4 KB', '5.0 MB', '3.00 GB']);
});

test('the toolbar has one Load button (a menu) and one Save button, with the session icons and the tooltips', () => {
  for (const id of ['load-topology', 'save-topology', 'topology-file', 'session-archive-file']) assert.doesNotMatch(html, new RegExp(`id="${id}"`), id);
  const buttons = ['load-session-archive', 'save-session-archive'].map(id => new RegExp(`<button id="${id}"[^>]*>`).exec(html)?.[0]);
  assert.match(buttons[0], /title="Load a topology or a session" aria-label="Load a topology or a session"/);
  assert.match(buttons[0], /aria-haspopup="menu" aria-expanded="false" aria-controls="load-menu"/);
  assert.match(buttons[1], /title="Save the topology or the session" aria-label="Save the topology or the session"/);
  assert.match(buttons[0], /write-action/, 'an observer cannot load');
  assert.match(buttons[1], /write-action/);
  assert.equal((html.match(/<svg[^>]*><rect width="20" height="5" x="2" y="3" rx="1"\/>/g) || []).length, 2, 'the two session icons are the only archive icons');
  for (const source of ['topology', 'archive', 'load-menu', 'app']) {
    assert.doesNotMatch(moduleSource(source), /['"]load-topology['"]|['"]save-topology['"]|['"]topology-file['"]|['"]session-archive-file['"]/, source);
  }
});

test('the Load menu opens upwards with two items; the file picker takes .topo and .zip; the examples have a small dialog', () => {
  assert.match(html, /<div id="load-menu" class="load-menu" role="menu" aria-label="Load" hidden>\s*<button id="load-from-files" type="button" role="menuitem">From User Files<\/button>\s*<button id="load-from-server" type="button" role="menuitem">From Server \(Examples\)<\/button>/);
  assert.match(html, /<input id="load-file" type="file" accept="\.topo,\.zip" hidden>/);
  const examples = /<dialog[^>]*id="examples-dialog"[\s\S]*?<\/dialog>/.exec(html)?.[0];
  assert.ok(examples, 'examples dialog');
  assert.match(examples, /aria-labelledby="examples-title"/);
  assert.match(examples, /<label[^>]*>Examples<select id="load-example-select"><option value="" disabled selected>Choose an example\.\.\.<\/option><\/select><\/label>/);
  assert.match(examples, /<p id="load-example-description"/);
  assert.match(examples, /<button id="load-example-button" type="button" disabled>Load example<\/button>/);
  assert.match(examples, /<p id="load-error" role="alert" hidden>/);
  assert.doesNotMatch(html, /id="load-dialog"|load-replace|load-picker|load-body|can only be loaded into an empty session|session-archive-load-blocked/);
  const source = moduleSource('load-menu');
  assert.match(source, /menu\.style\.bottom = /, 'positioned above the button');
  assert.match(source, /aria-expanded/);
  for (const key of ['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End']) assert.match(source, new RegExp(`'${key}'`), key);
  assert.match(source, /closeMenu\(\{restoreFocus: true\}\)/, 'Esc returns the focus to the button');
  assert.match(source, /document\.addEventListener\('click', outsideClick, true\)/, 'a click outside closes it');
  assert.match(source, /startArchiveLoad\(file, \{example\}\)/);
  assert.match(source, /startTopologyLoad\(/);
  assert.match(source, /routeFile\(file\.name, head\)/);
  assert.doesNotMatch(source, /innerHTML/, 'example names and descriptions are set as text');
  assert.match(css, /\.load-menu \{ position: fixed;[^}]*max-width: calc\(100vw - 16px\)/, 'fixed and inside the phone screen');
  assert.match(css, /\.load-menu\[hidden\] \{ display: none; \}/);
});

test('Load Session and Load Topology share one structure, one stylesheet and one steps module', () => {
  const dialogs = ['session-archive-load-dialog', 'topology-dialog'].map(id => new RegExp(`<dialog class="confirm-dialog load-review" id="${id}"[\\s\\S]*?</dialog>`).exec(html)?.[0]);
  assert.match(dialogs[0], /<h2 id="session-archive-load-title">Load Session<\/h2>/);
  assert.match(dialogs[1], /<h2 id="topology-title">Load Topology<\/h2>/);
  for (const dialog of dialogs) {
    assert.match(dialog, /<p class="load-review-file"/);
    assert.match(dialog, /<ol id="[a-z-]+-steps" class="archive-steps"><\/ol>/);
    assert.match(dialog, /<div id="[a-z-]+-options" class="archive-options" hidden>/);
    assert.match(dialog, /Start hosts and switches after loading/);
    assert.match(dialog, /<div id="[a-z-]+-warning" class="archive-warning load-review-warning" role="note" hidden><\/div>/);
    assert.match(dialog, /<div class="confirm-actions"><button id="cancel-[a-z-]+" type="button">Cancel<\/button><button id="confirm-[a-z-]+" type="button" disabled>Load<\/button><\/div>/);
  }
  assert.match(dialogs[0], /id="load-discard-disks"> Discard working disks/);
  assert.doesNotMatch(dialogs[1], /Discard working disks|close-previous|Close previous sessions/);
  assert.doesNotMatch(html, /id="topology-form"|id="topology-counts"|id="topology-error"/);
  for (const name of ['archive', 'topology']) assert.match(moduleSource(name), /createSteps\(/, name);
  assert.match(moduleSource('topology'), /\['read', 'Read topology'\], \['close', 'Close previous session'\], \['load', 'Load topology'\]/);
  assert.match(moduleSource('archive'), /\['read', 'Read archive'\], \['check', 'Check base images'\], \['close', 'Close previous session'\], \['upload', 'Upload archive'\], \['restore', 'Restore session'\]/);
  assert.match(moduleSource('topology'), /countPhrase\(result\.links, 'link'\)/, 'the topology summary: hosts, switches, links');
  assert.doesNotMatch(moduleSource('topology'), /file\.text\(\)|<textarea|contenteditable/, 'the topology is shown read only');
});

test('the Save dialog: one status line, one Download button, the disk option disabled, the checkbox unchecked by default and remembered', () => {
  assert.match(html, /<p id="session-archive-intro" role="status"><\/p>/);
  assert.match(html, /<input id="save-topology-only" type="checkbox"> Save only the topology \(\.topo\)/);
  assert.doesNotMatch(html, /id="save-topology-only"[^>]*checked/);
  assert.match(html, /<button id="confirm-session-archive" type="button">Download<\/button>/);
  assert.doesNotMatch(html, /Download ZIP|Download topology|Topology file: no disks/);
  assert.doesNotMatch(html, /save-session-options/);
  assert.match(html, /<label><input id="include-working-disks" type="checkbox"> Include working disks<\/label>/);
  const archive = moduleSource('archive');
  const apply = /function applySaveChoice\(\) \{[\s\S]*?\n\}\n/.exec(archive)?.[0];
  assert.ok(apply, 'applySaveChoice');
  assert.match(apply, /archiveIntro\.textContent = saveStatusLine\(counts\.hosts, counts\.switches\)/);
  assert.match(apply, /archiveChoice\.disabled = !choice\.sessionOptions/);
  assert.match(apply, /archiveConfirm\.disabled = machines\.size === 0/, 'Download is disabled for an empty session');
  assert.doesNotMatch(apply, /archiveConfirm\.textContent|archiveEstimate\.hidden|archiveConfirm\.hidden/, 'the button and the estimate slot never change');
  assert.match(archive, /try \{ return localStorage\.getItem\(topologyOnlyKey\) === 'true'; \} catch \(_\) \{ return false; \}/);
  assert.match(archive, /try \{ localStorage\.setItem\(topologyOnlyKey, String\(topologyOnlyChoice\.checked\)\); \} catch/);
  assert.match(archive, /downloadTopology\(saveChoice\(true\)\.fileName\)/);
  assert.doesNotMatch(archive, /Save your current session: \$\{data\.hosts\}/, 'the line is not rewritten from the estimate');
});

test('the Save and Load dialogs keep a fixed size: reserved slots, visibility instead of display', () => {
  for (const id of ['archive-working-disk-warning', 'session-archive-progress', 'session-archive-error']) {
    assert.match(css, new RegExp(`#${id}\\[hidden\\](?:, [.#a-z-]+\\[hidden\\])? \\{ display: (?:flex|block); visibility: hidden; \\}`), `${id} keeps its slot`);
  }
  assert.match(css, /#session-archive-error \{ min-height: 3em/);
  assert.match(css, /#session-archive-estimate \{ min-height: 1\.5em/);
  assert.match(css, /#archive-working-disk-warning, \.load-review-warning \{ min-height: 2\.8em; \}/, 'the Load warning slot has the height of the Save one');
  assert.match(css, /\.load-review \.archive-steps \{ height: 12\.5rem; overflow-y: auto; \}/);
  assert.match(css, /\.load-review \.archive-options\[hidden\] \{ display: grid; visibility: hidden; \}/);
  assert.match(css, /#session-archive-dialog, \.load-review, #examples-dialog \{ max-height: 94vh; overflow-y: auto; \}/, 'a small screen scrolls inside instead of resizing');
  assert.match(css, /#load-error\[hidden\] \{ display: block; visibility: hidden; \}/);
  for (const name of ['load-menu', 'load-steps', 'archive', 'topology']) {
    const source = moduleSource(name);
    if (name !== 'load-menu') assert.doesNotMatch(source, /offsetHeight|getBoundingClientRect|clientHeight|style\.height/, `${name}.js measures nothing`);
  }
});

test('the existing Load Session review is unchanged: options, Cancel, the import route', () => {
  const archive = moduleSource('archive');
  assert.match(archive, /export async function startArchiveLoad\(file, \{example = null\} = \{\}\)/);
  assert.match(archive, /\/api\/examples\/load/);
  assert.match(archive, /\/api\/session-archive\/import\?autoStart=/, 'an upload still goes through the import route');
  assert.match(moduleSource('topology'), /\/api\/topology\/preview/);
  assert.match(moduleSource('topology'), /topologyExample \? '\/api\/examples\/load' : '\/api\/topology'/);
  for (const id of ['load-auto-start', 'load-discard-disks', 'confirm-session-archive-load', 'cancel-session-archive-load', 'topology-autostart']) assert.match(html, new RegExp(`id="${id}"`), id);
});

test('the dialogs are native <dialog> elements with labels', () => {
  for (const id of ['examples-dialog', 'session-archive-dialog', 'topology-dialog', 'session-archive-load-dialog']) assert.match(html, new RegExp(`<dialog[^>]*id="${id}"[^>]*aria-labelledby=`), id);
});

test('no import statement of the Load and Save modules spans several lines', () => {
  for (const name of ['file-kinds', 'load-menu', 'load-steps', 'archive', 'topology']) {
    assert.doesNotMatch(moduleSource(name), /^import \{[^}\n]*$/m, name);
  }
});

test('the Save dialog says which engines disks are included; the Load dialog counts the disks of each engine', async () => {
  const {workingDisksNote, archiveDisksPhrase} = await load();
  assert.equal(workingDisksNote({qemu: 2, vbox: 1}), 'QEMU and VirtualBox disks are both included.');
  assert.equal(workingDisksNote({qemu: 1, vbox: 0}), 'QEMU disks are included (no VirtualBox disk exists).');
  assert.equal(workingDisksNote({qemu: 0, vbox: 3}), 'VirtualBox disks are included (no QEMU disk exists).');
  assert.equal(workingDisksNote({qemu: 0, vbox: 0}), 'No working disk exists yet.');
  assert.equal(workingDisksNote(undefined), 'No working disk exists yet.');
  assert.equal(archiveDisksPhrase({qemu: 0, vbox: 0}), 'no working disk');
  assert.equal(archiveDisksPhrase({qemu: 1, vbox: 0}), '1 working disk (1 qcow2)');
  assert.equal(archiveDisksPhrase({qemu: 2, vbox: 1}), '3 working disks (2 qcow2, 1 vdi)');
  assert.equal(archiveDisksPhrase({qemu: 0, vbox: 1}), '1 working disk (1 vdi)');
  const archive = moduleSource('archive');
  assert.match(archive, /\/\^\(h-\[0-9a-f\]\{16\}\)\\\/disk\\\.\(qcow2\|vdi\)\$\//, 'the Load dialog reads both disk kinds');
  assert.match(archive, /\$\{workingDisksNote\(data\.workingDisks\)\}/, 'the estimate line carries the note');
  assert.match(archive, /Object\.entries\(host\.baseImages \|\| \{\}\)/, 'the base image check sends the identity of each disk format');
});
