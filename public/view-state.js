// View state: what a page of the workspace shows, as one plain JSON object. It is published by
// the owner's page to observers (owner-view), by the controlling admin's page to the owner's
// pages (controller-view), and saved in the browser's view settings. Shared by the server
// (server/sockets.js validates the events) and the browser (classic script, global ViewState).
//   {mode: 'terminals' | 'graphic',
//    layout: 'single' | 'columns-2' | 'rows-2' | 'grid-4',
//    panes: (nodeId | null)[],   exactly paneCount(layout) entries, in pane order; null = empty
//    views: ('console' | 'console2' | 'monitor' | 'log')[],   parallel to panes: the view of each
//                                pane ('console' for an empty one)
//    switches: boolean,          switch consoles shown
//    active: nodeId | null,      the selected node
//    floating: boolean,          the floating console of the Graphic view is open on the
//                                active node whenever the Graphic view shows (kept true in the
//                                Terminals view, so that coming back reopens it); normalized to
//                                false when the active node is not in a pane
//    geometry: {left, top, width, height} | null,   the floating console's window, as fractions
//                                of the Graphic view's width and height (browsers differ in
//                                size), left/top in [0, 1], width/height in [0.05, 1]; null
//                                before it was first placed (default geometry). Each page turns
//                                it into pixels and keeps the window inside its viewport.
//    viewport: {cx, cy, k} | null}  the pan and zoom of the Graphic view: the world point at the
//                                center of the canvas and the zoom factor (node positions are
//                                world coordinates, so browsers of other sizes center the same
//                                point at the same zoom); |cx|, |cy| <= 100000 rounded to 0.1, k
//                                clamped to [0.2, 3] and rounded to 1e-4; null before the Graphic
//                                view was first shown (each page then fits the drawing itself).
// The console page is not part of it: paging only decides which nodes are assigned to the
// panes, and the resulting panes are what is published.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ViewState = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const LAYOUT_PANES = Object.freeze({single: 1, 'columns-2': 2, 'rows-2': 2, 'grid-4': 4});
  const MODES = ['terminals', 'graphic'];
  const PANE_VIEWS = ['console', 'console2', 'monitor', 'log'];
  const KEYS = ['mode', 'layout', 'panes', 'views', 'switches', 'active', 'floating', 'geometry', 'viewport'];
  const GEOMETRY_KEYS = ['left', 'top', 'width', 'height'];
  const VIEWPORT_KEYS = ['cx', 'cy', 'k'];
  // Bounds of the Graphic view's viewport (public/graphic-view.js has the same zoom range).
  const MAX_CENTER = 100000;
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 3;
  // Smallest width or height of the floating window, as a fraction of the Graphic view.
  const MIN_FRACTION = 0.05;
  // Most administrators listed by session-observers, and the longest login.
  const MAX_OBSERVERS = 32;
  const MAX_LOGIN = 64;

  // Number of panes of a layout, 0 for an unknown one.
  function paneCount(layout) {
    return typeof layout === 'string' && Object.hasOwn(LAYOUT_PANES, layout) ? LAYOUT_PANES[layout] : 0;
  }

  // The floating console's geometry from `raw` (see the header): null stays null, finite numbers
  // are clamped to their range and rounded to 1e-4; anything else (another field, a missing
  // one, a non-number) is undefined, which makes the view invalid.
  function normalizeGeometry(raw) {
    if (raw === null) return null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const keys = Object.keys(raw);
    if (keys.length !== GEOMETRY_KEYS.length || !GEOMETRY_KEYS.every(key => keys.includes(key))) return undefined;
    if (!GEOMETRY_KEYS.every(key => typeof raw[key] === 'number' && Number.isFinite(raw[key]))) return undefined;
    const clamp = (value, min) => Math.round(Math.max(min, Math.min(1, value)) * 10000) / 10000;
    return {left: clamp(raw.left, 0), top: clamp(raw.top, 0), width: clamp(raw.width, MIN_FRACTION), height: clamp(raw.height, MIN_FRACTION)};
  }

  // The Graphic view's viewport from `raw` (see the header): null stays null, the center rounded
  // to 0.1 and the zoom clamped and rounded; a center out of bounds, another field, a missing
  // one or a non-number is undefined, which makes the view invalid.
  function normalizeViewport(raw) {
    if (raw === null) return null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const keys = Object.keys(raw);
    if (keys.length !== VIEWPORT_KEYS.length || !VIEWPORT_KEYS.every(key => keys.includes(key))) return undefined;
    if (!VIEWPORT_KEYS.every(key => typeof raw[key] === 'number' && Number.isFinite(raw[key]))) return undefined;
    if (Math.abs(raw.cx) > MAX_CENTER || Math.abs(raw.cy) > MAX_CENTER || !(raw.k > 0)) return undefined;
    const round = (value, step) => Math.round(value * step) / step || 0;
    return {cx: round(raw.cx, 10), cy: round(raw.cy, 10), k: round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, raw.k)), 10000)};
  }

  // Where the floating window goes in pixels, from a normalized geometry, the Graphic view's
  // rectangle {left, top, width, height} and the viewport {width, height}: at least min
  // {width, height} pixels, at most the viewport (less margin), and kept inside the viewport.
  function geometryPixels(geometry, area, viewport, {min = {width: 300, height: 200}, margin = 8} = {}) {
    const fit = (size, low, high) => Math.round(Math.max(Math.min(low, high), Math.min(size, high)));
    const width = fit(geometry.width * area.width, min.width, viewport.width - margin);
    const height = fit(geometry.height * area.height, min.height, viewport.height - margin);
    const place = (start, size, high) => Math.round(Math.max(0, Math.min(start, high - size)));
    return {width, height, left: place(area.left + geometry.left * area.width, width, viewport.width),
      top: place(area.top + geometry.top * area.height, height, viewport.height)};
  }

  // The geometry of a window at pixels {left, top, width, height}, relative to the Graphic
  // view's rectangle (normalized; null when the Graphic view has no size, e.g. hidden).
  function geometryFraction(pixels, area) {
    if (!area || !(area.width > 0) || !(area.height > 0)) return null;
    return normalizeGeometry({left: (pixels.left - area.left) / area.width, top: (pixels.top - area.top) / area.height,
      width: pixels.width / area.width, height: pixels.height / area.height}) || null;
  }

  // A valid view state from `raw`, or null. nodeIds (a Set, a Map or an array) lists the known
  // node IDs: any other ID becomes null, and a node shown in two panes is kept in the first one.
  // With nodeIds null, any string is accepted as a node ID (shape check only).
  function normalizeView(raw, nodeIds = null) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const {mode, layout, panes, views, switches, active, floating} = raw;
    const geometry = normalizeGeometry(raw.geometry);
    const viewport = normalizeViewport(raw.viewport);
    if (geometry === undefined || viewport === undefined) return null;
    const count = paneCount(layout);
    if (!MODES.includes(mode) || !count || typeof switches !== 'boolean' || typeof floating !== 'boolean') return null;
    if (!Array.isArray(panes) || panes.length !== count || panes.some(id => id !== null && typeof id !== 'string')) return null;
    if (!Array.isArray(views) || views.length !== count || views.some(view => !PANE_VIEWS.includes(view))) return null;
    if (active !== null && typeof active !== 'string') return null;
    const known = id => {
      if (typeof id !== 'string' || !id) return null;
      if (nodeIds === null) return id;
      return (Array.isArray(nodeIds) ? nodeIds.includes(id) : nodeIds.has(id)) ? id : null;
    };
    const ids = panes.map(known).map((id, index, list) => (id && list.indexOf(id) === index ? id : null));
    const activeId = known(active);
    return {mode, layout, panes: ids, views: views.map((view, index) => (ids[index] ? view : 'console')), switches, active: activeId,
      floating: floating && !!activeId && ids.includes(activeId), geometry, viewport};
  }

  // Whether two view states are equal (both valid).
  function sameView(a, b) {
    if (!a || !b) return false;
    const sameFields = fields => (x, y) => (x === null || y === null ? x === y : fields.every(key => x[key] === y[key]));
    const compare = {geometry: sameFields(GEOMETRY_KEYS), viewport: sameFields(VIEWPORT_KEYS)};
    return KEYS.every(key => (key === 'panes' || key === 'views'
      ? a[key].length === b[key].length && a[key].every((item, index) => item === b[key][index])
      : compare[key] ? compare[key](a[key], b[key]) : a[key] === b[key]));
  }

  // Which received view a page follows (kind 'owner' on an observer's page, 'controller' on the
  // owner's page), from its state: {observing, holding (this admin holds control), taking (a
  // take-control request is pending), followChecked (the Follow box), controlled (an admin
  // controls the session)}. One driver at a time: the owner's view is followed by an observer
  // with Follow on that neither holds nor is taking control; the controller's view by the
  // owner's page while its session is controlled.
  function followsView(kind, {observing, holding, taking, followChecked, controlled}) {
    if (kind === 'owner') return !!observing && !holding && !taking && !!followChecked;
    if (kind === 'controller') return !observing && !!controlled;
    return false;
  }

  // The administrators observing a session, as told to the owner's pages (session-observers
  // {admins}): the logins, sorted and without duplicates, or null for an invalid payload.
  function normalizeObservers(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).join() !== 'admins') return null;
    const {admins} = raw;
    if (!Array.isArray(admins) || admins.length > MAX_OBSERVERS) return null;
    if (admins.some(login => typeof login !== 'string' || !login || login.length > MAX_LOGIN)) return null;
    return [...new Set(admins)].sort();
  }

  return {LAYOUT_PANES, paneCount, normalizeView, normalizeGeometry, normalizeViewport, geometryPixels, geometryFraction, sameView, followsView, normalizeObservers};
});
