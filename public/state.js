// Shared client state. Values that several modules reassign live on `store`,
// because ES module bindings are read-only for importers.
import {observing} from './observe.js';
export const machines = new Map();

const viewSettingsKey = 'qemuweb.view-settings';
export const graphicLayoutKey = 'qemuweb.graphic-layout';
// View settings saved in this browser: {view: a view state (public/view-state.js), graphicZoom}.
// savedView is the last saved view state (node IDs unchecked), or null; anything unreadable
// gives the defaults.
let savedSettings = {};
try {
  const saved = JSON.parse(localStorage.getItem(viewSettingsKey) || '{}');
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) savedSettings = saved;
} catch (_) {}
export let savedView = ViewState.normalizeView(savedSettings.view, null);

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
  layout: savedView?.layout || 'single',
  // Number of console panes of the layout.
  get layoutSize() { return ViewState.paneCount(this.layout); },
  expandedPaneIndex: null,
  showSwitchConsoles: savedView ? savedView.switches : true,
  pageIndex: 0,
  selectionToken: 0,
  graphicVisible: false,
  graphicZoom: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(savedSettings.graphicZoom) ? savedSettings.graphicZoom : 1,
  startupTemplatePreview: [],
  autoCdromSupported: false,
  isoPreviewSupported: false
};

// Saves the view state (the last one when not given) and the graphic zoom. An observation tab
// never saves: the admin's own layout belongs to their own session's tabs.
export function saveViewSettings(view = savedView) {
  if (observing) return;
  savedView = view;
  try { localStorage.setItem(viewSettingsKey, JSON.stringify({view, graphicZoom: store.graphicZoom})); } catch (_) {}
}

export function saveGeneralSettings() {
  const {namingScheme, consoleFontFamily, consoleFontSize} = generalSettings;
  try { localStorage.setItem(generalSettingsKey, JSON.stringify({namingScheme, consoleFontFamily, consoleFontSize})); } catch (_) {}
}
