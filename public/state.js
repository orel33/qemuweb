// Shared client state. Values that several modules reassign live on `store`,
// because ES module bindings are read-only for importers.
import {observing} from './observe.js';
export const machines = new Map();

// The console layouts and their number of panes.
export const LAYOUT_PANES = Object.freeze({single: 1, 'columns-2': 2, 'rows-2': 2, 'grid-4': 4});

const viewSettingsKey = 'qemuweb.view-settings';
export const graphicLayoutKey = 'qemuweb.graphic-layout';
export let savedViewSettings = {};
try {
  const saved = JSON.parse(localStorage.getItem(viewSettingsKey) || '{}');
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) savedViewSettings = saved;
} catch (_) {}

const generalSettingsKey = 'qemuweb.general-settings';
export const generalSettings = {engine: 'qemu', namingScheme: 'classicLong', consoleFontFamily: 'system', consoleFontSize: 17};
try {
  const saved = JSON.parse(localStorage.getItem(generalSettingsKey) || '{}');
  if (typeof saved?.namingScheme === 'string') generalSettings.namingScheme = saved.namingScheme;
  if (['system', 'consolas', 'menlo', 'liberation', 'default'].includes(saved?.consoleFontFamily)) generalSettings.consoleFontFamily = saved.consoleFontFamily;
  if ([...document.getElementById('console-font-size').options].some(option => Number(option.value) === Number(saved?.consoleFontSize))) generalSettings.consoleFontSize = Number(saved.consoleFontSize);
} catch (_) {}

export const store = {
  images: [],
  namingSchemes: null,
  activeId: null,
  activePaneIndex: 0,
  exitAllBusy: false,
  // Console layout: 'single', 'columns-2' (side by side), 'rows-2' (stacked) or 'grid-4'.
  // An unknown saved value falls back to 'single'.
  layout: Object.hasOwn(LAYOUT_PANES, savedViewSettings.layout) ? savedViewSettings.layout : 'single',
  // Number of console panes of the layout.
  get layoutSize() { return LAYOUT_PANES[this.layout]; },
  expandedPaneIndex: null,
  showSwitchConsoles: typeof savedViewSettings.showSwitchConsoles === 'boolean' ? savedViewSettings.showSwitchConsoles : true,
  pageIndex: 0,
  selectionToken: 0,
  graphicVisible: false,
  graphicZoom: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(savedViewSettings.graphicZoom) ? savedViewSettings.graphicZoom : 1,
  startupTemplatePreview: [],
  autoCdromSupported: false,
  isoPreviewSupported: false
};

// An observation tab never saves its view: the admin's own layout belongs to their own session's
// tabs, and following the owner changes the view many times.
export function saveViewSettings() {
  if (observing) return;
  try {
    localStorage.setItem(viewSettingsKey, JSON.stringify({view: store.graphicVisible ? 'graphic' : 'terminals', layout: store.layout, showSwitchConsoles: store.showSwitchConsoles, graphicZoom: store.graphicZoom}));
  } catch (_) {}
}

export function saveGeneralSettings() {
  const {namingScheme, consoleFontFamily, consoleFontSize} = generalSettings;
  try { localStorage.setItem(generalSettingsKey, JSON.stringify({namingScheme, consoleFontFamily, consoleFontSize})); } catch (_) {}
}
