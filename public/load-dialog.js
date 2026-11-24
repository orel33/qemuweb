// The Load Session dialog, opened by the Load button: one file selector (the server's examples or the user's own files),
// the options, and a single Load click that shows its steps. The file is read and checked in the browser, a session ZIP
// and a topology go through the same pipeline whatever the source, and nothing is closed before the file passed its check.
import {graphicLayoutKey, generalSettings, machines, saveViewSettings} from './state.js';
import {jsonRequest, requestJson} from './api.js';
import {archiveSummaryText, checkArchiveBaseImages, importArchive, importExample, readArchiveSummary} from './archive-read.js';
import {closeWarning, countPhrase, loadOptionStates, loadStepList, nodeCounts, openingSource, restoreText, routeFile, staleDisksRefusal} from './file-kinds.js';
import {closePreviousSession, createSteps, warningSlot} from './load-steps.js';
import {createFileSelector} from './file-selector.js';

const MAX_TOPOLOGY_BYTES = 262144;
const SOURCE_KEY = 'qemuweb.load-source';
const AUTO_START_KEY = 'qemuweb.load-auto-start';
const dialog = document.getElementById('load-dialog');
const form = document.getElementById('load-form');
const run = document.getElementById('load-run');
const autoStart = document.getElementById('load-auto-start');
const discard = document.getElementById('load-discard-disks');
const discardNote = document.getElementById('load-discard-note');
const stepsList = document.getElementById('load-steps');
const result = document.getElementById('load-result');
const cancel = document.getElementById('cancel-load');
const confirm = document.getElementById('confirm-load');
const setWarning = warningSlot(document.getElementById('load-warning'));
let chosen = null;
let hasDisks = null;
let busy = false;
let loaded = false;
let inspectToken = 0;
let steps = null;

const remember = (key, value) => { try { localStorage.setItem(key, value); } catch (_) { /* Not remembered. */ } };
const remembered = key => { try { return localStorage.getItem(key); } catch (_) { return null; } };
const failed = (step, message, readText = '') => ({ok: false, step, message, readText});

// The bytes of a file of the server's examples, which the browser reads like a file of the user.
async function exampleFile(info) {
  const response = await fetch('/api/examples/file', jsonRequest('POST', {name: info.example}));
  if (!response.ok) throw new Error((await response.json()).error || 'Cannot read the example.');
  return new File([await response.blob()], info.name);
}

async function inspectSession(file) {
  let summary = null;
  try { summary = await readArchiveSummary(file); } catch (_) { return failed('read', 'Cannot read the archive: it is not a QemuWeb session.'); }
  const readText = archiveSummaryText(summary);
  try {
    const check = await checkArchiveBaseImages(file, summary);
    return {ok: true, file, readText, hasDisks: summary.diskHosts.length > 0, stale: check.messages,
      checkState: check.messages.length ? 'warning' : 'done',
      checkText: check.messages.join('\n') || (check.noDisks ? 'No working disk: hosts start from the current base images.' : 'Base images are up to date')};
  } catch (error) { return failed('check', `Cannot check base images: ${error.message}`, readText); }
}

async function inspectTopology(file, head) {
  try {
    const preview = await requestJson('/api/topology/preview', jsonRequest('POST', {text: new TextDecoder().decode(head), engine: generalSettings.engine}), 'Invalid topology.');
    return {ok: true, file, hasDisks: false, stale: [], checkState: 'done', checkText: 'The topology is valid',
      counts: `${countPhrase(preview.hosts, 'host')} and ${countPhrase(preview.switches, 'switch', 'switches')}`,
      readText: `${countPhrase(preview.hosts, 'host')} · ${countPhrase(preview.switches, 'switch', 'switches')} · ${countPhrase(preview.links, 'link')}`};
  } catch (error) { return failed('check', error.message, 'Topology read'); }
}

