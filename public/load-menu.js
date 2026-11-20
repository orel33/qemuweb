// The Load button: an upward menu with "From User Files" (the system file picker, .topo or .zip) and "From Server
// (Examples)" (a dropdown of the server's examples in a small dialog). A chosen file or example is checked by extension
// and content, then goes to the Load Session dialog (a ZIP) or the Load Topology dialog (a topology).
import {jsonRequest} from './api.js';
import {showStatusError} from './workspace.js';
import {startArchiveLoad} from './archive.js';
import {startTopologyLoad} from './topology.js';
import {canLoadExample, exampleOptionLabel, kindOfFileName, routeFile, serverItemState} from './file-kinds.js';

const MAX_TOPOLOGY_BYTES = 262144;
const button = document.getElementById('load-session-archive');
const menu = document.getElementById('load-menu');
const filesItem = document.getElementById('load-from-files');
const serverItem = document.getElementById('load-from-server');
const fileInput = document.getElementById('load-file');
const dialog = document.getElementById('examples-dialog');
const select = document.getElementById('load-example-select');
const description = document.getElementById('load-example-description');
const loadButton = document.getElementById('load-example-button');
const errorLine = document.getElementById('load-error');
let examples = [];

// Checks a file or example against its kind and opens the dialog of its kind; returns an error text, or '' when it went on.
// `example` is the name of a server example whose bytes `file` holds (the load then reads it from the server's disk).
async function openFile(file, example = null) {
  const kind = kindOfFileName(file.name);
  if (!kind) return routeFile(file.name, new Uint8Array()).error;
  if (kind === 'topology' && file.size > MAX_TOPOLOGY_BYTES) return 'Topology must be text under 256 KB.';
  const head = new Uint8Array(await file.slice(0, kind === 'topology' ? file.size : 4).arrayBuffer());
  const route = routeFile(file.name, head);
  if (route.error) return route.error;
  if (route.dialog === 'session') startArchiveLoad(file, {example});
  else startTopologyLoad({name: file.name, text: new TextDecoder().decode(head), example});
  return '';
}

function showError(message) {
  errorLine.textContent = message;
  errorLine.hidden = !message;
}

function updateExampleChoice() {
  const example = examples.find(item => item.name === select.value);
  description.textContent = example?.description || '';
  loadButton.disabled = !canLoadExample(select.value, examples);
}

async function loadExample() {
  showError('');
  try {
    const name = select.value;
    const response = await fetch('/api/examples/file', jsonRequest('POST', {name}));
    if (!response.ok) throw new Error((await response.json()).error || 'Cannot read the example.');
    const problem = await openFile(new File([await response.blob()], name), name);
    if (problem) showError(problem);
    else dialog.close();
  } catch (error) { showError(error.message); }
}

function showExamplesDialog() {
  select.replaceChildren(select.options[0], ...examples.map(example => {
    const option = document.createElement('option');
    option.value = example.name;
    option.textContent = exampleOptionLabel(example);
    return option;
  }));
  select.selectedIndex = 0;
  showError('');
  updateExampleChoice();
  dialog.showModal();
}

// The examples of the server, asked afresh at each opening of the menu; none when the request fails.
async function refreshExamples() {
  try {
    const response = await fetch('/api/examples', {cache: 'no-store'});
    examples = response.ok ? await response.json() : [];
  } catch (_) { examples = []; }
  const state = serverItemState(examples);
  serverItem.disabled = state.disabled;
  serverItem.textContent = state.label;
}

const items = () => [...menu.querySelectorAll('[role="menuitem"]')].filter(item => !item.disabled);

function closeMenu({restoreFocus = false} = {}) {
  if (menu.hidden) return;
  menu.hidden = true;
  button.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', outsideClick, true);
  if (restoreFocus) button.focus();
}

function outsideClick(event) {
  if (!menu.contains(event.target) && !button.contains(event.target)) closeMenu();
}

// Opens the menu above the button (the toolbar is at the bottom of the screen), inside the screen.
async function openMenu() {
  serverItem.disabled = true;
  menu.hidden = false;
  const rect = button.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  button.setAttribute('aria-expanded', 'true');
  document.addEventListener('click', outsideClick, true);
  filesItem.focus();
  await refreshExamples();
}

function moveFocus(step) {
  const list = items();
  if (!list.length) return;
  const index = list.indexOf(document.activeElement);
  list[(index + step + list.length) % list.length].focus();
}

export function initLoadMenu() {
  button.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
  button.addEventListener('keydown', event => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); if (menu.hidden) openMenu(); }
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeMenu({restoreFocus: true}); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(-1); }
    else if (event.key === 'Home') { event.preventDefault(); items()[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); items().at(-1)?.focus(); }
    else if (event.key === 'Tab') closeMenu();
  });
  filesItem.addEventListener('click', () => { closeMenu(); fileInput.value = ''; fileInput.click(); });
  serverItem.addEventListener('click', () => { if (serverItem.disabled) return; closeMenu(); showExamplesDialog(); });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    const problem = await openFile(file);
    if (problem) showStatusError(problem);
  });
  select.addEventListener('change', updateExampleChoice);
  loadButton.addEventListener('click', loadExample);
  document.getElementById('close-examples').addEventListener('click', () => dialog.close());
}
