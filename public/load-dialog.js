// The Load dialog: one file picker for a topology (.topo) or a session (.zip), and a dropdown of the
// server's examples. The kind of a file is its extension, confirmed by its content; it then goes on into the
// existing flow of its kind (public/archive.js review of a session, public/topology.js load of a topology). A
// session replaces the current one: when that is not empty the dialog first asks, then removes every host and
// switch with the code of the Remove all button (public/nodes.js removeAllNodes).
import {machines} from './state.js';
import {jsonRequest} from './api.js';
import {startArchiveLoad} from './archive.js';
import {startTopologyLoad} from './topology.js';
import {removeAllNodes} from './nodes.js';
import {canLoadExample, contentProblem, exampleOptionLabel, kindOfFileName, loadFlow, needsReplaceConfirmation, replaceMessage} from './file-kinds.js';

const MAX_TOPOLOGY_BYTES = 262144;
const dialog = document.getElementById('load-dialog');
const picker = document.getElementById('load-picker');
const actions = document.getElementById('load-actions');
const fileInput = document.getElementById('load-file');
const errorLine = document.getElementById('load-error');
const examplesSection = document.getElementById('load-examples');
const exampleSelect = document.getElementById('load-example-select');
const exampleDescription = document.getElementById('load-example-description');
const exampleButton = document.getElementById('load-example-button');
const replaceBox = document.getElementById('load-replace');
const replaceText = document.getElementById('load-replace-text');
const replaceStatus = document.getElementById('load-replace-status');
const replaceCancel = document.getElementById('load-replace-cancel');
const replaceContinue = document.getElementById('load-replace-continue');
let examples = [];
// The session file waiting for the user's answer to the replace confirmation: {file, example}.
let pending = null;
let removing = false;

function showError(message) {
  errorLine.textContent = message;
  errorLine.hidden = !message;
}

function showPicker() {
  pending = null;
  replaceBox.hidden = true;
  picker.hidden = false;
  actions.hidden = false;
}

// Asks before the current session is replaced: Cancel goes back to the picker, Continue removes the nodes.
function askReplace(file, example) {
  const nodes = [...machines.values()];
  pending = {file, example};
  replaceText.textContent = replaceMessage(nodes.filter(node => node.kind === 'host').length, nodes.filter(node => node.kind === 'switch').length);
  replaceStatus.hidden = true;
  replaceCancel.disabled = replaceContinue.disabled = false;
  picker.hidden = true;
  actions.hidden = true;
  replaceBox.hidden = false;
  replaceCancel.focus();
}

// Hands a checked file to the flow of its kind.
function goOn(kind, file, example, text) {
  dialog.close();
  if (loadFlow(kind) === 'archive') startArchiveLoad(file, {example});
  else startTopologyLoad({name: file.name, text, example});
}

// Checks the file against its kind, asks to replace the session when needed, then hands it to the flow of its
// kind. `example` is the name of a server example whose bytes `file` holds (the load then reads the example from
// the server's disk).
async function openFile(file, example = null) {
  showError('');
  const kind = kindOfFileName(file.name);
  if (!kind) { showError('Choose a .topo (topology) or .zip (session) file.'); return; }
  try {
    if (kind === 'topology' && file.size > MAX_TOPOLOGY_BYTES) throw new Error('Topology must be text under 256 KB.');
    const head = new Uint8Array(await file.slice(0, kind === 'topology' ? file.size : 4).arrayBuffer());
    const problem = contentProblem(kind, head);
    if (problem) throw new Error(`${file.name}: ${problem}`);
    if (needsReplaceConfirmation(kind, machines.size)) { askReplace(file, example); return; }
    goOn(kind, file, example, loadFlow(kind) === 'topology' ? new TextDecoder().decode(head) : null);
  } catch (error) { showError(error.message); }
}

async function chooseExample(name) {
  showError('');
  try {
    const response = await fetch('/api/examples/file', jsonRequest('POST', {name}));
    if (!response.ok) throw new Error((await response.json()).error || 'Cannot read the example.');
    await openFile(new File([await response.blob()], name), name);
  } catch (error) { showError(error.message); }
}

function updateExampleChoice() {
  const example = examples.find(item => item.name === exampleSelect.value);
  exampleDescription.textContent = example?.description || '';
  exampleButton.disabled = !canLoadExample(exampleSelect.value, examples);
}

// The dropdown of the server's examples, asked afresh at each opening; hidden when there is none or it fails.
async function showExamples() {
  examplesSection.hidden = true;
  try {
    const response = await fetch('/api/examples', {cache: 'no-store'});
    if (!response.ok) return;
    examples = await response.json();
    const options = examples.map(example => {
      const option = document.createElement('option');
      option.value = example.name;
      option.textContent = exampleOptionLabel(example);
      return option;
    });
    exampleSelect.replaceChildren(exampleSelect.options[0], ...options);
    exampleSelect.selectedIndex = 0;
    updateExampleChoice();
    examplesSection.hidden = examples.length === 0;
  } catch (_) { /* No examples shown. */ }
}

async function continueReplace() {
  const {file, example} = pending;
  removing = true;
  replaceCancel.disabled = replaceContinue.disabled = true;
  replaceStatus.textContent = 'Removing hosts and switches…';
  replaceStatus.hidden = false;
  replaceStatus.removeAttribute('role');
  try {
    await removeAllNodes();
  } catch (error) {
    replaceStatus.textContent = `Cannot remove all hosts and switches: ${error.message}`;
    replaceStatus.setAttribute('role', 'alert');
    replaceCancel.disabled = replaceContinue.disabled = false;
    return;
  } finally { removing = false; }
  goOn('session', file, example, null);
}

export function initLoadDialog() {
  document.getElementById('load-session-archive').addEventListener('click', () => {
    fileInput.value = '';
    showError('');
    showPicker();
    dialog.showModal();
    showExamples();
  });
  document.getElementById('close-load-dialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (removing) event.preventDefault(); });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (file) openFile(file);
  });
  exampleSelect.addEventListener('change', updateExampleChoice);
  exampleButton.addEventListener('click', () => { if (canLoadExample(exampleSelect.value, examples)) chooseExample(exampleSelect.value); });
  replaceCancel.addEventListener('click', showPicker);
  replaceContinue.addEventListener('click', continueReplace);
}
