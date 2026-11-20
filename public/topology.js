// .topo topology load review and download; starts the saved view (Terminals or Graphic). The Load and
// Save dialogs (public/load-dialog.js, public/archive.js) call startTopologyLoad and downloadTopology.
import {generalSettings, savedView} from './state.js';
import {jsonRequest, requestJson} from './api.js';
import {setGraphicView} from './graphic-view.js';

const topologyDialog = document.getElementById('topology-dialog');
const topologyError = document.getElementById('topology-error');
const topologyConfirm = document.getElementById('confirm-topology');
const topologyCounts = document.getElementById('topology-counts');
const topologyCancel = document.getElementById('cancel-topology');
let topologyLoaded = false;
let topologyText = '';
// The name of the server example being loaded, or null for the text of a file of the user.
let topologyExample = null;

export function initTopology() {
  setGraphicView(savedView?.mode === 'graphic');
  topologyCancel.addEventListener('click', () => topologyDialog.close());
  topologyDialog.addEventListener('cancel', event => { if (topologyConfirm.disabled) event.preventDefault(); });
  topologyDialog.addEventListener('close', () => { if (topologyLoaded) location.reload(); });
  document.getElementById('topology-form').addEventListener('submit', async event => {
    event.preventDefault();
    topologyConfirm.disabled = true;
    topologyCancel.disabled = true;
    try {
      const options = {engine: generalSettings.engine, autostart: document.getElementById('topology-autostart').checked, closePrevious: document.getElementById('topology-close-previous').checked};
      const result = await requestJson(topologyExample ? '/api/examples/load' : '/api/topology',
        jsonRequest('POST', topologyExample ? {name: topologyExample, ...options} : {text: topologyText, ...options}), 'Cannot load topology.');
      topologyLoaded = true;
      if (result.errors?.length) {
        topologyError.textContent = result.errors.join('\n'); topologyError.hidden = false;
        topologyConfirm.hidden = true; topologyCancel.textContent = 'Close';
      } else location.reload();
    } catch (error) { topologyError.textContent = error.message; topologyError.hidden = false; }
    finally { topologyConfirm.disabled = false; topologyCancel.disabled = false; }
  });
}

// Opens the review of a topology: its name, the server's preview of its text and the load options.
// `example` is the name of a file of the server's examples (the load then reads it from the server's disk).
export async function startTopologyLoad({name, text, example = null}) {
  topologyExample = example;
  document.getElementById('topology-file-name').textContent = name;
  topologyCounts.textContent = '';
  document.getElementById('topology-options').hidden = false;
  topologyError.hidden = true; topologyConfirm.hidden = false; topologyConfirm.disabled = true;
  topologyCancel.textContent = 'Cancel';
  document.getElementById('topology-autostart').checked = true;
  document.getElementById('topology-close-previous').checked = false;
  topologyDialog.showModal();
  try {
    topologyText = text;
    const result = await requestJson('/api/topology/preview', jsonRequest('POST', {text, engine: generalSettings.engine}), 'Invalid topology.');
    topologyCounts.textContent = `${result.hosts} hosts · ${result.switches} switches`;
    topologyConfirm.disabled = false;
  }
  catch (error) { topologyText = ''; topologyError.textContent = error.message; topologyError.hidden = false; topologyConfirm.hidden = true; topologyConfirm.disabled = false; }
}

// Downloads the session as a .topo file; throws the server's error message.
export async function downloadTopology(fileName) {
  const response = await fetch('/api/topology', {cache: 'no-store'});
  if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Cannot save topology.'); }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = url; link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
