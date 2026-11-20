// The Load Topology dialog (same structure as Load Session: steps, options, the orange warning, Cancel / Load) and the
// .topo download of the Save dialog; starts the saved view (Terminals or Graphic). The Load menu (public/load-menu.js)
// calls startTopologyLoad, the Save dialog (public/archive.js) downloadTopology.
import {generalSettings, machines, savedView} from './state.js';
import {jsonRequest, requestJson} from './api.js';
import {setGraphicView} from './graphic-view.js';
import {closeWarning, countPhrase, nodeCounts} from './file-kinds.js';
import {closePreviousSession, createSteps, warningSlot} from './load-steps.js';

const topologyDialog = document.getElementById('topology-dialog');
const topologyOptions = document.getElementById('topology-options');
const topologyConfirm = document.getElementById('confirm-topology');
const topologyCancel = document.getElementById('cancel-topology');
const topologySteps = createSteps(document.getElementById('topology-steps'), [['read', 'Read topology'], ['close', 'Close previous session'], ['load', 'Load topology']]);
const setWarning = warningSlot(document.getElementById('topology-warning'));
let topologyLoaded = false;
let topologyText = '';
let topologyBusy = false;
// Whether the topology was read and validated by the server's preview: only then can Load close the previous session.
let topologyReviewed = false;
// The name of the server example being loaded, or null for the text of a file of the user.
let topologyExample = null;

// Loads the topology: closes the previous session first (once, now that the user pressed Load and the file is checked),
// then creates the nodes. A failure after the closing says the session is empty.
async function loadTopology() {
  topologyBusy = true;
  topologyConfirm.disabled = topologyCancel.disabled = true;
  topologyOptions.hidden = true;
  topologySteps.reset(['close', 'load']);
  topologyDialog.setAttribute('aria-busy', 'true');
  let step = 'close';
  let closed = false;
  try {
    closed = await closePreviousSession(topologySteps, {reviewed: topologyReviewed});
    if (closed) setWarning('');
    step = 'load';
    topologySteps.set('load', 'running');
    const options = {engine: generalSettings.engine, autostart: document.getElementById('topology-autostart').checked};
    const result = await requestJson(topologyExample ? '/api/examples/load' : '/api/topology',
      jsonRequest('POST', topologyExample ? {name: topologyExample, ...options} : {text: topologyText, ...options}), 'Cannot load topology.');
    topologyLoaded = true;
    if (result.errors?.length) {
      topologySteps.set('load', 'warning', `Topology loaded, but some instances could not start:\n${result.errors.join('\n')}`);
      topologyCancel.textContent = 'Close';
    } else {
      topologySteps.set('load', 'done');
      // Leave the final tick visible for a moment before the page reloads.
      await new Promise(resolve => setTimeout(resolve, 700));
      topologyDialog.close();
    }
  } catch (error) {
    topologySteps.set(step, 'error', closed ? `${error.message}\nThe previous session was closed: the current session is empty.` : error.message);
    topologyCancel.textContent = 'Close';
  } finally {
    topologyBusy = false;
    topologyCancel.disabled = false;
    topologyDialog.removeAttribute('aria-busy');
  }
}

export function initTopology() {
  setGraphicView(savedView?.mode === 'graphic');
  topologyCancel.addEventListener('click', () => topologyDialog.close());
  topologyDialog.addEventListener('cancel', event => { if (topologyBusy) event.preventDefault(); });
  topologyDialog.addEventListener('close', () => { if (topologyLoaded) location.reload(); });
  topologyConfirm.addEventListener('click', loadTopology);
}

// Opens the review of a topology: its name and the server's preview of its text (hosts, switches and links). Nothing is
// created, and nothing is closed, until the user presses Load. `example` is the name of a file of the server's examples
// (the load then reads it from the server's disk).
export async function startTopologyLoad({name, text, example = null}) {
  topologyExample = example;
  topologyText = text;
  topologyReviewed = false;
  topologyLoaded = false;
  document.getElementById('topology-file-name').textContent = name;
  topologySteps.reset();
  topologyOptions.hidden = true;
  topologyConfirm.disabled = true;
  topologyCancel.textContent = 'Cancel';
  document.getElementById('topology-autostart').checked = true;
  const counts = nodeCounts(machines.values());
  setWarning(closeWarning(counts.hosts, counts.switches));
  topologyDialog.showModal();
  topologySteps.set('read', 'running');
  try {
    const result = await requestJson('/api/topology/preview', jsonRequest('POST', {text, engine: generalSettings.engine}), 'Invalid topology.');
    topologySteps.set('read', 'done', `${countPhrase(result.hosts, 'host')} · ${countPhrase(result.switches, 'switch', 'switches')} · ${countPhrase(result.links, 'link')}`);
    topologyOptions.hidden = false;
    topologyConfirm.disabled = false;
    topologyReviewed = true;
  } catch (error) {
    topologyText = '';
    topologySteps.set('read', 'error', `${error.message} Nothing was changed.`);
  }
}

// Downloads the session as a .topo file; throws the server's error message.
export async function downloadTopology(fileName) {
  const response = await fetch('/api/topology', {cache: 'no-store'});
  if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Cannot save topology.'); }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = url; link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
