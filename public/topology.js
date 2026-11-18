// .topo topology load/save; starts the saved view (Terminals or Graphic).
import {generalSettings, savedView} from './state.js';
import {jsonRequest, requestJson} from './api.js';
import {setGraphicView} from './graphic-view.js';

const topologyFile = document.getElementById('topology-file');
const topologyDialog = document.getElementById('topology-dialog');
const topologyError = document.getElementById('topology-error');
const topologyConfirm = document.getElementById('confirm-topology');
const topologyCounts = document.getElementById('topology-counts');
const topologyCancel = document.getElementById('cancel-topology');
let topologyLoaded = false;
let topologyText = '';

export function initTopology() {
  setGraphicView(savedView?.mode === 'graphic');
  document.getElementById('load-topology').addEventListener('click', () => topologyFile.click());
  topologyCancel.addEventListener('click', () => topologyDialog.close());
  topologyDialog.addEventListener('cancel', event => { if (topologyConfirm.disabled) event.preventDefault(); });
  topologyDialog.addEventListener('close', () => { if (topologyLoaded) location.reload(); });
  topologyFile.addEventListener('change', async () => {
    const file = topologyFile.files[0];
    if (!file) return;
    topologyFile.value = '';
    document.getElementById('topology-title').textContent = 'Load topology';
    document.getElementById('topology-file-name').textContent = file.name;
    topologyCounts.textContent = '';
    document.getElementById('topology-options').hidden = false;
    topologyError.hidden = true; topologyConfirm.hidden = false; topologyConfirm.disabled = true;
    topologyCancel.textContent = 'Cancel';
    document.getElementById('topology-autostart').checked = true;
    document.getElementById('topology-close-previous').checked = false;
    topologyDialog.showModal();
    try {
      if (!/\.topo$/i.test(file.name)) throw new Error('Choose a .topo file.');
      topologyText = await file.text();
      const result = await requestJson('/api/topology/preview', jsonRequest('POST', {text: topologyText, engine: generalSettings.engine}), 'Invalid topology.');
      topologyCounts.textContent = `${result.hosts} hosts · ${result.switches} switches`;
      topologyConfirm.disabled = false;
    }
    catch (error) { topologyText = ''; topologyError.textContent = error.message; topologyError.hidden = false; topologyConfirm.hidden = true; topologyConfirm.disabled = false; }
  });
  document.getElementById('topology-form').addEventListener('submit', async event => {
    event.preventDefault();
    topologyConfirm.disabled = true;
    topologyCancel.disabled = true;
    try {
      const result = await requestJson('/api/topology', jsonRequest('POST', {text: topologyText, engine: generalSettings.engine, autostart: document.getElementById('topology-autostart').checked, closePrevious: document.getElementById('topology-close-previous').checked}), 'Cannot load topology.');
      topologyLoaded = true;
      if (result.errors?.length) {
        topologyError.textContent = result.errors.join('\n'); topologyError.hidden = false;
        topologyConfirm.hidden = true; topologyCancel.textContent = 'Close';
      } else location.reload();
    } catch (error) { topologyError.textContent = error.message; topologyError.hidden = false; }
    finally { topologyConfirm.disabled = false; topologyCancel.disabled = false; }
  });
  document.getElementById('save-topology').addEventListener('click', async () => {
    try {
      const response = await fetch('/api/topology', {cache: 'no-store'});
      if (!response.ok) { const result = await response.json(); throw new Error(result.error); }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = 'network.topo'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      document.getElementById('topology-title').textContent = 'Save topology';
      document.getElementById('topology-file-name').textContent = '';
      topologyCounts.textContent = '';
      document.getElementById('topology-options').hidden = true;
      topologyError.textContent = error.message; topologyError.hidden = false;
      topologyConfirm.hidden = true; document.getElementById('cancel-topology').textContent = 'Close'; topologyDialog.showModal();
    }
  });
}
