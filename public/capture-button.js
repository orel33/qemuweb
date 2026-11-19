// The Capture button of a console pane: opens the Capture dialog for the pane's host and shows, in
// red, that a capture of this host is recording. Hidden for a switch or an empty pane. The rules
// (observer, VirtualBox) are captureButtonState's, in captures.js.
import {machines} from './state.js';
import {capturesOf, captureButtonState, onCapturesChanged} from './captures.js';
import {openCaptureDialog} from './capture-dialog.js';
import {panes} from './terminal.js';

const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#pane-capture-icon"></use></svg>';

// Creates the pane's button; the caller places it in the pane bar.
export function createCaptureButton(pane) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pane-capture-button';
  button.hidden = true;
  button.innerHTML = ICON;
  button.addEventListener('click', () => { if (pane.machineId) openCaptureDialog(pane.machineId, {pane}); });
  return button;
}

export function updateCaptureButton(pane) {
  const nodeId = pane.machineId;
  const machine = nodeId && machines.get(nodeId);
  const state = captureButtonState(machine, nodeId ? capturesOf(nodeId) : []);
  const button = pane.captureButton;
  button.hidden = state.hidden;
  button.disabled = state.disabled;
  button.title = state.title;
  button.setAttribute('aria-label', state.title || 'Capture');
  button.dataset.recording = String(state.recording > 0);
}

export const updateCaptureButtons = () => panes.forEach(updateCaptureButton);
onCapturesChanged(updateCaptureButtons);
