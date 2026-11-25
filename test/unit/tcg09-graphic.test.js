const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {parseTopology} = require('../../common/topology');
const {CARD_HEIGHT, CARD_WIDTH, buildGraph, stateOf} = require('../../public/topology-graphic');

function nodesFromFixture(file) {
  const topology = parseTopology(fs.readFileSync(file, 'utf8'), ['debian13-cloud']);
  const switches = topology.switches.map(sw => ({id: sw.name, kind: 'switch', hostname: sw.name, running: true}));
  const portBySwitch = new Map();
  const hosts = topology.hosts.map(host => ({
    id: host.name, kind: 'host', hostname: host.name, osHint: host.system, running: false,
    interfaces: host.switches,
    networkInterfaces: host.switches.map(switchId => {
      const port = (portBySwitch.get(switchId) || 0) + 1;
      portBySwitch.set(switchId, port);
      return {switchId, port};
    })
  }));
  return [...switches, ...hosts];
}

test('the LAN and gateway examples produce a node for every host and switch and a distinct curved path for every NIC', () => {
  for (const [file, expectedSwitches, expectedHosts, expectedLinks] of [
    ['topo/lan.topo', 1, 4, 4],
    ['topo/gw.topo', 2, 4, 5]
  ]) {
    const graph = buildGraph(nodesFromFixture(file));
    assert.equal(graph.switches, expectedSwitches);
    assert.equal(graph.hosts, expectedHosts);
    assert.equal(graph.nodes.length, expectedSwitches + expectedHosts);
    assert.equal(graph.links.length, expectedLinks);
    assert.equal(new Set(graph.links.map(link => link.path)).size, expectedLinks);
    assert.ok(graph.links.every(link => link.path.includes(' C ') && link.port > 0));
  }
});

test('parallel interfaces remain separate and disconnected interfaces have no link', () => {
  const graph = buildGraph([
    {id: 's1', kind: 'switch', hostname: 's1'},
    {id: 'h1', kind: 'host', hostname: 'h1', interfaces: ['s1', 's1', null], networkInterfaces: [
      {switchId: 's1', port: 1}, {switchId: 's1', port: 2}, {switchId: null, port: null}
    ]}
  ]);
  assert.equal(graph.links.length, 2);
  assert.deepEqual(graph.links.map(link => link.nicIndex), [0, 1]);
  assert.notEqual(graph.links[0].path, graph.links[1].path);
  assert.notEqual(graph.links[0].x1, graph.links[1].x1);
  assert.notEqual(graph.links[0].x2, graph.links[1].x2);
});

test('moving nodes updates their Bézier endpoints without changing network links', () => {
  const nodes = [
    {id: 's1', kind: 'switch', hostname: 's1'},
    {id: 'h1', kind: 'host', hostname: 'h1', interfaces: ['s1']}
  ];
  const original = buildGraph(nodes);
  const moved = buildGraph(nodes, new Map([['h1', {x: 400, y: 300}], ['s1', {x: 700, y: 220}]]));
  assert.equal(moved.links.length, original.links.length);
  assert.deepEqual(moved.nodes.map(node => node.id), original.nodes.map(node => node.id));
  assert.equal(moved.nodes.find(node => node.id === 'h1').x, 400);
  assert.equal(moved.nodes.find(node => node.id === 's1').y, 220);
  assert.notEqual(moved.links[0].path, original.links[0].path);
});

test('node positions are not clamped: the world has no edge, whatever the zoom', () => {
  const nodes = [{id: 's1', kind: 'switch', hostname: 's1'}, {id: 'h1', kind: 'host', hostname: 'h1', interfaces: ['s1']}];
  const graph = buildGraph(nodes, new Map([['h1', {x: -5000, y: 9000}]]));
  const host = graph.nodes.find(node => node.id === 'h1');
  assert.equal(host.x, -5000);
  assert.equal(host.y, 9000);
});

test('the default placement keeps every card apart on the example topologies, and manual positions win', () => {
  for (const file of ['topo/lan.topo', 'topo/gw.topo', 'topo/dmz.topo']) {
    const nodes = nodesFromFixture(file);
    const graph = buildGraph(nodes);
    for (const [index, a] of graph.nodes.entries()) {
      for (const b of graph.nodes.slice(index + 1)) {
        assert.ok(Math.abs(a.x - b.x) >= CARD_WIDTH || Math.abs(a.y - b.y) >= CARD_HEIGHT, `${file}: ${a.id} overlaps ${b.id}`);
      }
    }
    const moved = buildGraph(nodes, new Map([[nodes[0].id, {x: 1, y: 2}]]));
    assert.deepEqual(moved.nodes.filter(node => node.manual).map(node => [node.x, node.y]), [[1, 2]]);
  }
});

test('empty and changing node states are represented', () => {
  assert.deepEqual(buildGraph([]).nodes, []);
  assert.equal(stateOf({running: false, hasLaunched: false}), 'ready');
  assert.equal(stateOf({running: false, hasLaunched: true}), 'stopped');
  assert.equal(stateOf({running: true}), 'running');
  assert.equal(stateOf({running: true, busy: true, operation: 'stopping'}), 'stopping');
  assert.equal(stateOf({running: false, error: 'failed'}), 'error');
});

test('the floating console follows the view state: open and geometry captured, applied without focus, its controls view controls', () => {
  const workspace = fs.readFileSync('public/workspace.js', 'utf8');
  const floating = fs.readFileSync('public/graphic-console.js', 'utf8');
  const graphic = fs.readFileSync('public/graphic-view.js', 'utf8');
  const html = fs.readFileSync('public/index.html', 'utf8');
  const css = fs.readFileSync('public/css/app.css', 'utf8');
  assert.match(workspace, /floating: floatingConsoleOpen\(\),\s*geometry: floatingGeometry\(\)/, 'captureView reads whether it is open and where');
  assert.match(workspace, /if \(view\.floating\) openFloatingConsole\(\{focus: false\}\); else closeFloatingConsole\(\);/, 'applyView opens or closes it after the mode');
  assert.ok(workspace.indexOf('if (view.floating)') > workspace.indexOf('setGraphicView(view.mode'), 'applied after the mode');
  assert.ok(workspace.indexOf('setFloatingGeometry(view.geometry)') < workspace.indexOf('setGraphicView(view.mode'), 'the geometry before the mode shows it');
  assert.match(html, /id="floating-console-close" class="view-control"/, 'a follower cannot close it');
  // CTL02: the Terminals view hides it without closing it, the Graphic view shows it again.
  assert.match(graphic, /hideFloatingConsole\(\);\s*store\.graphicVisible = visible;/);
  assert.match(graphic, /if \(visible\) \{ loadLinkStyle\(\); renderGraphic\(\); showFloatingConsole\(\); \}/);
  assert.doesNotMatch(graphic, /closeFloatingConsole/, 'changing the mode never closes it');
  // A follower can neither move nor resize it; the driver publishes it throttled, and at the end of a move.
  assert.match(floating, /event\.target\.closest\('button'\) \|\| viewDriven\(\)\) return;/);
  assert.match(floating, /if \(!isShown\(\) \|\| !applied \|\| viewDriven\(\)\) return;/);
  assert.match(css, /body\[data-view-driven="true"\] main\[data-floating="true"\] \{ resize: none; \}/);
  assert.match(floating, /const PUBLISH_INTERVAL = 250;/);
  assert.match(floating, /moving = null;\s*frameChanged\(\);\s*publishNow\(\);/);
  assert.match(floating, /window\.addEventListener\('resize', \(\) => \{ if \(isShown\(\)\) applyFrame\(\); \}\);/, 'a window resize is not published');
});