// Reads and checks the chosen file, for a file of the user and for an example alike. Changes nothing.
async function inspect(info) {
  if (!info.kind) return failed('read', routeFile(info.name, new Uint8Array()).error);
  let file = info.file;
  try { file ||= info.file = await exampleFile(info); } catch (error) { return failed('read', error.message); }
  if (info.kind === 'topology' && file.size > MAX_TOPOLOGY_BYTES) return failed('read', 'Topology must be text under 256 KB.');
  const head = new Uint8Array(await file.slice(0, info.kind === 'topology' ? file.size : 4).arrayBuffer());
  const route = routeFile(info.name, head);
  if (route.error) return failed('read', route.error);
  return info.kind === 'session' ? inspectSession(file) : inspectTopology(file, head);
}

function applyOptions() {
  const states = loadOptionStates(chosen ? {kind: chosen.kind, hasDisks} : null);
  discard.disabled = states.discard.disabled;
  if (discard.disabled) discard.checked = false;
  discardNote.textContent = states.discard.note;
  discardNote.hidden = !states.discard.note;
}

// What the dialog knows of the chosen file before the click: its summary, then the check (warnings in orange).
async function choose(info) {
  const token = ++inspectToken;
  chosen = info;
  hasDisks = null;
  confirm.disabled = true;
  selector.setNotes([]);
  applyOptions();
  if (!info) return;
  selector.setNotes([{text: 'Reading the file…', state: 'info'}]);
  const found = await inspect(info);
  if (token !== inspectToken) return;
  hasDisks = found.ok ? found.hasDisks : null;
  applyOptions();
  selector.setNotes(found.ok ? [{text: found.readText, state: 'info'}, {text: found.checkText, state: found.checkState === 'warning' ? 'warning' : 'info'}]
    : [...(found.readText ? [{text: found.readText, state: 'info'}] : []), {text: found.message, state: 'error'}]);
  confirm.disabled = !found.ok;
}

const selector = createFileSelector({onChoose: choose});

function showRun(running) {
  form.hidden = running;
  run.hidden = !running;
}

// The end of a load: a result line and Close; Back when nothing was changed, to correct the options and load again.
function finish({state, text, changed}) {
  result.textContent = text;
  result.dataset.state = state;
  cancel.textContent = 'Close';
  confirm.textContent = 'Back';
  confirm.dataset.action = 'back';
  confirm.disabled = false;
  confirm.hidden = changed;
}

function setStart(done, startErrors) {
  if (startErrors.length) steps.set('start', 'warning', `Some instances could not start:\n${startErrors.join('\n')}`);
  else steps.set('start', 'done', done ? '' : 'Not started: the option is off');
}

async function load() {
  const info = chosen;
  busy = true;
  cancel.disabled = confirm.disabled = true;
  selector.setDisabled(true);
  dialog.setAttribute('aria-busy', 'true');
  steps = createSteps(stepsList, loadStepList(info.kind));
  result.textContent = '';
  result.dataset.state = '';
  showRun(true);
  const options = {autoStart: autoStart.checked, discardDisks: discard.checked};
  let step = 'read';
  let closed = false;
  try {
    steps.set('read', 'running');
    const found = await inspect(info);
    if (!found.ok) {
      if (found.step === 'check') steps.set('read', 'done', found.readText);
      steps.set(found.step, 'error', `${found.message} Nothing was changed.`);
      return finish({state: 'error', text: 'Nothing was loaded and nothing was changed.', changed: false});
    }
    steps.set('read', 'done', found.readText);
    if (found.stale.length && !options.discardDisks) {
      steps.set('check', 'error', staleDisksRefusal(found.stale));
      return finish({state: 'error', text: 'The load was refused before anything was changed.', changed: false});
    }
    steps.set('check', found.stale.length ? 'warning' : found.checkState, found.stale.length ? `${found.checkText}\nThe working disks are discarded.` : found.checkText);
    step = 'close';
    closed = await closePreviousSession(steps, {reviewed: true});
    const end = await create(info, found, options, () => { step = 'create'; });
    return finish({state: end.state, text: end.text, changed: true});
  } catch (error) {
    steps.set(step, 'error', closed ? `${error.message}\nThe previous session was closed: the current session is empty.` : error.message);
    return finish({state: 'error', text: closed ? 'The load failed after the previous session was closed.' : 'The load failed.', changed: closed});
  } finally {
    busy = false;
    cancel.disabled = false;
    selector.setDisabled(false);
    dialog.removeAttribute('aria-busy');
  }
}

