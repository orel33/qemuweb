// The steps list shared by the Load Session and Load Topology dialogs, and the closing of the previous session they
// share: one line per stage (a state icon: spinner, green tick, warning, error; an optional detail). The Close step
// runs only when the user presses Load, after the file was read and checked (see shouldCloseSession).
import {machines} from './state.js';
import {removeAllNodes} from './nodes.js';
import {closedText, nodeCounts, shouldCloseSession} from './file-kinds.js';

const stateText = {pending: 'Pending', running: 'In progress', done: 'Done', warning: 'Warning', error: 'Failed'};

// Fills the <ol> `list` with one line per [name, label] and returns {set, reset}.
export function createSteps(list, steps) {
  list.replaceChildren(...steps.map(([name, label]) => {
    const item = document.createElement('li');
    item.dataset.step = name;
    item.dataset.state = 'pending';
    const icon = document.createElement('span');
    icon.className = 'archive-step-icon';
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'archive-step-text';
    const labelPart = document.createElement('span');
    labelPart.className = 'archive-step-label';
    labelPart.textContent = label;
    const detail = document.createElement('span');
    detail.className = 'archive-step-detail';
    detail.hidden = true;
    text.append(labelPart, detail);
    const state = document.createElement('span');
    state.className = 'archive-step-state';
    state.textContent = stateText.pending;
    item.append(icon, text, state);
    return item;
  }));
  const set = (name, state, detail = '') => {
    const item = list.querySelector(`[data-step="${name}"]`);
    item.dataset.state = state;
    item.querySelector('.archive-step-state').textContent = stateText[state];
    const part = item.querySelector('.archive-step-detail');
    part.textContent = detail;
    part.hidden = !detail;
  };
  const reset = (names = steps.map(([name]) => name)) => { for (const name of names) set(name, 'pending'); };
  return {set, reset};
}

// The Close step: removes every host and switch of the current session (the code of the Remove all button) when there
// is one, once, at Load. Returns whether something was closed; throws when the removal fails, nothing is loaded then.
export async function closePreviousSession(steps, {reviewed}) {
  const counts = nodeCounts(machines.values());
  if (!shouldCloseSession({reviewed, confirmed: true, nodeCount: machines.size})) { steps.set('close', 'done', 'No previous session'); return false; }
  steps.set('close', 'running');
  try { await removeAllNodes(); }
  catch (error) { throw new Error(`Cannot close the current session: ${error.message}`); }
  steps.set('close', 'done', closedText(counts.hosts, counts.switches));
  return true;
}

// The orange warning of a Load dialog, with its icon: returns set(text); an empty text empties the slot, which keeps
// its height (CSS), so the dialog never changes size.
export function warningSlot(element) {
  const namespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(namespace, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  for (const data of ['m10.29 3.86-8.48 14.14a2 2 0 0 0 1.71 3h16.96a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z', 'M12 9v4M12 17h.01']) {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', data);
    icon.append(path);
  }
  const message = document.createElement('span');
  element.replaceChildren(icon, message);
  return text => { message.textContent = text; element.hidden = !text; };
}
