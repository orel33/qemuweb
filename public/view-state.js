// View state: what a page of the workspace shows, as one plain JSON object. It is published by
// the owner's page to observers (owner-view), by the controlling admin's page to the owner's
// pages (controller-view), and saved in the browser's view settings. Shared by the server
// (server/sockets.js validates the events) and the browser (classic script, global ViewState).
//   {mode: 'terminals' | 'graphic',
//    layout: 'single' | 'columns-2' | 'rows-2' | 'grid-4',
//    panes: (nodeId | null)[],   exactly paneCount(layout) entries, in pane order; null = empty
//    views: ('console' | 'console2' | 'monitor' | 'log' | 'capture')[],   parallel to panes: the view of each
//                                pane ('console' for an empty one)
//    switches: boolean,          switch consoles shown
//    active: nodeId | null}      the selected node
// The console page is not part of it: paging only decides which nodes are assigned to the
// panes, and the resulting panes are what is published.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ViewState = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const LAYOUT_PANES = Object.freeze({single: 1, 'columns-2': 2, 'rows-2': 2, 'grid-4': 4});
  const MODES = ['terminals', 'graphic'];
  const PANE_VIEWS = ['console', 'console2', 'monitor', 'log', 'capture'];
  const KEYS = ['mode', 'layout', 'panes', 'views', 'switches', 'active'];

  // Number of panes of a layout, 0 for an unknown one.
  function paneCount(layout) {
    return typeof layout === 'string' && Object.hasOwn(LAYOUT_PANES, layout) ? LAYOUT_PANES[layout] : 0;
  }

  // A valid view state from `raw`, or null. nodeIds (a Set, a Map or an array) lists the known
  // node IDs: any other ID becomes null, and a node shown in two panes is kept in the first one.
  // With nodeIds null, any string is accepted as a node ID (shape check only).
  function normalizeView(raw, nodeIds = null) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const {mode, layout, panes, views, switches, active} = raw;
    const count = paneCount(layout);
    if (!MODES.includes(mode) || !count || typeof switches !== 'boolean') return null;
    if (!Array.isArray(panes) || panes.length !== count || panes.some(id => id !== null && typeof id !== 'string')) return null;
    if (!Array.isArray(views) || views.length !== count || views.some(view => !PANE_VIEWS.includes(view))) return null;
    if (active !== null && typeof active !== 'string') return null;
    const known = id => {
      if (typeof id !== 'string' || !id) return null;
      if (nodeIds === null) return id;
      return (Array.isArray(nodeIds) ? nodeIds.includes(id) : nodeIds.has(id)) ? id : null;
    };
    const ids = panes.map(known).map((id, index, list) => (id && list.indexOf(id) === index ? id : null));
    return {mode, layout, panes: ids, views: views.map((view, index) => (ids[index] ? view : 'console')), switches, active: known(active)};
  }

  // Whether two view states are equal (both valid).
  function sameView(a, b) {
    if (!a || !b) return false;
    return KEYS.every(key => (key === 'panes' || key === 'views'
      ? a[key].length === b[key].length && a[key].every((item, index) => item === b[key][index])
      : a[key] === b[key]));
  }

  return {LAYOUT_PANES, paneCount, normalizeView, sameView};
});
