// Host Settings dialog, also used to add a new host.
import {generalSettings, machines, store} from './state.js';
import {jsonRequest, launchOptionsUrl, nodeUrl, requestJson} from './api.js';
import {activeMachine, renderTabs, selectMachine, showStatusError, updateControls} from './workspace.js';
import {addHost, chooseRestartTiming, nextMachineName, scheduleSessionSync, startActiveMachine} from './nodes.js';
import {engineSelect} from './node-dialogs.js';
import {clearStartupTemplateError, defaultStartScript, renderGuestMedia, renderStartupTemplateValues, showStartupTemplateError, validateStartScriptDraft} from './startup-media.js';
import {renderGraphic} from './graphic-view.js';
import {renderConsoleSettings} from './host-console-settings.js';

let optionsRequest = 0;
let hostSettingsDraft = null;

const networkControls = document.getElementById('network-controls');
const nicList = document.getElementById('nic-list');
const addNic = document.getElementById('add-nic');

export const qemuOptionsPanel = document.getElementById('qemu-options-panel');
const settingsTitle = document.getElementById('settings-title');
const hostSettingsForm = document.getElementById('host-settings-form');

const hostCreateActions = document.getElementById('host-create-actions');
const hostAutostart = document.getElementById('host-autostart');
const confirmHostCreate = document.getElementById('confirm-host-create');
const cancelHostCreate = document.getElementById('cancel-host-create');
const settingsTabs = [...qemuOptionsPanel.querySelectorAll('[data-settings-tab]')];
const settingsPanels = [...qemuOptionsPanel.querySelectorAll('[data-settings-panel]')];

export const optionsStatus = document.getElementById('options-status');
const settingsEditable = document.getElementById('settings-editable');
const settingsFixed = document.getElementById('settings-fixed');
const settingsHardware = document.getElementById('settings-hardware');
const settingsStorage = document.getElementById('settings-storage');

const settingsStartupProfile = document.getElementById('settings-startup-profile');
const settingsStartupIso = document.getElementById('settings-startup-iso');
const settingsExtraOptions = document.getElementById('settings-extra-options');

const settingsNetworkProfile = document.getElementById('settings-network-profile');
const settingsConsole = document.getElementById('settings-console');
const optionsCommands = document.getElementById('options-commands');

export function settingsMachine() { return qemuOptionsPanel.open && hostSettingsDraft ? hostSettingsDraft : activeMachine(); }
function machineDialogName(machine) {
  const system = store.images.find(item => item.id === machine.imageId);
  return `${machine.hostname}. ${system?.label || machine.osHint}`;
}

