// Rectilinear links of the Graphic view (GRA05): the pure routing function and the places the button and
// the browser preference are wired (the style is part of the view state since CTL04).
const test = require('node:test');
const assert = require('node:assert/strict');
const {CARD_HEIGHT, CARD_WIDTH, buildGraph, rectilinearRoute} = require('../../public/topology-graphic');
const {moduleSource, read} = require('./web-ui-source');

const NORMAL = {top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0]};
const OPPOSITE = {top: 'bottom', bottom: 'top', left: 'right', right: 'left'};

// A link from a card at `from` leaving by `side` to a card at `to`, attached at the middle of the edges.
function route(side, from, to, spread = 0) {
  const edge = (card, where) => {
    const n = NORMAL[where];
    return {x: card.x + n[0] * CARD_WIDTH / 2, y: card.y + n[1] * CARD_HEIGHT / 2, side: where, card};
  };
  return {from: edge(from, side), to: edge(to, OPPOSITE[side]), ...rectilinearRoute(edge(from, side), edge(to, OPPOSITE[side]), spread)};
}

function points(path) {
  return path.match(/[ML] -?[\d.]+ -?[\d.]+/g).map(item => item.slice(2).split(' ').map(Number));
}

function assertRectilinear(path, from, to) {
  const list = points(path);
  assert.deepEqual(list[0], [from.x, from.y]);
  assert.deepEqual(list[list.length - 1], [to.x, to.y]);
  for (let i = 1; i < list.length; i++) assert.ok(list[i][0] === list[i - 1][0] || list[i][1] === list[i - 1][1], `segment ${i} of ${path} is oblique`);
  assert.ok(!/C/.test(path));
  return list;
}

test('each side pair gives a Z of horizontal and vertical segments, exact at both ends, that leaves and enters perpendicularly', () => {
  const cases = [
    ['bottom', {x: 100, y: 0}, {x: 400, y: 300}],
    ['top', {x: 100, y: 300}, {x: -200, y: 0}],
    ['right', {x: 0, y: 100}, {x: 500, y: 300}],
    ['left', {x: 500, y: 300}, {x: 0, y: 0}]
  ];
  for (const [side, from, to] of cases) {
    const result = route(side, from, to);
    const list = assertRectilinear(result.path, result.from, result.to);
    assert.equal(list.length, 4, `${side}: two bends`);
    const vertical = side === 'top' || side === 'bottom';
    const axis = vertical ? 1 : 0;
    assert.equal(list[1][1 - axis], list[0][1 - axis], 'leaves perpendicularly');
    assert.equal(list[2][1 - axis], list[3][1 - axis], 'enters perpendicularly');
    assert.equal(list[1][axis], list[2][axis], 'one middle run');
    const n = NORMAL[side][axis];
    assert.ok((list[1][axis] - list[0][axis]) * n > 0 && (list[3][axis] - list[2][axis]) * n > 0, 'the run is beyond the leaving edge and before the entering edge');
  }
});

test('aligned ends make one straight segment', () => {
  const vertical = route('bottom', {x: 100, y: 0}, {x: 100, y: 300});
  assert.deepEqual(points(vertical.path), [[100, 56], [100, 244]]);
  const horizontal = route('right', {x: 0, y: 100}, {x: 500, y: 100});
  assert.deepEqual(points(horizontal.path), [[122, 100], [378, 100]]);
});

test('the middle run is outside both cards, at a stub from them, when the cards are close', () => {
  // Gap of 40 px between the two edges: shorter stubs, the run in the middle of the gap.
  const near = route('bottom', {x: 0, y: 0}, {x: 150, y: CARD_HEIGHT + 40});
  const list = assertRectilinear(near.path, near.from, near.to);
  assert.equal(list[1][1], CARD_HEIGHT / 2 + 20);
  assert.equal(list.length, 4);
  // Cards that overlap along the axis: the side run goes around both cards (the entry itself is hidden by the cards).
  const overlap = route('bottom', {x: 0, y: 0}, {x: 60, y: 40});
  const detour = assertRectilinear(overlap.path, overlap.from, overlap.to);
  assert.equal(detour.length, 6);
  assert.ok(detour[2][0] < -CARD_WIDTH / 2 || detour[2][0] > 60 + CARD_WIDTH / 2, 'the side run clears both cards');
  assert.equal(detour[2][0], detour[3][0]);
});

