// The Save Session dialog, opened by the Save button: the session as a ZIP (with or without working disks) or only its
// topology (.topo), in the same frame, steps and buttons as the Load Session dialog (public/load-dialog.js).
import {machines} from './state.js';
import {jsonRequest} from './api.js';
import {downloadTopology} from './topology.js';
import {nodeCounts, saveChoice, saveStatusLine, saveStepList, workingDisksNote} from './file-kinds.js';
import {createSteps} from './load-steps.js';

const dialog = document.getElementById('save-dialog');
const form = document.getElementById('save-form');
const run = document.getElementById('save-run');
const topologyOnly = document.getElementById('save-topology-only');
const includeDisks = document.getElementById('include-working-disks');
const diskWarning = document.getElementById('save-disk-warning');
const intro = document.getElementById('save-intro');
const estimate = document.getElementById('save-estimate');
const errorLine = document.getElementById('save-error');
const stepsList = document.getElementById('save-steps');
const result = document.getElementById('save-result');
const cancel = document.getElementById('cancel-save');
const confirm = document.getElementById('confirm-save');
const TOPOLOGY_ONLY_KEY = 'qemuweb.save-topology-only';
let estimateRequest = 0;
let busy = false;

// The last choice of "Save only the topology", kept in this browser; the dialog works without it.
function rememberedTopologyOnly() {
  try { return localStorage.getItem(TOPOLOGY_ONLY_KEY) === 'true'; } catch (_) { return false; }
}

function showRun(running) {
  form.hidden = running;
  run.hidden = !running;
}

// Cancel / Save, as the dialog opens and when Back returns to the form.
function resetButtons() {
  cancel.textContent = 'Cancel';
  confirm.textContent = 'Save';
  confirm.dataset.action = 'save';
  confirm.hidden = false;
}

// Shows the dialog for the checkbox. Nothing comes and goes: one status line with the counts of the session, the
// same Save button, the disk option disabled for a topology, the ZIP estimate (dimmed, in its slot) only for a ZIP.
function applySaveChoice() {
  const choice = saveChoice(topologyOnly.checked);
  const counts = nodeCounts(machines.values());
  intro.textContent = saveStatusLine(counts.hosts, counts.switches);
  includeDisks.disabled = !choice.sessionOptions;
  includeDisks.parentElement.title = choice.optionNote;
  if (!choice.sessionOptions) { includeDisks.checked = false; diskWarning.hidden = true; }
  errorLine.hidden = true;
  estimateRequest++;
  estimate.textContent = '';
  confirm.disabled = machines.size === 0;
  if (choice.sessionOptions && machines.size) updateEstimate();
}

async function updateEstimate() {
  const request = ++estimateRequest;
  confirm.disabled = true;
  errorLine.hidden = true;
  estimate.textContent = 'Estimating archive size…';
  try {
    const withDisks = includeDisks.checked;
    const response = await fetch(`/api/session-archive/estimate?includeDisks=${withDisks}`, {cache: 'no-store'});
    const data = await response.json();
    if (request !== estimateRequest) return;
    if (!response.ok) throw new Error(data.error || 'Cannot estimate session archive.');
    estimate.textContent = `Estimated compressed ZIP: ${(data.bytes / 1e6).toFixed(2)} MB${withDisks ? `. ${workingDisksNote(data.workingDisks)}` : ''}`;
    confirm.disabled = false;
  } catch (error) {
    if (request !== estimateRequest) return;
    estimate.textContent = ''; errorLine.textContent = error.message; errorLine.hidden = false;
  }
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Asks where to save the ZIP when the browser can (the file is then written as it arrives): {writable: null} for a
// plain download otherwise, null when the user gives up.
async function zipTarget() {
  if (!window.showSaveFilePicker) return {writable: null};
  try {
    const handle = await window.showSaveFilePicker({suggestedName: saveChoice(false).fileName, types: [{description: 'QemuWeb session ZIP', accept: {'application/zip': ['.zip']}}]});
    return {writable: await handle.createWritable()};
  } catch (error) {
    return error.name === 'AbortError' ? null : {writable: null};
  }
}

async function saveZip(steps, withDisks) {
  const target = await zipTarget();
  if (!target) return false;
  showRun(true);
  let {writable} = target;
  let step = withDisks ? 'stop' : 'create';
  try {
    steps.set(step, 'running');
    const response = await fetch('/api/session-archive/export', jsonRequest('POST', {includeDisks: withDisks}));
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Cannot save session.'); }
    if (withDisks) steps.set('stop', 'done');
    steps.set('create', 'done');
    step = 'download';
    steps.set('download', 'running');
    if (writable) { await response.body.pipeTo(writable); writable = null; } else downloadBlob(await response.blob(), saveChoice(false).fileName);
    steps.set('download', 'done');
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    steps.set(step, 'error', error.message);
    throw error;
  }
  return true;
}

async function save() {
  const only = topologyOnly.checked;
  const withDisks = includeDisks.checked;
  const fileName = saveChoice(only).fileName;
  busy = true;
  cancel.disabled = confirm.disabled = true;
  dialog.setAttribute('aria-busy', 'true');
  const steps = createSteps(stepsList, saveStepList({topologyOnly: only, includeDisks: withDisks}));
  result.textContent = '';
  result.dataset.state = '';
  let saved = false;
  try {
    if (only) {
      showRun(true);
      steps.set('create', 'running');
      try { await downloadTopology(fileName); } catch (error) { steps.set('create', 'error', error.message); throw error; }
      steps.set('create', 'done');
      steps.set('download', 'done');
      saved = true;
    } else saved = await saveZip(steps, withDisks);
    if (!saved) { showRun(false); return; }
    result.textContent = `${fileName} was saved.`;
    result.dataset.state = 'done';
    cancel.textContent = 'Close';
    confirm.hidden = true;
  } catch (_) {
    result.textContent = 'The session was not saved.';
    result.dataset.state = 'error';
    cancel.textContent = 'Close';
    confirm.textContent = 'Back';
    confirm.dataset.action = 'back';
    confirm.hidden = false;
  } finally {
    busy = false;
    cancel.disabled = false;
    confirm.disabled = false;
    dialog.removeAttribute('aria-busy');
  }
}

export function initSaveDialog() {
  document.getElementById('save-session-archive').addEventListener('click', () => {
    includeDisks.checked = false;
    diskWarning.hidden = true;
    topologyOnly.checked = rememberedTopologyOnly();
    showRun(false);
    resetButtons();
    dialog.showModal();
    applySaveChoice();
  });
  topologyOnly.addEventListener('change', () => {
    try { localStorage.setItem(TOPOLOGY_ONLY_KEY, String(topologyOnly.checked)); } catch (_) { /* Not remembered. */ }
    applySaveChoice();
  });
  includeDisks.addEventListener('change', () => {
    diskWarning.hidden = !includeDisks.checked;
    updateEstimate();
  });
  cancel.addEventListener('click', () => dialog.close());
  confirm.addEventListener('click', () => {
    if (confirm.dataset.action !== 'back') { save(); return; }
    showRun(false);
    resetButtons();
    applySaveChoice();
  });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Enter' && busy) event.preventDefault(); });
}