function defaultSettings(machine) {
  const profile = store.images.find(item => item.id === machine.imageId);
  return profile ? {memory: profile.memory, cpus: profile.cpus, clock: profile.clock, serialPorts: profile.serialPorts} : {};
}
function getMachineSettings(machine) {
  if (!machine.settingsLoaded) {
    machine.settings = {...defaultSettings(machine), ...(machine.settings || {})};
    machine.settingsLoaded = true;
  }
  return {...machine.settings};
}
function saveMachineSettings(machine, settings) {
  machine.settings = {...settings};
  machine.settingsLoaded = true;
}
export function addSettingRow(container, label, value, disabled = true) {
  const row = document.createElement('div');
  row.className = 'setting-row';
  const title = document.createElement('label');
  const id = `fixed-${container.id}-${container.childElementCount}`;
  title.htmlFor = id;
  title.textContent = label;
  const input = document.createElement('input');
  input.id = id;
  input.type = 'text';
  input.value = value == null ? '' : String(value);
  input.disabled = disabled;
  input.title = input.value;
  row.append(title, input);
  container.append(row);
  return input;
}
export function addSettingTextRow(container, label, value) {
  const row = document.createElement('div');
  row.className = 'setting-row';
  const title = document.createElement('span');
  title.className = 'setting-label';
  title.textContent = label;
  const content = document.createElement('div');
  content.className = 'setting-value';
  content.textContent = value;
  row.append(title, content);
  container.append(row);
}
export function addSettingSelectRow(container, label, choices, value, disabled, onChange) {
  const row = document.createElement('div');
  row.className = 'setting-row';
  const title = document.createElement('label');
  const id = `select-${container.id}-${container.childElementCount}`;
  title.htmlFor = id;
  title.textContent = label;
  const select = document.createElement('select');
  select.id = id;
  select.disabled = disabled;
  for (const [optionValue, optionLabel] of choices) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = optionLabel;
    select.append(option);
  }
  select.value = value;
  if (onChange) select.onchange = () => onChange(select.value);
  row.append(title, select);
  container.append(row);
}
function updateNicMetadata(interfaces = []) {
  for (const [index, item] of interfaces.entries()) {
    const meta = nicList.children[index]?.querySelector('.nic-meta');
    if (meta) {
      const port = item.port ?? / · port (\d+)$/.exec(item.switch || '')?.[1];
      meta.textContent = `${port == null ? '' : `port ${port} · `}${item.mac}`;
      meta.title = meta.textContent;
    }
  }
}
function keepFocusedNicVisible(select = document.activeElement) {
  if (!select || !nicList.contains(select)) return;
  select.scrollIntoView({block: 'nearest'});
  const visibleBottom = hostCreateActions.hidden
    ? qemuOptionsPanel.getBoundingClientRect().bottom - 12
    : hostCreateActions.getBoundingClientRect().top - 12;
  const hiddenPixels = select.getBoundingClientRect().bottom - visibleBottom;
  if (hiddenPixels > 0) qemuOptionsPanel.scrollTop += hiddenPixels;
}
function renderStorageSettings(storage, diskInterface) {
  settingsStorage.replaceChildren();
  settingsStartupIso.replaceChildren();
  if (diskInterface) addSettingRow(settingsStorage, 'Disk interface', diskInterface);
  for (const disk of storage || []) {
    addSettingRow(disk.label === 'Startup disk (cd-rom)' ? settingsStartupIso : settingsStorage, disk.label, disk.path);
  }
}
function showIsoPreviewStatus(machine) {
  const needsRestart = machine.startupDiskEnabled && store.autoCdromSupported && !store.isoPreviewSupported;
  optionsStatus.textContent = needsRestart ? 'Restart the QemuWeb server to show the planned ISO path and creation command.' : '';
  optionsStatus.hidden = !needsRestart;
}
export async function renderQemuOptions() {
  const machine = settingsMachine();
  if (!machine || machine.kind === 'switch' || !qemuOptionsPanel.open) return;
  const creating = !!machine.isNew;
  const request = ++optionsRequest;
  optionsStatus.hidden = true;
  optionsStatus.textContent = '';
  clearStartupTemplateError();
  const image = store.images.find(item => item.id === machine.imageId);
  settingsTitle.textContent = creating ? 'Add a new host' : `Host Settings · ${machineDialogName(machine)}`;
  settingsEditable.replaceChildren();
  settingsFixed.replaceChildren();
  settingsHardware.replaceChildren();
  settingsStorage.replaceChildren();
  settingsStartupProfile.replaceChildren();
  settingsStartupIso.replaceChildren();
  settingsNetworkProfile.replaceChildren();
  settingsConsole.replaceChildren();
  settingsExtraOptions.textContent = '';
  optionsCommands.textContent = '';
  networkControls.hidden = false;
  renderNicControls(machine);
  try {
    const body = await requestJson(launchOptionsUrl(machine, getMachineSettings(machine)), undefined, 'Settings unavailable');
    if (request !== optionsRequest || machine !== settingsMachine()) return;
    updateNicMetadata(body.interfaces);
    store.startupTemplatePreview = body.interfaces;
    renderStartupTemplateValues(machine);
    const locked = !!machine.busy;
    const identityLocked = !!(machine.hasLaunched || locked);
    const settings = getMachineSettings(machine);
    const hostName = addSettingRow(settingsFixed, 'Host name', machine.hostname, false);
    hostName.maxLength = 64;
    hostName.required = true;
    hostName.oninput = () => {
      const name = hostName.value.trim();
      machine.hostname = name;
      renderStartupTemplateValues(machine);
    };
    for (const [key, field] of Object.entries(body.fields || {})) {
      if (key === 'serialPorts') continue;
      const row = document.createElement('div');
      row.className = 'setting-row';
      const label = document.createElement('label');
      label.htmlFor = `setting-${key}`;
      label.textContent = field.unit ? `${field.label || key} (${field.unit})` : (field.label || key);
      let input;
      if (field.type === 'select') {
        input = document.createElement('select');
        for (const value of field.options || []) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = value;
          input.append(option);
        }
      } else {
        input = document.createElement('input');
        input.type = field.type || 'text';
        if (field.min !== undefined) input.min = field.min;
        if (field.max !== undefined) input.max = field.max;
        if (field.step !== undefined) input.step = field.step;
      }
      input.id = `setting-${key}`;
      input.value = settings[key];
      input.disabled = locked;
      if (field.type === 'number') input.required = true;
      input.onchange = () => {
        if (field.type === 'number' && !input.reportValidity()) {
          input.value = getMachineSettings(machine)[key];
          return;
        }
        const next = getMachineSettings(machine);
        next[key] = field.type === 'number' ? Number(input.value) : input.value;
        saveMachineSettings(machine, next);
        refreshLaunchPreview(machine);
      };
      row.append(label, input);
      settingsEditable.append(row);
    }
    addSettingSelectRow(settingsFixed, 'System', store.images.map(image => [image.id, image.label]), machine.imageId, !creating || identityLocked, value => {
      if (creating) {
        machine.imageId = value;
        machine.settings = null;
        machine.settingsLoaded = false;
        const selectedImage = store.images.find(item => item.id === value);
        machine.osHint = selectedImage?.label || 'System';
        machine.hasDifferentialDisk = !!selectedImage?.hasDifferentialDisk;
        renderQemuOptions();
      }
    });
    addSettingTextRow(settingsFixed, 'System ID', machine.imageId);
    addSettingSelectRow(settingsFixed, 'Engine', [...engineSelect.options].map(option => [option.value, option.textContent]), machine.engine, true);
    addSettingTextRow(settingsFixed, 'Base image', image?.images?.[machine.engine === 'vbox' ? 'vdi' : 'raw'] || 'Unavailable');
    const hardwareLabels = [
      ['type', 'Type'], ['arch', 'Architecture'], ['mode', 'Mode'],
      ['firmware', 'Firmware'], ['acceleration', 'Acceleration'], ['boot', 'Boot']
    ];
    for (const [key, label] of hardwareLabels) addSettingRow(settingsHardware, label, body.fixed?.[key]);
    addSettingRow(settingsNetworkProfile, 'Network model', body.fixed?.networkModel);
    addSettingRow(settingsStartupProfile, 'CD-ROM interface', body.fixed?.cdromInterface);
    settingsExtraOptions.textContent = body.fixed?.extraOptions?.length ? body.fixed.extraOptions.join(' ') : 'None';
    renderStorageSettings(body.storage, body.fixed?.diskInterface);
    renderConsoleSettings(settingsConsole, {body});
    optionsCommands.textContent = body.commands.map(command => `$ ${command}`).join('\n\n');
    showIsoPreviewStatus(machine);
  } catch (error) {
    if (request === optionsRequest) {
      optionsStatus.textContent = error.message;
      optionsStatus.hidden = false;
    }
  }
}
export async function refreshLaunchPreview(machine) {
  const request = ++optionsRequest;
  try {
    const body = await requestJson(launchOptionsUrl(machine, getMachineSettings(machine)), undefined, 'Settings unavailable');
    if (request !== optionsRequest || machine !== settingsMachine() || !qemuOptionsPanel.open) return;
    updateNicMetadata(body.interfaces);
    store.startupTemplatePreview = body.interfaces;
    renderStartupTemplateValues(machine);
    renderStorageSettings(body.storage, body.fixed?.diskInterface);
    keepFocusedNicVisible();
    optionsCommands.textContent = body.commands.map(command => `$ ${command}`).join('\n\n');
    showIsoPreviewStatus(machine);
  } catch (error) {
    if (request !== optionsRequest) return;
    optionsStatus.textContent = error.message;
    optionsStatus.hidden = false;
  }
}