// Sends the file to the server (a file of the user is uploaded, an example is read by the server from its disk) and shows
// the three last steps. Returns the final {state, text}.
async function create(info, found, {autoStart: start, discardDisks}, onCreate) {
  let startErrors = [];
  if (info.kind === 'session') {
    steps.set('upload', 'running', '0%');
    const uploaded = () => { steps.set('upload', 'done', info.example ? 'Read by the server from its examples' : ''); steps.set('create', 'running'); onCreate(); };
    const data = info.example ? await importExample(info.example, {autoStart: start, discardDisks}, uploaded)
      : await importArchive(found.file, {autoStart: start, discardDisks}, percent => steps.set('upload', 'running', `${percent}%`), uploaded);
    loaded = true;
    saveViewSettings();
    localStorage.removeItem(graphicLayoutKey);
    steps.set('create', 'done', `${countPhrase(data.hosts, 'host')} and ${countPhrase(data.switches, 'switch', 'switches')}`);
    steps.set('restore', data.warnings?.length ? 'warning' : 'done', [restoreText({hasDisks: found.hasDisks, discard: discardDisks}), ...(data.warnings || [])].join('\n'));
    startErrors = data.startErrors || [];
  } else {
    steps.set('create', 'running');
    onCreate();
    const options = {engine: generalSettings.engine, autostart: start};
    const data = await requestJson(info.example ? '/api/examples/load' : '/api/topology',
      jsonRequest('POST', info.example ? {name: info.example, ...options} : {text: await found.file.text(), ...options}), 'Cannot load topology.');
    loaded = true;
    steps.set('create', 'done', found.counts);
    startErrors = data.errors || [];
  }
  setStart(start, startErrors);
  return startErrors.length ? {state: 'warning', text: `${info.name} was loaded, but some instances could not start.`}
    : {state: 'done', text: `${info.name} was loaded.`};
}

async function listExamples() {
  try {
    const response = await fetch('/api/examples', {cache: 'no-store'});
    return response.ok ? await response.json() : [];
  } catch (_) { return []; }
}

// Cancel / Load, as the dialog opens and when Back returns to the form.
function resetButtons() {
  cancel.textContent = 'Cancel';
  confirm.textContent = 'Load';
  confirm.dataset.action = 'load';
  confirm.hidden = false;
  confirm.disabled = true;
}

async function open() {
  loaded = false;
  showRun(false);
  resetButtons();
  autoStart.checked = remembered(AUTO_START_KEY) !== 'false';
  discard.checked = false;
  const counts = nodeCounts(machines.values());
  setWarning(closeWarning(counts.hosts, counts.switches));
  const examples = await listExamples();
  selector.open(examples, openingSource(remembered(SOURCE_KEY), examples));
  dialog.showModal();
}

export function initLoadDialog() {
  document.getElementById('load-session-archive').addEventListener('click', open);
  autoStart.addEventListener('change', () => remember(AUTO_START_KEY, String(autoStart.checked)));
  cancel.addEventListener('click', () => dialog.close());
  confirm.addEventListener('click', () => {
    if (confirm.dataset.action !== 'back') { load(); return; }
    showRun(false);
    resetButtons();
    choose(chosen);
  });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Enter' && busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    remember(SOURCE_KEY, selector.source());
    inspectToken++;
    if (loaded) location.reload();
  });
}
