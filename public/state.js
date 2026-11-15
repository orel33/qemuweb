// Shared client state. Values that several modules reassign live on `store`,
// because ES module bindings are read-only for importers.
export const machines = new Map();

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
  layoutSize: [1, 2, 4].includes(savedViewSettings.layoutSize) ? savedViewSettings.layoutSize : 1,
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

export function saveViewSettings() {
  try {
    localStorage.setItem(viewSettingsKey, JSON.stringify({view: store.graphicVisible ? 'graphic' : 'terminals', layoutSize: store.layoutSize, showSwitchConsoles: store.showSwitchConsoles, graphicZoom: store.graphicZoom}));
  } catch (_) {}
}

export function saveGeneralSettings() {
  const {namingScheme, consoleFontFamily, consoleFontSize} = generalSettings;
  try { localStorage.setItem(generalSettingsKey, JSON.stringify({namingScheme, consoleFontFamily, consoleFontSize})); } catch (_) {}
}