export function renderNicControls(machine, list = nicList, addButton = addNic, onChange = () => { clearStartupTemplateError(); refreshLaunchPreview(machine); }) {
  list.replaceChildren();
  const locked = machine.busy;
  addButton.disabled = locked || (machine.interfaces || []).length >= 4;
  for (const [index, selected] of (machine.interfaces || []).entries()) {
    const row = document.createElement('div'); row.className = 'nic-row';
    const label = document.createElement('span'); label.textContent = `Ethernet ${index}`;
    const select = document.createElement('select'); select.setAttribute('aria-label', `Ethernet interface ${index} switch`); select.disabled = locked;
    const disconnected = document.createElement('option'); disconnected.value = ''; disconnected.textContent = 'Disconnected'; select.append(disconnected);
    for (const sw of machines.values()) if (sw.kind === 'switch') {
      const option = document.createElement('option'); option.value = sw.id; option.textContent = `${sw.hostname}${sw.running ? '' : ' (stopped)'}`; select.append(option);
    }
    select.value = selected || '';
    select.onchange = () => { machine.interfaces[index] = select.value || null; meta.textContent = ''; renderGraphic(); onChange(); };
    const meta = document.createElement('span'); meta.className = 'nic-meta';
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = `Remove Ethernet interface ${index}`; remove.disabled = locked;
    remove.onclick = () => {
      const scrollTop = qemuOptionsPanel.scrollTop;
      machine.interfaces.splice(index, 1);
      renderGraphic();
      renderNicControls(machine, list, addButton, onChange);
      qemuOptionsPanel.scrollTop = scrollTop;
      (list.children[index]?.querySelector('select') || list.lastElementChild?.querySelector('select') || addButton).focus({preventScroll: true});
      onChange();
    };
    row.append(label, select, meta, remove); list.append(row);
  }
}

