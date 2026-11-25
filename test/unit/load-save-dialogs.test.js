// The Load Session and Save Session dialogs of the Web interface: the pure rules (public/file-kinds.js: kind of a file
// by extension and content, the file selector state, the option rules, the steps, the Save status line, the warning and
// the timing of the closing of the previous session) and the wiring of the page (one Load and one Save button, one dialog
// each in the same frame, one file selector, a fixed size, observers).
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
  assert.equal(saveChoice(false, 'toto').fileName, 'qemuweb-session-toto.zip', 'the admin in control saves under the owner\'s name');
  assert.equal(saveChoice(true, 'toto').fileName, 'network.topo');
});

test('the orange warning names the session that will be closed; an empty session has none', async () => {
  const {closeWarning, closedText} = await load();
  assert.equal(closeWarning(4, 2), 'Your current session (4 hosts and 2 switches) will be closed and its working disks discarded.');
  assert.equal(closeWarning(1, 0), 'Your current session (1 host and no switch) will be closed and its working disks discarded.');
  assert.equal(closeWarning(0, 1), 'Your current session (no host and 1 switch) will be closed and its working disks discarded.');
  assert.equal(closeWarning(0, 0), '');
  assert.equal(closedText(2, 1), 'Closed 2 hosts and 1 switch');
});

