// CTL03: node positions of the Graphic view as session data: their validation
// (common/graphic-layout.js), the runner's layout.json (runner/session.js, runner/commands/layout.js),
// the session archive (runner/archive-snapshot.js, runner/archive-zip.js), the relay of the server
// (server/sockets.js) and the browser (public/graphic-view.js), one driver at a time.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {MAX_COORDINATE, normalizePosition, normalizeNodePosition, parseLayout, layoutFile} = require('../../common/graphic-layout');
const {LAYOUT_SCHEMA_VERSION} = require('../../common/schema-versions');
const {Session, removeEmptySessionDirectory} = require('../../runner/session');
const {commands} = require('../../runner/commands/layout');
const {writeArchive, readArchive} = require('../../runner/archive-zip');
const {createEventBudget, createLayoutWriter} = require('../../server/layout-writes');
const {moduleSource, read} = require('./web-ui-source');

const HOST = 'h-0123456789abcdef';
const SWITCH = 's-0123456789abcdef';

function sessionDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-layout-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const session = new Session({runtimeRoot: dir, id: '0000000000000001'});
  fs.mkdirSync(session.runtimeDir, {recursive: true});
  return {dir, session};
}

test('a position: finite numbers within the bounds, rounded to 0.1', () => {
  assert.equal(LAYOUT_SCHEMA_VERSION, 1);
  assert.deepEqual(normalizePosition({x: 12.345, y: -0.04}), {x: 12.3, y: 0});
  assert.deepEqual(normalizePosition({x: MAX_COORDINATE, y: -MAX_COORDINATE}), {x: 100000, y: -100000});
  for (const raw of [null, undefined, 'x', [], {}, {x: 1}, {x: '1', y: 2}, {x: NaN, y: 0}, {x: 0, y: Infinity}, {x: 100000.1, y: 0}, {x: 0, y: -1e9}]) {
    assert.equal(normalizePosition(raw), null, JSON.stringify(raw));
  }
});

test('a node-position event: exactly {nodeId, x, y, final}, a node ID and a boolean final', () => {
  assert.deepEqual(normalizeNodePosition({nodeId: HOST, x: 1.26, y: 2, final: true}), {nodeId: HOST, x: 1.3, y: 2, final: true});
  assert.deepEqual(normalizeNodePosition({final: false, y: 0, x: 0, nodeId: SWITCH}), {nodeId: SWITCH, x: 0, y: 0, final: false});
  for (const raw of [null, [], {nodeId: HOST, x: 0, y: 0}, {nodeId: HOST, x: 0, y: 0, final: 1}, {nodeId: HOST, x: 0, y: 0, final: true, extra: 1},
    {nodeId: 'h-1', x: 0, y: 0, final: true}, {nodeId: 7, x: 0, y: 0, final: true}, {nodeId: HOST, x: 1e6, y: 0, final: true},
    {nodeId: HOST, x: 0, y: NaN, final: false}]) {
    assert.equal(normalizeNodePosition(raw), null, JSON.stringify(raw));
  }
});

test('layout.json: schemaVersion 1, positions of known nodes only; anything else is refused, never repaired', () => {
  const positions = parseLayout({schemaVersion: 1, positions: {[HOST]: {x: 1, y: 2}}}, [HOST, SWITCH]);
  assert.deepEqual([...positions], [[HOST, {x: 1, y: 2}]]);
  assert.equal(parseLayout({schemaVersion: 1, positions: {}}, new Set()).size, 0);
  for (const raw of [null, [], {}, {schemaVersion: 2, positions: {}}, {schemaVersion: 1}, {schemaVersion: 1, positions: []},
    {schemaVersion: 1, positions: {}, extra: 1}, {schemaVersion: 1, positions: {[SWITCH]: {x: 0, y: 0}}},
    {schemaVersion: 1, positions: {[HOST]: {x: 0}}}, {schemaVersion: 1, positions: {[HOST]: {x: 0, y: 0, z: 0}}},
    {schemaVersion: 1, positions: {[HOST]: {x: 0, y: 2e5}}}]) {
    assert.throws(() => parseLayout(raw, [HOST]), /Invalid layout/, JSON.stringify(raw));
  }
  const file = layoutFile(new Map([[SWITCH, {x: 3, y: 4}], [HOST, {x: 1, y: 2}]]));
  assert.deepEqual(file, {schemaVersion: 1, positions: {[HOST]: {x: 1, y: 2}, [SWITCH]: {x: 3, y: 4}}});
  assert.deepEqual(Object.keys(file.positions), [HOST, SWITCH], 'sorted by node ID');
});