export async function openHostSettingsCreate() {
  const current = activeMachine();
  const imageId = current?.kind === 'host' ? current.imageId : store.images[0]?.id;
  const image = store.images.find(item => item.id === imageId);
  const hostname = nextMachineName('host');
  const interfaces = [null];
  hostSettingsDraft = {
    id: `h-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
    isNew: true, kind: 'host', hostname, imageId,
    osHint: image?.label || 'System', hasDifferentialDisk: !!image?.hasDifferentialDisk,
    engine: generalSettings.engine, interfaces,
    settings: null, settingsLoaded: false, running: false, hasLaunched: false, busy: false,
    guestMedia: {script: defaultStartScript(interfaces), resources: []}, startupDiskEnabled: !!image?.startupDiskEnabled
  };
  hostAutostart.checked = true;
  hostCreateActions.hidden = false;
  hostAutostart.closest('label').hidden = false;
  settingsTitle.textContent = 'Add a new host';
  qemuOptionsPanel.showModal();
  selectSettingsTab('general');
  renderGuestMedia();
  qemuOptionsPanel.scrollTop = 0;
  await renderQemuOptions();
  if (hostSettingsDraft) settingsFixed.querySelector('input')?.focus();
}

export async function openHostSettings() {
  const source = activeMachine();
  if (source?.kind !== 'host') return;
  try {
    const data = await requestJson(nodeUrl(source.id, 'config'), {cache: 'no-store'}, 'Cannot load host configuration.');
    if (!machines.has(source.id) || store.activeId !== source.id) return;
    hostSettingsDraft = {
      id: source.id, isNew: false, kind: 'host', hostname: data.name,
      imageId: data.systemId, osHint: source.osHint, hasDifferentialDisk: source.hasDifferentialDisk,
      engine: data.engine, interfaces: [...data.interfaces], networkInterfaces: data.networkInterfaces,
      settings: {...data.settings}, settingsLoaded: true,
      guestMedia: structuredClone(data.guestMedia), startupDiskEnabled: data.startupDiskEnabled,
      running: data.running, hasLaunched: data.hasLaunched, pendingRestart: data.pendingRestart, busy: source.busy,
      initialRestartConfig: JSON.stringify({settings: data.settings, interfaces: data.interfaces,
        guestMedia: data.guestMedia, startupDiskEnabled: data.startupDiskEnabled})
    };
    hostCreateActions.hidden = false;
    hostAutostart.closest('label').hidden = true;
    qemuOptionsPanel.showModal();
    selectSettingsTab('general');
    renderGuestMedia();
    await renderQemuOptions();
  } catch (error) { showStatusError(error.message); }
}
function selectSettingsTab(name, focus = false) {
  const selected = settingsTabs.find(tab => tab.dataset.settingsTab === name && !tab.hidden);
  if (!selected) return;
  for (const tab of settingsTabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of settingsPanels) panel.hidden = panel.dataset.settingsPanel !== name;
  if (focus) selected.focus();
}

export function initHostSettings() {
  addNic.addEventListener('click', () => {
    const machine = settingsMachine();
    if (!machine || machine.kind !== 'host' || machine.busy || machine.interfaces.length >= 4) return;
    const scrollTop = qemuOptionsPanel.scrollTop;
    machine.interfaces.push(null);
    clearStartupTemplateError();
    renderGraphic();
    renderNicControls(machine);
    qemuOptionsPanel.scrollTop = scrollTop;
    const select = nicList.lastElementChild?.querySelector('select');
    select?.focus({preventScroll: true});
    keepFocusedNicVisible(select);
    refreshLaunchPreview(machine);
  });
  for (const tab of settingsTabs) {
    tab.addEventListener('click', () => selectSettingsTab(tab.dataset.settingsTab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const visible = settingsTabs.filter(item => !item.hidden);
      const index = visible.indexOf(tab);
      const next = event.key === 'Home' ? visible[0]
        : event.key === 'End' ? visible[visible.length - 1]
        : visible[(index + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length];
      event.preventDefault();
      selectSettingsTab(next.dataset.settingsTab, true);
    });
  }
  cancelHostCreate.addEventListener('click', () => qemuOptionsPanel.close());
  qemuOptionsPanel.addEventListener('cancel', event => { if (confirmHostCreate.disabled) event.preventDefault(); });
  qemuOptionsPanel.addEventListener('close', () => {
    if (qemuOptionsPanel.open) return;
    hostSettingsDraft = null;
    hostCreateActions.hidden = true;
    updateControls();
  });
  hostSettingsForm.addEventListener('submit', async event => {
    event.preventDefault();
    const draft = hostSettingsDraft;
    if (!draft) return;
    const invalid = hostSettingsForm.querySelector('input:invalid, select:invalid, textarea:invalid');
    if (invalid) {
      const panel = invalid.closest('[data-settings-panel]');
      if (panel) selectSettingsTab(panel.dataset.settingsPanel);
      invalid.focus();
      invalid.reportValidity();
      return;
    }
    const name = settingsFixed.querySelector('input')?.value.trim();
    if (!name) return;
    try { validateStartScriptDraft(draft); }
    catch (error) {
      selectSettingsTab('startup');
      showStartupTemplateError(error.message);
      return;
    }
    const autostart = draft.isNew && hostAutostart.checked;
    let restartNow = false;
    const payload = draft.isNew ? null : {name, systemId: draft.imageId, engine: draft.engine, settings: getMachineSettings(draft),
      interfaces: [...draft.interfaces], guestMedia: draft.guestMedia,
      startupDiskEnabled: draft.startupDiskEnabled};
    const restartConfigChanged = payload && JSON.stringify({settings: payload.settings, interfaces: payload.interfaces,
      guestMedia: payload.guestMedia, startupDiskEnabled: payload.startupDiskEnabled}) !== draft.initialRestartConfig;
    if (draft.running && restartConfigChanged) {
      const choice = await chooseRestartTiming();
      if (choice === 'cancel' || hostSettingsDraft !== draft || !qemuOptionsPanel.open) return;
      restartNow = choice === 'now';
    }
    confirmHostCreate.disabled = true;
    cancelHostCreate.disabled = true;
    optionsStatus.hidden = true;
    let dialogClosed = false;
    try {
      if (draft.isNew) {
        const machine = await addHost({id: draft.id, name, imageId: draft.imageId, engine: draft.engine,
          interfaces: [...draft.interfaces], settings: getMachineSettings(draft), guestMedia: draft.guestMedia,
          startupDiskEnabled: draft.startupDiskEnabled, select: false});
        hostSettingsDraft = null;
        qemuOptionsPanel.close();
        dialogClosed = true;
        selectMachine(machine.id);
        if (autostart) await startActiveMachine();
      } else {
        const data = await requestJson(nodeUrl(draft.id, 'config'), jsonRequest('PUT', payload), 'Cannot save host configuration.');
        const machine = machines.get(draft.id);
        if (machine) {
          machine.hostname = data.name;
          machine.settings = data.settings;
          machine.settingsLoaded = true;
          machine.interfaces = data.interfaces;
          machine.networkInterfaces = data.networkInterfaces;
          machine.guestMedia = data.guestMedia;
          machine.startupDiskEnabled = data.startupDiskEnabled;
          machine.pendingRestart = data.pendingRestart;
        }
        draft.pendingRestart = data.pendingRestart;
        hostSettingsDraft = null;
        qemuOptionsPanel.close();
        dialogClosed = true;
        renderTabs();
        renderGraphic();
        if (restartNow) {
          const endpoint = `${nodeUrl(draft.id)}/${data.running ? 'reboot' : 'start'}`;
          const body = data.running ? undefined : JSON.stringify({engine: draft.engine, imageId: draft.imageId});
          const restartResponse = await fetch(endpoint, {method: 'POST',
            ...(body ? {headers: {'Content-Type': 'application/json'}, body} : {})});
          const restartResult = await restartResponse.json();
          if (!restartResponse.ok) throw new Error(`Settings saved, but restart failed: ${restartResult.error || 'unknown error'}`);
          if (machine) machine.pendingRestart = false;
          draft.pendingRestart = false;
          scheduleSessionSync();
        }
      }
    } catch (error) {
      if (dialogClosed) showStatusError(error.message);
      else {
        if (/^Error: (?:unresolved|malformed) variables in start\.sh/.test(error.message)) {
          selectSettingsTab('startup');
          showStartupTemplateError(error.message);
        } else {
          optionsStatus.textContent = error.message;
          optionsStatus.hidden = false;
        }
      }
      if (!draft.isNew) { renderTabs(); scheduleSessionSync(); }
    } finally {
      confirmHostCreate.disabled = false;
      cancelHostCreate.disabled = false;
    }
  });
}
