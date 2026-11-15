// Add switch and Clone dialogs.
import {generalSettings, machines, store} from './state.js';
import {nodeUrl, requestJson} from './api.js';
import {activeMachine, cloneButton, updateControls} from './workspace.js';
import {addHost, addSwitch, nextMachineName, startActiveMachine} from './nodes.js';
import {openHostSettingsCreate, renderNicControls} from './host-settings.js';

let createKind = null;
let createDraft = null;
let cloneSourceId = null;

export const imageSelect = document.getElementById('os-image');
export const engineSelect = document.getElementById('engine');
export const createDialog = document.getElementById('create-dialog');
const createForm = document.getElementById('create-form');
const createTitle = document.getElementById('create-title');
const createName = document.getElementById('create-name');
const createAutostart = document.getElementById('create-autostart');
const createError = document.getElementById('create-error');
const confirmCreate = document.getElementById('confirm-create');
const cloneDialog = document.getElementById('clone-dialog');
const cloneForm = document.getElementById('clone-form');
const cloneTitle = document.getElementById('clone-title');
const cloneName = document.getElementById('clone-name');
const cloneNetworkRow = document.getElementById('clone-network-row');
const cloneNetwork = document.getElementById('clone-network');
const cloneAutostart = document.getElementById('clone-autostart');
const cloneError = document.getElementById('clone-error');
const confirmClone = document.getElementById('confirm-clone');
const cancelClone = document.getElementById('cancel-clone');
const createNetwork = document.getElementById('create-network');
const createNicList = document.getElementById('create-nic-list');
const createAddNic = document.getElementById('create-add-nic');

function renderCreateNicControls() { renderNicControls(createDraft, createNicList, createAddNic, () => {}); }

function openCreateDialog(kind) {
  createKind = kind;
  const host = kind === 'host';
  createTitle.textContent = host ? 'Add a new host' : 'Add a new switch';
  createName.value = nextMachineName(kind);
  createName.maxLength = host ? 64 : 32;
  if (host) createName.removeAttribute('pattern');
  else createName.pattern = '[a-zA-Z][a-zA-Z0-9_-]{0,31}';
  document.getElementById('create-system-row').hidden = !host;
  document.getElementById('create-engine-row').hidden = !host;
  imageSelect.required = host;
  const current = activeMachine();
  imageSelect.value = host && current?.kind === 'host' ? current.imageId : (store.images[0]?.id || '');
  engineSelect.value = generalSettings.engine;
  createDraft = host ? {engine: generalSettings.engine, interfaces: [null], hasLaunched: false, busy: false} : null;
  createNetwork.hidden = !host;
  if (host) renderCreateNicControls();
  createAutostart.checked = true;
  document.getElementById('create-autostart-row').hidden = false;
  createError.hidden = true;
  createError.textContent = '';
  createDialog.showModal();
  createName.focus();
  createName.select();
}
function openCloneDialog(source) {
  cloneSourceId = source.id;
  const isSwitch = source.kind === 'switch';
  cloneTitle.textContent = `Clone ${isSwitch ? 'switch' : 'host'} · ${source.hostname}`;
  cloneName.value = nextMachineName(source.kind);
  cloneName.maxLength = isSwitch ? 32 : 64;
  if (isSwitch) cloneName.pattern = '[a-zA-Z][a-zA-Z0-9_-]{0,31}';
  else cloneName.removeAttribute('pattern');
  cloneNetworkRow.hidden = isSwitch || !source.interfaces?.length;
  cloneNetwork.checked = !cloneNetworkRow.hidden;
  cloneAutostart.checked = true;
  cloneError.hidden = true;
  cloneError.textContent = '';
  cloneDialog.showModal();
  cloneName.focus();
  cloneName.select();
}

export function initNodeDialogs() {
  document.getElementById('new-host').addEventListener('click', openHostSettingsCreate);
  document.getElementById('new-switch').addEventListener('click', () => openCreateDialog('switch'));
  cloneButton.addEventListener('click', () => { const machine = activeMachine(); if (machine && !machine.busy) openCloneDialog(machine); });
  cancelClone.addEventListener('click', () => cloneDialog.close());
  cloneDialog.addEventListener('cancel', event => { if (confirmClone.disabled) event.preventDefault(); });
  cloneDialog.addEventListener('close', () => { cloneSourceId = null; updateControls(); });
  cloneForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!cloneForm.reportValidity()) return;
    confirmClone.disabled = true;
    cancelClone.disabled = true;
    cloneError.hidden = true;
    let startHost = false;
    try {
      const source = machines.get(cloneSourceId);
      if (!source) throw new Error('The source is no longer available.');
      const autostart = cloneAutostart.checked;
      if (source.kind === 'switch') {
        await addSwitch({name: cloneName.value.trim(), autostart});
      } else {
        const interfaces = cloneNetworkRow.hidden || !cloneNetwork.checked
          ? [null] : [...source.interfaces];
        const config = await requestJson(nodeUrl(source.id, 'config'), {cache: 'no-store'}, 'Cannot copy host configuration.');
        await addHost({name: cloneName.value.trim(), imageId: source.imageId, engine: generalSettings.engine,
          interfaces, settings: config.settings, guestMedia: config.guestMedia, startupDiskEnabled: config.startupDiskEnabled});
        startHost = autostart;
      }
      cloneDialog.close();
    } catch (error) {
      cloneError.textContent = error.message;
      cloneError.hidden = false;
    } finally {
      confirmClone.disabled = false;
      cancelClone.disabled = false;
    }
    if (startHost) await startActiveMachine();
  });
  document.getElementById('cancel-create').addEventListener('click', () => createDialog.close());
  createDialog.addEventListener('cancel', event => { if (confirmCreate.disabled) event.preventDefault(); });
  createDialog.addEventListener('close', () => updateControls());
  createForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!createForm.reportValidity()) return;
    const kind = createKind;
    const autostart = createAutostart.checked;
    confirmCreate.disabled = true;
    document.getElementById('cancel-create').disabled = true;
    createError.hidden = true;
    let startHost = false;
    try {
      if (kind === 'host') await addHost({name: createName.value.trim(), imageId: imageSelect.value, engine: generalSettings.engine, interfaces: [...createDraft.interfaces]});
      else await addSwitch({name: createName.value.trim(), autostart});
      createDialog.close();
      startHost = kind === 'host' && autostart;
    } catch (error) {
      createError.textContent = error.message;
      createError.hidden = false;
    } finally {
      confirmCreate.disabled = false;
      document.getElementById('cancel-create').disabled = false;
    }
    if (startHost) await startActiveMachine();
  });
  createAddNic.addEventListener('click', () => {
    if (!createDraft || createDraft.interfaces.length >= 4) return;
    createDraft.interfaces.push(null);
    renderCreateNicControls();
  });
}
