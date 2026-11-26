'use strict';

// Node positions of the Graphic view: session data, kept by the runner in
// <session>/layout.json and carried by the session ZIP (docs/json-files.md):
//   {"schemaVersion": 1, "positions": {"<nodeId>": {"x": <number>, "y": <number>}}}
// Coordinates are world coordinates of the Graphic view (independent of the zoom), finite,
// within [-MAX_COORDINATE, MAX_COORDINATE] and rounded to 0.1. Shared by the runner (file,
// archive, layout.set) and the server (node-position events).
const {LAYOUT_SCHEMA_VERSION} = require('./schema-versions');

const MAX_COORDINATE = 100000;
const NODE_ID = /^[hs]-[0-9a-f]{8}$/;

// {x, y} rounded, or null when x or y is not a finite number within the bounds.
function normalizePosition(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const {x, y} = raw;
  const valid = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
  if (!valid(x) || !valid(y)) return null;
  const round = value => Math.round(value * 10) / 10 || 0;
  return {x: round(x), y: round(y)};
}

// A node-position event {nodeId, x, y, final}: {nodeId, x, y, final} normalized, or null.
function normalizeNodePosition(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 4 || !['nodeId', 'x', 'y', 'final'].every(key => keys.includes(key))) return null;
  if (typeof raw.nodeId !== 'string' || !NODE_ID.test(raw.nodeId) || typeof raw.final !== 'boolean') return null;
  const position = normalizePosition(raw);
  return position && {nodeId: raw.nodeId, ...position, final: raw.final};
}

// The positions of a layout.json content, as a Map nodeId -> {x, y}. nodeIds: the IDs a position
// may name. Throws on anything else (another schemaVersion, another key, an unknown node, an
// invalid or out-of-bounds coordinate): a layout is never repaired.
function parseLayout(raw, nodeIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== LAYOUT_SCHEMA_VERSION ||
      Object.keys(raw).some(key => !['schemaVersion', 'positions'].includes(key)) ||
      !raw.positions || typeof raw.positions !== 'object' || Array.isArray(raw.positions)) {
    throw new Error('Invalid layout.json.');
  }
  const known = nodeIds instanceof Set ? nodeIds : new Set(nodeIds);
  const positions = new Map();
  for (const [id, value] of Object.entries(raw.positions)) {
    const position = normalizePosition(value);
    if (!known.has(id) || !position || Object.keys(value).length !== 2) throw new Error(`Invalid layout position: ${id.slice(0, 64)}.`);
    positions.set(id, position);
  }
  return positions;
}

// The layout.json content of positions (a Map), sorted by node ID.
function layoutFile(positions) {
  const sorted = [...positions.keys()].sort();
  return {schemaVersion: LAYOUT_SCHEMA_VERSION, positions: Object.fromEntries(sorted.map(id => [id, positions.get(id)]))};
}

module.exports = {MAX_COORDINATE, normalizePosition, normalizeNodePosition, parseLayout, layoutFile};
