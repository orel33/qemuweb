// The system list of the session engine (GET /api/systems): the profile of a system (memory,
// processors, clock, serial ports, label) differs per engine, so the list is read again when the
// engine of the session changes, or a draft would carry the settings of the previous engine.
import {store} from './state.js';
import {requestJson} from './api.js';

export async function refreshSystems() {
  const items = await requestJson('/api/systems', {cache: 'no-store'}, 'System list unavailable');
  store.images = items;
  const select = document.getElementById('os-image');
  const previous = select.value;
  select.replaceChildren(...items.map(image => { const option = document.createElement('option'); option.value = image.id; option.textContent = image.label; return option; }));
  if (items.some(image => image.id === previous)) select.value = previous;
  document.getElementById('new-host').disabled = !items.length;
}