test('the spread moves the middle run, inside the gap, and the direction follows the side of the other end', () => {
  const base = points(route('bottom', {x: 0, y: 0}, {x: 400, y: 300}).path)[1][1];
  const right = points(route('bottom', {x: 0, y: 0}, {x: 400, y: 300}, 12).path)[1][1];
  const left = points(route('bottom', {x: 400, y: 0}, {x: 0, y: 300}, 12).path)[1][1];
  assert.ok(right < base && left > base);
  const clamped = points(route('bottom', {x: 0, y: 0}, {x: 400, y: 300}, 1e6).path)[1][1];
  assert.ok(clamped >= CARD_HEIGHT / 2 + 14 && clamped <= 300 - CARD_HEIGHT / 2 - 14);
});

test('four hosts on one switch: rectilinear paths only, distinct middle runs, curved by default', () => {
  const machines = [{id: 'sw', kind: 'switch', hostname: 'sw'}];
  for (let i = 0; i < 4; i++) machines.push({id: `h${i}`, kind: 'host', hostname: `h${i}`, interfaces: ['sw'], networkInterfaces: [{switchId: 'sw', port: i + 1}]});
  const positions = new Map([['sw', {x: 0, y: 400}], ...[0, 1, 2, 3].map(i => [`h${i}`, {x: -450 + i * 300, y: 0}])]);
  const curved = buildGraph(machines, positions);
  assert.ok(curved.links.every(link => / C /.test(link.path)));
  const graph = buildGraph(machines, positions, {linkStyle: 'rectilinear'});
  const runs = {toRight: [], toLeft: []};
  for (const link of graph.links) {
    const list = assertRectilinear(link.path, {x: link.x1, y: link.y1}, {x: link.x2, y: link.y2});
    assert.equal(list.length, 4);
    runs[link.x1 < link.x2 ? 'toRight' : 'toLeft'].push(list[1][1]);
    assert.ok(Number.isFinite(link.mid.x) && Number.isFinite(link.mid.y));
  }
  // Links that run the same way have runs that could lie on each other: they are staggered.
  for (const list of Object.values(runs)) assert.equal(new Set(list).size, list.length, 'no two links share the same middle run');
});

test('CTL04: the Link style button is a view control; the style is in the view state, the preference saved by a choice of this page only', () => {
  const html = read('index.html');
  const button = html.match(/<button id="graphic-links"[^>]*>/)[0];
  assert.match(button, /aria-pressed=/);
  assert.match(button, /title="Rectilinear links"/);
  assert.match(button, /aria-label="Rectilinear links"/);
  assert.match(button, /class="view-control"/);
  assert.doesNotMatch(button, /write-action/);
  assert.match(moduleSource('state'), /export const graphicLinksKey = 'qemuweb\.graphic-links'/);
  const view = moduleSource('graphic-view');
  assert.match(view, /savedLinkStyle = ViewState\.normalizeLinkStyle\(localStorage\.getItem\(graphicLinksKey\)\)/);
  assert.match(view, /localStorage\.setItem\(graphicLinksKey, savedLinkStyle\)/);
  assert.match(view, /ViewState\.linkStyleChange\(\{shown: linkStyle, saved: savedLinkStyle\}, style, \{own\}\)/);
  assert.match(view, /export function setGraphicLinkStyle\(style\) \{ changeLinkStyle\(style, false\); \}/, 'a received style is not saved');
  assert.match(view, /function toggleLinkStyle\(\) \{\s*if \(viewDriver\(\)\) return;\s*changeLinkStyle\([^;]*, true\);\s*viewChanged\(\);/, 'the driver saves and publishes');
  assert.match(view, /Curved links/);
  const workspace = moduleSource('workspace');
  assert.match(workspace, /setGraphicLinkStyle\(view\.linkStyle\);/, 'applyView shows the received style');
  assert.match(workspace, /applyView\(\{\.\.\.view, linkStyle: graphicLinkPreference\(\)\}\)/, 'the saved view is restored with the preference');
  assert.match(read('view-state.js'), /'linkStyle'\]/);
  assert.doesNotMatch(moduleSource('load-dialog'), /graphicLinksKey/);
});