test('the runner keeps the positions of existing nodes in layout.json, prunes removed nodes and removes an empty layout', t => {
  const {session} = sessionDir(t);
  session.nodes.set(HOST, {id: HOST, kind: 'host'});
  session.nodes.set(SWITCH, {id: SWITCH, kind: 'switch'});
  assert.deepEqual(commands['layout.get']({session}), {positions: {}});
  assert.deepEqual(commands['layout.set']({session}, {nodeId: HOST, x: 10.04, y: -3}), {ok: true});
  commands['layout.set']({session}, {nodeId: SWITCH, x: 0, y: 0});
  assert.deepEqual(JSON.parse(fs.readFileSync(session.layoutFile, 'utf8')), {schemaVersion: 1, positions: {[HOST]: {x: 10, y: -3}, [SWITCH]: {x: 0, y: 0}}});
  assert.deepEqual(commands['layout.get']({session}), {positions: {[HOST]: {x: 10, y: -3}, [SWITCH]: {x: 0, y: 0}}});
  assert.throws(() => commands['layout.set']({session}, {nodeId: 'h-ffffffffffffffff', x: 0, y: 0}), /Unknown node/);
  for (const [x, y] of [[NaN, 0], [0, '1'], [1e6, 0]]) assert.throws(() => commands['layout.set']({session}, {nodeId: HOST, x, y}), /Invalid node position/);
  session.nodes.delete(SWITCH);
  session.prunePositions();
  assert.deepEqual(JSON.parse(fs.readFileSync(session.layoutFile, 'utf8')).positions, {[HOST]: {x: 10, y: -3}}, 'the removed node is pruned');
  session.nodes.delete(HOST);
  session.prunePositions();
  assert.equal(fs.existsSync(session.layoutFile), false, 'no position left: no file');
});

test('an empty session directory with a layout.json is removed with it', t => {
  const {session} = sessionDir(t);
  session.saveMetadata();
  session.saveMeta();
  fs.writeFileSync(session.layoutFile, JSON.stringify({schemaVersion: 1, positions: {}}));
  assert.equal(removeEmptySessionDirectory(session.runtimeDir), true);
  assert.equal(fs.existsSync(session.runtimeDir), false);
});

test('the session ZIP carries layout.json as an optional entry, within the metadata limit', async t => {
  const {dir} = sessionDir(t);
  const metadata = path.join(dir, 'session.json'), layout = path.join(dir, 'layout.json');
  fs.writeFileSync(metadata, '{"schemaVersion":1,"engine":"qemu","hosts":[],"switches":[]}\n');
  fs.writeFileSync(layout, '{"schemaVersion":1,"positions":{}}\n');
  const zip = path.join(dir, 'session.zip'), stage = path.join(dir, 'stage');
  fs.mkdirSync(stage);
  await writeArchive(zip, [{name: 'session.json', file: metadata}, {name: 'layout.json', file: layout}]);
  assert.deepEqual(await readArchive(zip, stage), ['session.json', 'layout.json']);
  const snapshot = fs.readFileSync('runner/archive-snapshot.js', 'utf8');
  assert.match(snapshot, /if \(session\.positions\.size\) sources\.push\(\{name: 'layout\.json', file: session\.layoutFile\}\);/, 'exported when there are positions');
  assert.match(snapshot, /paths\.includes\('layout\.json'\)\s*\? parseLayout\(JSON\.parse\(fs\.readFileSync\(path\.join\(stage, 'layout\.json'\), 'utf8'\)\), ids\) : new Map\(\)/,
    'read and validated against the nodes of the archive');
  assert.match(snapshot, /session\.saveMetadata\(\);\s*session\.saveLayout\(\);/, 'the runner writes its own layout.json');
  assert.match(snapshot, /emit\('graphic-layout', \{positions: Object\.fromEntries\(session\.positions\)\}\);/, 'the loaded layout replaces the pages\' one');
  const zipSource = fs.readFileSync('runner/archive-zip.js', 'utf8');
  assert.ok(zipSource.includes("(name === 'session.json' || name === 'layout.json' || "), 'the 4 MiB limit of the metadata files');
  assert.ok(zipSource.includes("name !== 'session.json' && name !== 'layout.json' && "), 'an allowed entry name');
  assert.match(fs.readFileSync('runner/node-lifecycle.js', 'utf8'), /ctx\.session\.saveMetadata\(\);\s*ctx\.session\.prunePositions\(\);/, 'a removed node loses its position');
});

