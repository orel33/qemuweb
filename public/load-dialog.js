// The Load dialog: one file picker for a topology (.topo) or a session (.zip), and the list of the
// server's examples. The kind of a file is its extension, confirmed by its content; it then goes on into the
// existing flow of its kind (public/archive.js review of a session, public/topology.js load of a topology).
import {machines} from './state.js';
import {jsonRequest} from './api.js';
import {showArchiveLoadBlockedWarning, startArchiveLoad} from './archive.js';
import {startTopologyLoad} from './topology.js';
import {contentProblem, formatSize, kindLabel, kindOfFileName, loadFlow, needsEmptySession} from './file-kinds.js';

const MAX_TOPOLOGY_BYTES = 262144;
const dialog = document.getElementById('load-dialog');
const fileInput = document.getElementById('load-file');
const errorLine = document.getElementById('load-error');
const examplesSection = document.getElementById('load-examples');
const exampleList = document.getElementById('load-example-list');

function showError(message) {
  errorLine.textContent = message;
  errorLine.hidden = !message;
}

// Checks the file against its kind, then hands it to the flow of that kind. `example` is the name of a
// server example whose bytes `file` holds (the load then reads the example from the server's disk).
async function openFile(file, example = null) {
  showError('');
  const kind = kindOfFileName(file.name);
  if (!kind) { showError('Choose a .topo (topology) or .zip (session) file.'); return; }
  if (needsEmptySession(kind) && machines.size) { dialog.close(); showArchiveLoadBlockedWarning(); return; }
  try {
    if (kind === 'topology' && file.size > MAX_TOPOLOGY_BYTES) throw new Error('Topology must be text under 256 KB.');
    const head = new Uint8Array(await file.slice(0, kind === 'topology' ? file.size : 4).arrayBuffer());
    const problem = contentProblem(kind, head);
    if (problem) throw new Error(`${file.name}: ${problem}`);
    const text = loadFlow(kind) === 'topology' ? new TextDecoder().decode(head) : null;
    dialog.close();
    if (loadFlow(kind) === 'archive') startArchiveLoad(file, {example});
    else startTopologyLoad({name: file.name, text, example});
  } catch (error) { showError(error.message); }
}

async function chooseExample(example) {
  showError('');
  if (needsEmptySession(example.kind) && machines.size) { dialog.close(); showArchiveLoadBlockedWarning(); return; }
  try {
    const response = await fetch('/api/examples/file', jsonRequest('POST', {name: example.name}));
    if (!response.ok) throw new Error((await response.json()).error || 'Cannot read the example.');
    await openFile(new File([await response.blob()], example.name), example.name);
  } catch (error) { showError(error.message); }
}

function exampleItem(example) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'example-item';
  for (const [className, text] of [['example-name', example.name], ['example-kind', kindLabel(example.kind)], ['example-size', formatSize(example.size)], ['example-description', example.description]]) {
    if (!text) continue;
    const part = document.createElement('span');
    part.className = className;
    part.textContent = text;
    button.append(part);
  }
  button.addEventListener('click', () => chooseExample(example));
  item.append(button);
  return item;
}

// The list of the server's examples, asked afresh at each opening; no list when there is none or it fails.
async function showExamples() {
  examplesSection.hidden = true;
  try {
    const response = await fetch('/api/examples', {cache: 'no-store'});
    if (!response.ok) return;
    const examples = await response.json();
    exampleList.replaceChildren(...examples.map(exampleItem));
    examplesSection.hidden = examples.length === 0;
  } catch (_) { /* No examples shown. */ }
}

export function initLoadDialog() {
  document.getElementById('load-session-archive').addEventListener('click', () => {
    fileInput.value = '';
    showError('');
    dialog.showModal();
    showExamples();
  });
  document.getElementById('close-load-dialog').addEventListener('click', () => dialog.close());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (file) openFile(file);
  });
}
