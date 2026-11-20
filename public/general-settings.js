// General Settings dialog: session engine, naming scheme and console font.
import {generalSettings, saveGeneralSettings, store} from './state.js';
import {jsonRequest, requestJson} from './api.js';
import {refreshSystems} from './systems.js';
import {showEngineBadge} from './engine-badge.js';
import {applyConsoleAppearance, fitTerminals, panes} from './terminal.js';

let consoleAppearanceChangedWhileOpen = false;

export const showGeneralSettings = document.getElementById('show-general-settings');
const generalSettingsPanel = document.getElementById('general-settings-panel');
export const defaultEngineSelect = document.getElementById('default-engine');
export const namingSchemeSelect = document.getElementById('naming-scheme');
const consoleFontFamilySelect = document.getElementById('console-font-family');
const consoleFontSizeSelect = document.getElementById('console-font-size');
export const generalSettingsError = document.getElementById('general-settings-error');
const engineSettingsError = document.getElementById('engine-settings-error');

export function initGeneralSettings() {
  consoleFontFamilySelect.value = generalSettings.consoleFontFamily;
  consoleFontSizeSelect.value = String(generalSettings.consoleFontSize);
  applyConsoleAppearance();
  showGeneralSettings.addEventListener('click', () => { consoleAppearanceChangedWhileOpen = false; generalSettingsPanel.showModal(); });
  document.getElementById('close-general-settings').addEventListener('click', () => generalSettingsPanel.close());
  generalSettingsPanel.addEventListener('close', () => {
    if (!consoleAppearanceChangedWhileOpen) return;
    requestAnimationFrame(() => {
      fitTerminals();
      const pane = panes[store.activePaneIndex];
      if (pane.machineId && !pane.element.hidden) pane.terminal.focus();
    });
  });
  defaultEngineSelect.addEventListener('change', async () => {
    const engine = defaultEngineSelect.value;
    defaultEngineSelect.disabled = true;
    engineSettingsError.hidden = true;
    try {
      const body = await requestJson('/api/general-settings', jsonRequest('PUT', {engine}), 'Cannot change session engine');
      generalSettings.engine = body.engine;
      showEngineBadge(generalSettings.engine);
      await refreshSystems();
    } catch (error) {
      defaultEngineSelect.value = generalSettings.engine;
      engineSettingsError.textContent = error.message;
      engineSettingsError.hidden = false;
    } finally { defaultEngineSelect.disabled = false; }
  });
  namingSchemeSelect.addEventListener('change', () => { generalSettings.namingScheme = namingSchemeSelect.value; saveGeneralSettings(); });
  consoleFontFamilySelect.addEventListener('change', () => { generalSettings.consoleFontFamily = consoleFontFamilySelect.value; consoleAppearanceChangedWhileOpen = true; saveGeneralSettings(); applyConsoleAppearance(); });
  consoleFontSizeSelect.addEventListener('change', () => { generalSettings.consoleFontSize = Number(consoleFontSizeSelect.value); consoleAppearanceChangedWhileOpen = true; saveGeneralSettings(); applyConsoleAppearance(true); });
}