test('the server accepts node-position from the driver only, checks the node, relays it and keeps the final position', () => {
  const sockets = fs.readFileSync('server/sockets.js', 'utf8');
  assert.match(sockets, /layout: 'Read-only observation: take control to move nodes\.'/);
  assert.match(sockets, /const layoutRefusal = \(\) => consoleRefusal\(\{observer, lock: control\.get\(session\.id\), admin: user\.login, action: 'layout'\}\);/);
  assert.match(sockets, /if \(refusal\) \{ if \(observer\) refuse\(refusal\); return; \}\s*const moved = normalizeNodePosition\(received\);/);
  assert.match(sockets, /if \(!nodeIds\.includes\(moved\.nodeId\) \|\| layoutRefusal\(\)\) return;/);
  assert.match(sockets, /socket\.to\(sessionRoom\(session\)\)\.emit\('node-position', \{nodeId, x, y\}\);\s*if \(moved\.final\) layoutWriterOf\(session\.id, runner\)\.set\(nodeId, \{x, y\}\);/);
  assert.match(sockets, /const positionBudget = createEventBudget\(\{max: 20, windowMs: 1000\}\);\s*socket\.on\('node-position', guard\(received => \{\s*if \(!positionBudget\.take\(\)\) return;/,
    'at most 20 events per second per socket, the excess dropped');
  assert.match(sockets, /write: \(nodeId, \{x, y\}\) => runner\.request\('layout\.set', \{nodeId, x, y\}\)/);
  assert.match(sockets, /'guest-info', 'graphic-layout'\]/, 'a loaded layout reaches the session room');
  assert.match(fs.readFileSync('server/routes/nodes.js', 'utf8'), /app\.get\('\/api\/graphic-layout', handle\('layout\.get', \(\) => \(\{\}\), 500, \{noStore: true\}\)\);/);
});

test('the browser reads the layout from the server, publishes a drag throttled and its end, and locks the Graphic view for a follower', () => {
  const graphic = moduleSource('graphic-view');
  assert.doesNotMatch(graphic, /localStorage\.(?:get|set)Item\(graphicLayoutKey/);
  assert.doesNotMatch(moduleSource('state'), /graphicLayoutKey/, 'no layout in the browser any more');
  assert.doesNotMatch(moduleSource('load-dialog'), /graphicLayoutKey/);
  assert.match(graphic, /fetch\('\/api\/graphic-layout', \{cache: 'no-store'\}\)/);
  assert.match(graphic, /positionPending = \{nodeId, x, y, final\};\s*if \(final\) sendPosition\(\);\s*else if \(positionTimer === null\) positionTimer = setTimeout\(sendPosition, PUBLISH_INTERVAL\);/);
  assert.match(graphic, /emitOnSession\('node-position', positionPending\)/);
  assert.match(graphic, /const PUBLISH_INTERVAL = 100;/);
  assert.match(graphic, /locked: nodeElement \? !canWrite\(\) : !!viewDriver\(\)/, 'a node moves for the driver only, the canvas pans when this page drives its view');
  assert.match(graphic, /if \(drag\.locked\) return;\s*drag\.moved = true;/, 'a locked drag stays a click');
  assert.match(graphic, /event\.preventDefault\(\);\s*if \(viewDriver\(\)\) return;\s*const point = canvasPoint\(event\);/, 'no wheel zoom while driven');
  assert.match(graphic, /\(event\.target === graphicCanvas \|\| nodeElement\) && !viewDriver\(\)/, 'no keyboard zoom while driven');
  assert.match(graphic, /function zoomCentered\(factor\) \{\s*if \(viewDriver\(\)\) return;/);
  assert.match(graphic, /if \(viewDriver\(\) && appliedViewport\) centerOn\(appliedViewport\);/, 'a driven page keeps the driver\'s center when resized');
  const socket = moduleSource('socket');
  assert.match(socket, /socket\.on\('node-position', nodePositionReceived\);/);
  assert.match(socket, /socket\.on\('graphic-layout', graphicLayoutReceived\);/);
  assert.match(socket, /socket\.on\('connect', \(\) => \{ syncSessionsFromServer\(\); loadGraphicLayout\(\);/);
  const workspace = moduleSource('workspace');
  assert.match(workspace, /geometry: floatingGeometry\(\), viewport: graphicViewport\(\)\};/, 'captureView reads the viewport');
  assert.ok(workspace.indexOf('setGraphicViewport(view.viewport)') < workspace.indexOf('setGraphicView(view.mode'), 'the viewport before the mode shows it');
  const html = read('index.html');
  for (const id of ['graphic-zoom-out', 'graphic-zoom-in', 'graphic-fit']) assert.match(html, new RegExp(`<button id="${id}" class="view-control"`), id);
  const css = read('css/app.css');
  assert.match(css, /body\[data-write-blocked="true"\] \.topology-node \{ cursor: pointer; \}/);
  assert.match(css, /body\[data-view-driven="true"\] #graphic-canvas, body\[data-view-driven="true"\] \.topology-node \{ cursor: default; \}/);
});

test('node-position is bounded per socket: at most 20 events per second, the excess dropped', () => {
  let time = 1000;
  const budget = createEventBudget({max: 20, windowMs: 1000, now: () => time});
  const taken = Array.from({length: 30}, () => budget.take());
  assert.equal(taken.filter(Boolean).length, 20);
  assert.deepEqual(taken.slice(18, 22), [true, true, false, false], 'the excess is dropped');
  time += 999;
  assert.equal(budget.take(), false, 'still the same second');
  time += 1;
  assert.equal(budget.take(), true, 'a new second');
});

test('the final positions of a session are coalesced: the latest per node, a few writes per second, the last one delivered', async () => {
  const writes = [];
  const timers = [];
  let idle = 0;
  let failNext = false;
  const writer = createLayoutWriter({intervalMs: 250, setTimer: (callback, delay) => { timers.push({callback, delay}); return timers.length; },
    onIdle: () => { idle += 1; },
    write: async (nodeId, position) => { writes.push([nodeId, position]); if (failNext) { failNext = false; throw new Error('Unknown node.'); } }});
  for (let index = 0; index < 50; index++) writer.set(HOST, {x: index, y: 0});
  writer.set(SWITCH, {x: 1, y: 1});
  assert.equal(timers.length, 1, 'one write scheduled for the whole burst');
  assert.equal(timers[0].delay, 250);
  assert.equal(writer.pending, 2);
  failNext = true;
  await timers[0].callback();
  assert.deepEqual(writes, [[HOST, {x: 49, y: 0}], [SWITCH, {x: 1, y: 1}]], 'the latest position of each node only; a failed write does not stop the others');
  assert.equal(idle, 1, 'nothing pending: idle');
  writer.set(HOST, {x: 7, y: 7});
  assert.equal(timers.length, 2, 'a later move is written too');
  await timers[1].callback();
  assert.deepEqual(writes.at(-1), [HOST, {x: 7, y: 7}], 'the last one is always delivered');
});

test('a position set while a write is in flight is written after it', async () => {
  const writes = [];
  const timers = [];
  let release;
  const writer = createLayoutWriter({setTimer: callback => { timers.push(callback); return timers.length; },
    write: (nodeId, position) => { writes.push(position.x); return position.x === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(); }});
  writer.set(HOST, {x: 1, y: 0});
  const flushing = timers[0]();
  writer.set(HOST, {x: 2, y: 0});
  assert.equal(timers.length, 1, 'not scheduled while writing');
  release();
  await flushing;
  assert.equal(timers.length, 2, 'scheduled once the write is done');
  await timers[1]();
  assert.deepEqual(writes, [1, 2]);
});
