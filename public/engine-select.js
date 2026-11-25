// The Engine select of the header, next to the title: the engine of the session the page
// shows (the observed one while an administrator observes). It is frozen while a host is up or
// busy; the server refuses the change in that case too. Engines the runner does not have are
// disabled; with a single engine the select is disabled.
import {generalSettings, machines, store} from './state.js';
import {jsonRequest, requestJson} from './api.js';
import {canWrite, controllingAdmin, observing} from './observe.js';

const ENGINES = [{value: 'qemu', text: 'QEMU - KVM', name: 'QEMU'}, {value: 'vbox', text: 'VirtualBox', name: 'VirtualBox'}];
export const FROZEN_REASON = 'Stop all hosts to change the engine';

// Whether any host of the list has a machine up or an action in progress (starting, stopping,
// rebooting, loading, resetting).
export function hostsInUse(list) {
  return [...list].some(item => item.kind === 'host' && (!!item.running || !!item.busy));
}

// What the select shows: {value, disabled, reason, options: [{value, text, disabled, title}]}.
// observing: an observer without control (read-only); controlledBy: the admin controlling the owner's session, or null.
export function engineSelectState({engine, availableEngines, inUse, observing: observed, controlledBy = null}) {
  const available = Array.isArray(availableEngines) ? availableEngines : [];
  const options = ENGINES.map(option => ({value: option.value, text: option.text, disabled: !available.includes(option.value),
    title: available.includes(option.value) ? '' : `${option.name} is unavailable on this server`}));
  let reason = '';
  if (observed) reason = 'The engine of the observed session (read-only)';
  else if (controlledBy) reason = `${controlledBy} controls your session`;
  else if (inUse) reason = FROZEN_REASON;
  else if (available.length < 2) reason = available.length ? 'Only one engine is available on this server' : '';
  return {value: ENGINES.some(option => option.value === engine) ? engine : '', disabled: !!reason || !available.length, reason, options};
}

// "QEMU - KVM" or "VirtualBox" for an engine value, '' for another one.
export function engineName(engine) { return ENGINES.find(option => option.value === engine)?.text || ''; }

// The note of Host Settings: the values shown are those of the session engine; the other engine's
// values of the host are kept separately in its host.json.
export function engineSettingsNote(engine) {
  const current = ENGINES.find(option => option.value === engine);
  const other = ENGINES.find(option => option.value !== engine);
  return current ? `These settings are for ${current.text}; the ${other.text} settings of this host are kept separately.` : '';
}

// The warning about hosts that cannot start on the new engine ('' when there is none).
export function unavailableHostsWarning(unavailableHosts) {
  const list = (unavailableHosts || []).map(item => item.message).filter(Boolean);
  return list.length ? `These hosts cannot start with this engine: ${list.join('; ')}.` : '';
}

const picker = document.getElementById('engine-picker');
const select = document.getElementById('session-engine');
// What is shown now: the select is rebuilt only when it changes, so that an open list is not closed by an update.
let shown = '';

// Shows the state of the select from the engine, the runner's engines and the hosts of the page.
export function updateEngineSelect() {
  if (!select) return;
  const state = engineSelectState({engine: generalSettings.engine, availableEngines: store.availableEngines,
    inUse: hostsInUse(machines.values()), observing: observing && !canWrite(), controlledBy: observing || canWrite() ? null : controllingAdmin()});
  const signature = JSON.stringify(state);
  if (signature === shown) return;
  shown = signature;
  select.replaceChildren(...state.options.map(item => {
    const option = new Option(item.text, item.value);
    option.disabled = item.disabled;
    if (item.title) option.title = item.title;
    return option;
  }));
  select.value = state.value;
  select.disabled = state.disabled;
  for (const element of [select, picker]) { if (state.reason) element.title = state.reason; else element.removeAttribute('title'); }
  picker.hidden = !state.value;
}

// Changes the session engine when the user picks another one. onChanged(body) refreshes the page
// from the answer ({engine, unavailableHosts}); onError(message) reports a refusal.
export function bindEngineSelect({onChanged, onError}) {
  select.addEventListener('change', async () => {
    const engine = select.value;
    select.disabled = true;
    try {
      const body = await requestJson('/api/general-settings', jsonRequest('PUT', {engine}), 'Cannot change session engine');
      generalSettings.engine = body.engine;
      await onChanged(body);
    } catch (error) { onError(error.message); }
    finally { shown = ''; updateEngineSelect(); }
  });
}
