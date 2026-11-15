// Host Settings startup tab: start.sh template, startup disk and extra files.
import {store} from './state.js';
import {optionsStatus, qemuOptionsPanel, refreshLaunchPreview, settingsMachine} from './host-settings.js';

let extraFilesLoading = false;

const guestStartScript = document.getElementById('guest-start-script');
const guestScriptFile = document.getElementById('guest-script-file');

const guestAttachCdrom = document.getElementById('guest-attach-cdrom');

const addExtraFiles = document.getElementById('add-extra-files');
const extraFilesInput = document.getElementById('extra-files-input');
const extraFilesList = document.getElementById('extra-files-list');
const extraFilesError = document.getElementById('extra-files-error');

const startupTemplateValues = document.getElementById('startup-template-values');
const startupTemplateError = document.getElementById('startup-template-error');
const startupTemplateErrorText = document.getElementById('startup-template-error-text');

export function renderGuestMedia() {
  const machine = settingsMachine();
  if (!machine) return;
  guestStartScript.value = machine.guestMedia?.script || '';
  guestAttachCdrom.checked = !!machine.startupDiskEnabled;
  guestAttachCdrom.disabled = !store.autoCdromSupported;
  store.startupTemplatePreview = machine.networkInterfaces || [];
  renderStartupTemplateValues(machine);
  extraFilesError.textContent = '';
  extraFilesError.hidden = true;
  renderExtraFiles(machine);
}
function renderExtraFiles(machine) {
  extraFilesList.replaceChildren();
  addExtraFiles.disabled = !!machine.busy || extraFilesLoading;
  const resources = machine.guestMedia?.resources || [];
  if (!resources.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No extra files.';
    extraFilesList.append(empty);
    return;
  }
  for (const resource of resources) {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'extra-file-name';
    name.textContent = resource.path;
    const size = document.createElement('span');
    size.className = 'extra-file-size';
    size.textContent = `${atob(resource.contentBase64).length.toLocaleString()} bytes`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${resource.path}`);
    remove.disabled = !!machine.busy || extraFilesLoading;
    remove.addEventListener('click', () => {
      if (settingsMachine() !== machine) return;
      machine.guestMedia.resources = machine.guestMedia.resources.filter(entry => entry !== resource);
      extraFilesError.hidden = true;
      renderExtraFiles(machine);
    });
    row.append(name, size, remove);
    extraFilesList.append(row);
  }
}

export function renderStartupTemplateValues(machine, interfaces = store.startupTemplatePreview) {
  startupTemplateValues.replaceChildren();
  function addValue(token, value) {
    const row = document.createElement('div');
    const name = document.createElement('code'); name.textContent = token;
    const result = document.createElement('span'); result.textContent = value;
    result.title = value;
    row.append(name, '=', result);
    startupTemplateValues.append(row);
  }
  addValue('@HOSTNAME@', machine.hostname || '');
  for (let index = 0; index < (machine.interfaces || []).length; index++) {
    addValue(`@IFNAME${index}@`, `eth${index}`);
    const port = interfaces[index]?.port;
    addValue(`@SWPORT${index}@`, Number.isInteger(port) ? String(port) : 'Disconnected');
  }
}
export function defaultStartScript(interfaces) {
  return '#!/bin/sh\nhostname @HOSTNAME@\n' +
    (interfaces.length ? 'ifconfig @IFNAME0@ 192.168.0.@SWPORT0@ netmask 255.255.255.0 up\n' : '');
}
export function validateStartScriptDraft(machine) {
  if (!machine.startupDiskEnabled) return;
  const script = machine.guestMedia?.script || '';
  const interfaces = machine.interfaces || [];
  const unresolved = new Set();
  const remaining = script.replace(/@([A-Za-z][A-Za-z0-9_]*)@/g, (token, key) => {
    if (key === 'HOSTNAME') return '';
    const match = /^(IFNAME|SWPORT)([0-3])$/.exec(key);
    if (!match) { unresolved.add(token); return ''; }
    const index = Number(match[2]);
    if (index >= interfaces.length) { unresolved.add(token); return ''; }
    if (match[1] === 'SWPORT' && !interfaces[index]) {
      unresolved.add(token);
    }
    return '';
  });
  const malformed = new Set([...remaining.matchAll(/@(?:HOSTNAME|IFNAME\d*|SWPORT\d*)(?![A-Za-z0-9_@])|\b(?:HOSTNAME|IFNAME\d+|SWPORT\d+)@/g)]
    .map(match => match[0]));
  const problems = [];
  if (unresolved.size) problems.push(`unresolved variables in start.sh: ${[...unresolved].join(', ')}`);
  if (malformed.size) problems.push(`malformed variables in start.sh: ${[...malformed].join(', ')}`);
  if (problems.length) throw new Error(`Error: ${problems.join('; ')}.`);
}
export function showStartupTemplateError(message) {
  optionsStatus.hidden = true;
  optionsStatus.textContent = '';
  startupTemplateErrorText.textContent = message;
  startupTemplateError.hidden = false;
  startupTemplateError.scrollIntoView({block: 'nearest'});
}
export function clearStartupTemplateError() {
  startupTemplateError.hidden = true;
  startupTemplateErrorText.textContent = '';
}

export function initStartupMedia() {
  document.getElementById('load-start-script').addEventListener('click', () => guestScriptFile.click());
  fetch('/api/guest-cdrom-capability', {cache: 'no-store'})
    .then(response => response.ok ? response.json() : null)
    .then(capabilities => {
      store.autoCdromSupported = capabilities?.autoBuild === true;
      store.isoPreviewSupported = capabilities?.previewIso === true;
      guestAttachCdrom.disabled = !store.autoCdromSupported;
    })
    .catch(() => { guestAttachCdrom.disabled = true; });
  addExtraFiles.addEventListener('click', () => extraFilesInput.click());
  extraFilesInput.addEventListener('change', async () => {
    const machine = settingsMachine();
    const files = [...extraFilesInput.files];
    extraFilesInput.value = '';
    if (!machine || !files.length) return;
    extraFilesLoading = true;
    renderExtraFiles(machine);
    try {
      const resources = [...(machine.guestMedia?.resources || [])];
      for (const file of files) {
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(file.name) || file.name === '.' || file.name === '..' || file.name === 'start.sh') {
          throw new Error(`Invalid extra file name: ${file.name}. Use an ASCII name other than start.sh.`);
        }
        if (file.size > 1048576) throw new Error(`${file.name} exceeds 1 MiB.`);
        if (resources.some(resource => resource.path.startsWith(`${file.name}/`))) {
          throw new Error(`${file.name} conflicts with an existing extra file path.`);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        }
        const entry = {path: file.name, contentBase64: btoa(binary)};
        const index = resources.findIndex(resource => resource.path === file.name);
        if (index < 0) resources.push(entry);
        else resources[index] = entry;
      }
      if (resources.length > 32) throw new Error('At most 32 extra files are allowed.');
      const total = new TextEncoder().encode(machine.guestMedia?.script || '').length +
        resources.reduce((sum, resource) => sum + atob(resource.contentBase64).length, 0);
      if (total > 4194304) throw new Error('Startup files exceed 4 MiB in total.');
      if (settingsMachine() !== machine || !qemuOptionsPanel.open) return;
      machine.guestMedia.resources = resources;
      extraFilesError.hidden = true;
      renderExtraFiles(machine);
    } catch (error) {
      if (settingsMachine() === machine) {
        extraFilesError.textContent = error.message;
        extraFilesError.hidden = false;
      }
    } finally {
      extraFilesLoading = false;
      if (settingsMachine() === machine) renderExtraFiles(machine);
    }
  });
  guestStartScript.addEventListener('input', () => {
    const machine = settingsMachine();
    if (!machine) return;
    if (!machine.guestMedia) machine.guestMedia = {script: '', resources: []};
    machine.guestMedia.script = guestStartScript.value;
    clearStartupTemplateError();
  });
  guestScriptFile.addEventListener('change', async () => {
    const file = guestScriptFile.files?.[0];
    if (!file) return;
    try {
      if (file.size > 65536) throw new Error('start.sh must be at most 64 KiB.');
      const script = new TextDecoder('utf-8', {fatal: true}).decode(await file.arrayBuffer());
      if (script.includes('\0')) throw new Error('start.sh cannot contain NUL bytes.');
      const machine = settingsMachine();
      if (machine) {
        if (!machine.guestMedia) machine.guestMedia = {script: '', resources: []};
        machine.guestMedia.script = script;
        renderGuestMedia();
        clearStartupTemplateError();
      }
    } catch (error) { optionsStatus.textContent = error.message; optionsStatus.hidden = false; }
    guestScriptFile.value = '';
  });
  guestAttachCdrom.addEventListener('change', () => {
    const machine = settingsMachine();
    if (!machine) return;
    machine.startupDiskEnabled = guestAttachCdrom.checked;
    clearStartupTemplateError();
    refreshLaunchPreview(machine);
  });
}
