// The one file selector of the Load Session dialog: a source switch ("Server examples" or "My files"), the list or the
// picker of that source, and the file card (name, kind, size, description, then the notes read from the file). The two
// sources give the same {source, name, size, kind, description, example, file} to onChoose; the dialog does the rest.
import {SOURCES, exampleOptionLabel, fileCardLines, kindOfFileName, serverSourceState} from './file-kinds.js';

export function createFileSelector({onChoose}) {
  const root = document.getElementById('file-selector');
  const switches = [...root.querySelectorAll('[role="radio"]')];
  const select = document.getElementById('example-select');
  const browse = document.getElementById('local-browse');
  const input = document.getElementById('load-file');
  const name = document.getElementById('file-card-name');
  const meta = document.getElementById('file-card-meta');
  const description = document.getElementById('file-card-description');
  const notes = document.getElementById('file-card-notes');
  let examples = [];
  let source = 'local';

  function showCard(info) {
    const lines = fileCardLines(info);
    name.textContent = lines.name;
    meta.textContent = lines.meta;
    description.textContent = lines.description;
    notes.replaceChildren();
    root.dataset.empty = String(!info);
  }

  function choose(info) {
    showCard(info);
    onChoose(info);
  }

  function setSource(next) {
    source = next;
    for (const button of switches) {
      button.setAttribute('aria-checked', String(button.dataset.source === next));
      button.tabIndex = button.dataset.source === next ? 0 : -1;
    }
    select.hidden = next !== 'server';
    browse.hidden = next !== 'local';
    select.selectedIndex = 0;
    input.value = '';
    choose(null);
  }

  select.addEventListener('change', () => {
    const example = examples.find(item => item.name === select.value);
    choose(example ? {source: 'server', name: example.name, size: example.size, kind: example.kind, description: example.description || '', example: example.name, file: null} : null);
  });
  browse.addEventListener('click', () => { input.value = ''; input.click(); });
  input.addEventListener('change', () => {
    const file = input.files[0];
    choose(file ? {source: 'local', name: file.name, size: file.size, kind: kindOfFileName(file.name), description: '', example: null, file} : null);
  });
  for (const button of switches) {
    button.addEventListener('click', () => { if (!button.disabled && button.dataset.source !== source) setSource(button.dataset.source); });
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const usable = switches.filter(item => !item.disabled);
      const next = usable[(usable.indexOf(button) + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + usable.length) % usable.length];
      if (next && next !== button) { setSource(next.dataset.source); next.focus(); }
    });
  }

  return {
    // Fills the list with the examples of the server and opens on `wanted` ('server' or 'local') when it can be used.
    open(list, wanted) {
      examples = list;
      const state = serverSourceState(examples);
      const serverButton = switches.find(button => button.dataset.source === 'server');
      serverButton.disabled = state.disabled;
      serverButton.title = state.hint;
      select.replaceChildren(select.options[0], ...examples.map(example => {
        const option = document.createElement('option');
        option.value = example.name;
        option.textContent = exampleOptionLabel(example);
        return option;
      }));
      setSource(SOURCES.includes(wanted) && !(wanted === 'server' && state.disabled) ? wanted : 'local');
    },
    source: () => source,
    // The lines under the file: [{text, state: 'info' | 'warning' | 'error'}].
    setNotes(lines) {
      notes.replaceChildren(...lines.map(line => {
        const item = document.createElement('li');
        item.dataset.state = line.state;
        item.textContent = line.text;
        return item;
      }));
    },
    // The picker and the source switch are frozen while a load runs.
    setDisabled(disabled) {
      for (const control of [select, browse]) control.disabled = disabled;
      for (const button of switches) button.disabled = disabled || (button.dataset.source === 'server' && serverSourceState(examples).disabled);
    }
  };
}
