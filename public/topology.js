// Starts the saved view (Terminals or Graphic) and downloads the session as a .topo file for the Save Session dialog
// (public/save-dialog.js). The Load Session dialog (public/load-dialog.js) loads topologies.
import {savedView} from './state.js';
import {setGraphicView} from './graphic-view.js';

export function initTopology() {
  setGraphicView(savedView?.mode === 'graphic');
}

// Downloads the session as a .topo file; throws the server's error message.
export async function downloadTopology(fileName) {
  const response = await fetch('/api/topology', {cache: 'no-store'});
  if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Cannot save topology.'); }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = url; link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