test('the admin in control is told whose session a Load, Stop all or Remove all changes', async () => {
  const {closeWarning, sessionPhrase} = await load();
  assert.equal(closeWarning(2, 1, 'toto'), 'This replaces every node of the session of toto (2 hosts and 1 switch): its working disks are discarded.');
  assert.equal(closeWarning(0, 0, 'toto'), 'This loads into the session of toto.');
  assert.equal(sessionPhrase('toto'), 'the session of toto');
  assert.equal(sessionPhrase(null), 'this session');
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

test('sizes of the examples are shown in B, KB, MB, GB', async () => {
  const {formatSize} = await load();
  assert.deepEqual([0, 372, 1024, 3451, 5 * 1048576, 3 * 1073741824].map(formatSize), ['0 B', '372 B', '1.0 KB', '3.4 KB', '5.0 MB', '3.00 GB']);
});

test('a chosen file is a session (zip) or a topology (topo); a mismatch or another kind is refused', async () => {
  const {routeFile} = await load();
  assert.deepEqual(routeFile('lan.zip', ZIP), {kind: 'session'});
  assert.deepEqual(routeFile('LAN.ZIP', ZIP), {kind: 'session'});
  assert.deepEqual(routeFile('lan.topo', bytes('SWITCH sw\n')), {kind: 'topology'});
  assert.match(routeFile('fake.zip', bytes('SWITCH sw\n')).error, /^fake\.zip: This file is not a ZIP archive/);
  assert.match(routeFile('fake.topo', ZIP).error, /^fake\.topo: This file is not a topology/);
  assert.match(routeFile('fake.topo', bytes('a\0b')).error, /binary/);
  assert.match(routeFile('notes.txt', bytes('x')).error, /Choose a \.topo \(topology\) or \.zip \(session\) file/);
  assert.equal(routeFile('fake.zip', bytes('SWITCH sw\n')).kind, undefined);
});

test('the dialog opens on the remembered source when it can be used; without examples it opens on My files and the server segment is disabled with its hint', async () => {
  const {openingSource, serverSourceState} = await load();
  const list = [{name: 'lan.zip'}];
  assert.equal(openingSource(null, list), 'server');
  assert.equal(openingSource('server', list), 'server');
  assert.equal(openingSource('local', list), 'local');
  assert.equal(openingSource('nonsense', list), 'server');
  for (const none of [[], null, undefined]) {
    assert.equal(openingSource('server', none), 'local', String(none));
    assert.equal(openingSource(null, none), 'local');
    assert.deepEqual(serverSourceState(none), {disabled: true, hint: 'No examples on the server'});
  }
  assert.deepEqual(serverSourceState(list), {disabled: false, hint: 'Examples of the server'});
});

test('the file card shows the same lines for a server file and a file of the user: name, kind and size, the description if any', async () => {
  const {fileCardLines, exampleOptionLabel} = await load();
  assert.deepEqual(fileCardLines(null), {name: 'No file chosen', meta: '', description: ''});
  assert.deepEqual(fileCardLines({name: 'lan.zip', kind: 'session', size: 3451, description: ''}), {name: 'lan.zip', meta: 'Session · 3.4 KB', description: ''});
  assert.deepEqual(fileCardLines({name: 'lan.topo', kind: 'topology', size: 372, description: 'A LAN'}), {name: 'lan.topo', meta: 'Topology · 372 B', description: 'A LAN'});
  assert.deepEqual(fileCardLines({name: 'notes.txt', kind: null, size: 12}), {name: 'notes.txt', meta: '12 B', description: ''}, 'an unknown kind shows only its size');
  assert.equal(exampleOptionLabel({name: 'lan.zip', kind: 'session', size: 3451}), 'lan.zip · Session · 3.4 KB');
  assert.equal(exampleOptionLabel({name: 'lan.topo', kind: 'topology', size: 372}), 'lan.topo · Topology · 372 B');
});

test('the options: the previous session is always closed, Discard working disks only for a ZIP that has working disks', async () => {
  const {loadOptionStates} = await load();
  const closing = {checked: true, disabled: true, note: 'Loading always replaces the current session.'};
  for (const file of [null, {kind: 'session', hasDisks: true}, {kind: 'session', hasDisks: false}, {kind: 'topology', hasDisks: false}, {kind: 'session', hasDisks: null}]) {
    const states = loadOptionStates(file);
    assert.deepEqual(states.closePrevious, closing, JSON.stringify(file));
    assert.deepEqual(states.autoStart, {disabled: false});
  }
  assert.deepEqual(loadOptionStates({kind: 'session', hasDisks: true}).discard, {disabled: false, note: ''});
  assert.deepEqual(loadOptionStates({kind: 'session', hasDisks: null}).discard, {disabled: false, note: ''}, 'unknown: left to the user');
  assert.deepEqual(loadOptionStates({kind: 'session', hasDisks: false}).discard, {disabled: true, note: 'This archive has no working disk.'});
  assert.deepEqual(loadOptionStates({kind: 'topology', hasDisks: false}).discard, {disabled: true, note: 'A topology has no working disk.'});
  assert.deepEqual(loadOptionStates(null).discard, {disabled: true, note: ''});
});

test('the steps of a load and of a save, and the texts of a refusal and of the restore step', async () => {
  const {loadStepList, saveStepList, staleDisksRefusal, restoreText} = await load();
  assert.deepEqual(loadStepList('session').map(([name]) => name), ['read', 'check', 'close', 'upload', 'create', 'restore', 'start']);
  assert.deepEqual(loadStepList('topology').map(([name]) => name), ['read', 'check', 'close', 'create', 'start']);
  assert.deepEqual(loadStepList('session').map(([, label]) => label), ['Read the file', 'Check the file', 'Close the previous session', 'Upload the file', 'Create switches and hosts', 'Restore working disks', 'Start hosts and switches']);
  assert.deepEqual(saveStepList({topologyOnly: true}).map(([name]) => name), ['create', 'download']);
  assert.deepEqual(saveStepList({topologyOnly: false, includeDisks: false}).map(([name]) => name), ['create', 'download']);
  assert.deepEqual(saveStepList({topologyOnly: false, includeDisks: true}).map(([name]) => name), ['stop', 'create', 'download']);
  assert.equal(staleDisksRefusal(['Base image a changed.', 'Base image b changed.']),
    'Base image a changed.\nBase image b changed.\nCheck "Discard working disks" and load again. Nothing was changed.');
  assert.equal(restoreText({hasDisks: false, discard: false}), 'No working disk in the file');
  assert.equal(restoreText({hasDisks: true, discard: false}), 'Working disks restored');
  assert.match(restoreText({hasDisks: true, discard: true}), /^Working disks discarded/);
});

test('the check happens before the closing: a refusal for stale working disks stops the load first, the session closes once', () => {
  const dialog = moduleSource('load-dialog');
  const steps = moduleSource('load-steps');
  assert.equal((steps.match(/await removeAllNodes\(\)/g) || []).length, 1, 'one removal, in the shared Close step');
  assert.equal((dialog.match(/closePreviousSession\(/g) || []).length, 1, 'the dialog closes the session in one place');
  assert.doesNotMatch(dialog, /removeAllNodes/, 'the dialog never removes nodes itself');
  const refusal = dialog.indexOf('staleDisksRefusal(found.stale)');
  const closing = dialog.indexOf('closePreviousSession(');
  const reading = dialog.indexOf('await inspect(info)');
  assert.ok(reading > 0 && reading < refusal && refusal < closing, 'read and check, then the refusal, then the closing');
  assert.match(dialog, /found\.stale\.length && !options\.discardDisks/, 'refused only while Discard working disks is off');
  assert.match(dialog, /Nothing was changed\.`\);/, 'a failed read or check says nothing was changed');
  assert.match(dialog, /The previous session was closed: the current session is empty\./);
  assert.match(dialog, /closePreviousSession\(steps, \{reviewed: true\}\)/);
  assert.doesNotMatch(dialog, /discardDisks = true|discard\.checked = found|discard\.checked = true/, 'Discard is never ticked for the user');
});

test('a server file and a file of the user go through the same inspection and the same load pipeline', () => {
  const dialog = moduleSource('load-dialog');
  assert.equal((dialog.match(/async function inspect\(/g) || []).length, 1, 'one inspection for both sources');
  assert.match(dialog, /\/api\/examples\/file/, 'the bytes of an example are read like a file of the user');
  assert.match(dialog, /importExample\(info\.example, /);
  assert.match(dialog, /importArchive\(found\.file, /);
  assert.match(dialog, /\/api\/examples\/load/);
  assert.match(dialog, /\/api\/topology\/preview/);
  assert.match(dialog, /routeFile\(info\.name, head\)/);
  assert.match(moduleSource('archive-read'), /\/api\/session-archive\/import\?autoStart=\$\{autoStart\}&discardDisks=\$\{discardDisks\}/);
  assert.match(moduleSource('archive-read'), /\/api\/session-archive\/check/);
  for (const name of ['load-dialog', 'file-selector', 'save-dialog']) assert.doesNotMatch(moduleSource(name), /innerHTML/, `${name}: names and descriptions are set as text`);
});

test('the toolbar has one Load Session and one Save Session button, with the same icon style, tooltips and write-action class', () => {
  for (const id of ['load-topology', 'save-topology', 'topology-file', 'session-archive-file', 'load-menu', 'load-from-files', 'load-from-server', 'examples-dialog', 'topology-dialog', 'session-archive-dialog', 'session-archive-load-dialog']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), id);
  }
  const buttons = ['load-session-archive', 'save-session-archive'].map(id => new RegExp(`<button id="${id}"[^>]*>[\\s\\S]*?</button>`).exec(html)?.[0]);
  assert.match(buttons[0], /title="Load Session" aria-label="Load Session"/);
  assert.match(buttons[1], /title="Save Session" aria-label="Save Session"/);
  for (const button of buttons) {
    assert.match(button, /class="icon-button session-file-button write-action"/, 'an observer cannot use it, the yellow of the dialog headings');
    assert.doesNotMatch(button, /aria-haspopup|aria-expanded|aria-controls/, 'no menu any more');
  }
  assert.match(buttons[0], /<use href="#load-session-icon"><\/use>/);
  assert.match(buttons[1], /<use href="#save-session-icon"><\/use>/);
  const symbols = ['load-session-icon', 'save-session-icon'].map(id => new RegExp(`<symbol id="${id}"[^>]*>([\\s\\S]*?)</symbol>`).exec(html)?.[1]);
  assert.ok(symbols.every(Boolean));
  assert.equal(symbols[0].split('<path')[0], symbols[1].split('<path')[0], 'both icons are the same box');
  assert.match(html, /<h2 id="load-title">Load Session<\/h2>/);
  assert.match(html, /<h2 id="save-title">Save Session<\/h2>/);
});

test('Load Session and Save Session share one frame: heading with the toolbar icon, panes, steps, Cancel and the primary button', () => {
  const dialogs = ['load', 'save'].map(name => new RegExp(`<dialog class="confirm-dialog file-dialog" id="${name}-dialog" aria-labelledby="${name}-title">[\\s\\S]*?</dialog>`).exec(html)?.[0]);
  assert.ok(dialogs.every(Boolean));
  for (const [index, name] of ['load', 'save'].entries()) {
    const dialog = dialogs[index];
    assert.match(dialog, new RegExp(`<div class="confirm-heading"><svg [^>]*><use href="#${name}-session-icon"></use></svg><h2 id="${name}-title">`));
    assert.match(dialog, new RegExp(`<div class="file-pane" id="${name}-form">`));
    assert.match(dialog, new RegExp(`<div class="file-pane" id="${name}-run" hidden>\\s*<ol id="${name}-steps" class="archive-steps" aria-live="polite"></ol>\\s*<p id="${name}-result" class="file-result" role="status"></p>`));
    assert.match(dialog, /<div class="file-panes">/);
  }
  assert.match(dialogs[0], /<div class="confirm-actions"><button id="cancel-load" type="button">Cancel<\/button><button id="confirm-load" type="button" data-action="load" disabled>Load<\/button><\/div>/);
  assert.match(dialogs[1], /<div class="confirm-actions"><button id="cancel-save" type="button">Cancel<\/button><button id="confirm-save" type="button" data-action="save">Save<\/button><\/div>/);
  for (const dialog of dialogs) assert.match(dialog, /<div class="archive-options" id="[a-z]+-options">/, 'the same options box');
  assert.doesNotMatch(html, /Download<\/button>|id="session-archive-progress"|archive-progress/, 'the progress is the steps list');
});

test('Load Session: one file selector with a source switch, the card, and the three options', () => {
  const dialog = /<dialog class="confirm-dialog file-dialog" id="load-dialog"[\s\S]*?<\/dialog>/.exec(html)[0];
  assert.match(dialog, /<div class="source-switch" role="radiogroup" aria-label="File source">[\s\S]*data-source="server">Server examples<\/button>[\s\S]*data-source="local">My files<\/button>/);
  assert.match(dialog, /<input id="load-file" type="file" accept="\.topo,\.zip" hidden>/);
  assert.equal((html.match(/id="example-select"/g) || []).length, 1, 'one selector');
  for (const id of ['file-card-name', 'file-card-meta', 'file-card-description', 'file-card-notes']) assert.match(dialog, new RegExp(`id="${id}"`), id);
  assert.match(dialog, /<input type="checkbox" id="load-close-previous" checked disabled> Close the previous session/);
  assert.match(dialog, /<input type="checkbox" id="load-auto-start" checked> Start hosts and switches after loading/);
  assert.match(dialog, /<input type="checkbox" id="load-discard-disks" disabled> Discard working disks/);
  assert.doesNotMatch(dialog, /id="load-discard-disks"[^>]*checked/);
  assert.match(dialog, /<div id="load-warning" class="archive-warning file-warning" role="note" hidden><\/div>/);
  const selector = moduleSource('file-selector');
  assert.match(selector, /'ArrowLeft'/);
  assert.match(selector, /aria-checked/);
  assert.match(selector, /serverSourceState\(examples\)/);
});

test('Save Session keeps its options, the status line, the disk warning and the estimate; the checkbox is unchecked by default and remembered', () => {
  const dialog = /<dialog class="confirm-dialog file-dialog" id="save-dialog"[\s\S]*?<\/dialog>/.exec(html)[0];
  assert.match(dialog, /<p id="save-intro" class="file-intro" role="status"><\/p>/);
  assert.match(dialog, /<input id="save-topology-only" type="checkbox"> Save only the topology \(\.topo\)/);
  assert.doesNotMatch(dialog, /id="save-topology-only"[^>]*checked/);
  assert.match(dialog, /<label><input id="include-working-disks" type="checkbox"> Include working disks<\/label>/);
  assert.match(dialog, /<span>All hosts and switches will be stopped before saving\.<\/span>/);
  assert.match(dialog, /<p id="save-estimate" role="status"><\/p>/);
  assert.match(dialog, /<p id="save-error" role="alert" hidden><\/p>/);
  const source = moduleSource('save-dialog');
  const apply = /function applySaveChoice\(\) \{[\s\S]*?\n\}\n/.exec(source)?.[0];
  assert.ok(apply, 'applySaveChoice');
  assert.match(apply, /intro\.textContent = saveStatusLine\(counts\.hosts, counts\.switches\)/);
  assert.match(apply, /includeDisks\.disabled = !choice\.sessionOptions/);
  assert.match(apply, /confirm\.disabled = machines\.size === 0/, 'Save is disabled for an empty session');
  assert.match(source, /try \{ return localStorage\.getItem\(TOPOLOGY_ONLY_KEY\) === 'true'; \} catch \(_\) \{ return false; \}/);
  assert.match(source, /try \{ localStorage\.setItem\(TOPOLOGY_ONLY_KEY, String\(topologyOnly\.checked\)\); \} catch/);
  assert.match(source, /downloadTopology\(fileName\)/);
});

test('the dialogs remember the source and "Start", never "Discard working disks" nor the file; storage is optional', () => {
  const dialog = moduleSource('load-dialog');
  assert.match(dialog, /try \{ localStorage\.setItem\(key, value\); \} catch \(_\)/);
  assert.match(dialog, /try \{ return localStorage\.getItem\(key\); \} catch \(_\) \{ return null; \}/);
  assert.doesNotMatch(dialog, /remember\([A-Z_]*(DISCARD|FILE)/i);
  assert.match(dialog, /discard\.checked = false;/, 'Discard starts unchecked at each opening');
});

test('Escape cancels only when idle, Enter never starts or restarts a load; the dialogs are labelled and announce their steps', () => {
  for (const name of ['load-dialog', 'save-dialog']) {
    const source = moduleSource(name);
    assert.match(source, /dialog\.addEventListener\('cancel', event => \{ if \(busy\) event\.preventDefault\(\); \}\);/, `${name}: Escape is blocked while running`);
    assert.match(source, /event\.key === 'Enter' && busy/, `${name}: Enter is inert while running`);
    assert.match(source, /setAttribute\('aria-busy', 'true'\)/);
  }
  for (const id of ['load-dialog', 'save-dialog']) assert.match(html, new RegExp(`<dialog[^>]*id="${id}"[^>]*aria-labelledby=`), id);
  assert.doesNotMatch(/<dialog[^>]*id="load-dialog"[\s\S]*?<\/dialog>/.exec(html)[0], /<form/, 'no form: Enter cannot submit');
});

test('an observing administrator without control cannot open either dialog: write-action buttons, no other way in, the server refuses', () => {
  const observe = moduleSource('observe');
  // A write-action is blocked whenever controlReason gives a reason (an observer without control, the owner under control).
  assert.match(observe, /write: !!element\.closest\('\.write-action'\), ownerOnly: !!element\.closest\('\.owner-only'\)\}, controlState\(\)\)/);
  assert.match(observe, /if \(!isDisabled\(event\.target\)\) return;/);
  assert.match(observe, /\['Enter', ' ', 'ArrowUp', 'ArrowDown'\]\.includes\(event\.key\)/, 'keyboard activation is blocked');
  assert.match(css, /body\[data-write-blocked="true"\] \.write-action/);
  for (const name of ['load-dialog', 'save-dialog']) {
    const source = moduleSource(name);
    assert.equal((source.match(/showModal\(\)/g) || []).length, 1, `${name}: one way to open the dialog`);
    assert.doesNotMatch(source, /addEventListener\('keydown', event => \{[^}]*showModal/, `${name}: no shortcut opens it`);
  }
  assert.match(moduleSource('load-dialog'), /getElementById\('load-session-archive'\)\.addEventListener\('click', open\)/);
  assert.match(moduleSource('save-dialog'), /getElementById\('save-session-archive'\)\.addEventListener\('click'/);
  const routes = fs.readFileSync(path.join(publicDir, '..', 'server', 'routes', 'examples.js'), 'utf8');
  assert.match(routes, /refuseObserver\(req, res\)/);
});

test('the dialogs keep a fixed size: stacked panes, reserved slots, visibility instead of display; none of the old styles remain', () => {
  assert.match(css, /\.file-panes \{ display: grid;/);
  assert.match(css, /\.file-pane \{ grid-area: 1 \/ 1;/, 'the form and the steps share one cell');
  assert.match(css, /\.file-pane\[hidden\] \{ display: block; visibility: hidden; \}/);
  assert.match(css, /\.file-warning \{ min-height: 2\.8em; \}/);
  assert.match(css, /\.file-warning\[hidden\] \{ display: flex; visibility: hidden; \}/);
  assert.match(css, /\.file-dialog \{ width: min\(520px, 94vw\); max-height: 94vh; overflow-y: auto; \}/, 'a small screen scrolls inside');
  assert.match(css, /#save-estimate \{ min-height: 1\.5em;/);
  assert.match(css, /#save-error\[hidden\] \{ display: block; visibility: hidden; \}/);
  assert.match(css, /\.archive-steps li\[data-state="done"\] \.archive-step-icon \{ border-color: #3fb96b;/, 'the green check mark');
  for (const old of ['load-menu', 'load-review', 'examples-dialog', 'load-error', 'save-choice', 'load-file-label', 'session-archive', 'archive-progress', 'archive-working-disk-warning']) {
    assert.doesNotMatch(css, new RegExp(old), `${old} is gone from the stylesheet`);
  }
  for (const name of ['load-steps', 'load-dialog', 'save-dialog', 'file-selector']) assert.doesNotMatch(moduleSource(name), /offsetHeight|getBoundingClientRect|clientHeight|style\.height/, `${name}.js measures nothing`);
  assert.doesNotMatch(css, /background:\s*#000(?:000)?\s*[;}]/, 'no black background');
});

test('no import statement of the Load and Save modules spans several lines, and the removed modules are gone', () => {
  for (const name of ['file-kinds', 'load-steps', 'archive-read', 'file-selector', 'load-dialog', 'save-dialog', 'topology']) {
    assert.doesNotMatch(moduleSource(name), /^import \{[^}\n]*$/m, name);
  }
  for (const gone of ['archive.js', 'load-menu.js']) assert.equal(fs.existsSync(path.join(publicDir, gone)), false, gone);
  assert.doesNotMatch(moduleSource('topology'), /startTopologyLoad|topology-dialog/);
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
  const read = moduleSource('archive-read');
  assert.match(read, /\/\^\(h-\[0-9a-f\]\{16\}\)\\\/disk\\\.\(qcow2\|vdi\)\$\//, 'the Load dialog reads both disk kinds');
  assert.match(moduleSource('save-dialog'), /\$\{workingDisksNote\(data\.workingDisks\)\}/, 'the estimate line carries the note');
  assert.match(read, /Object\.entries\(host\.baseImages \|\| \{\}\)/, 'the base image check sends the identity of each disk format');
});
