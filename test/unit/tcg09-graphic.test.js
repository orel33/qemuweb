const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {parseTopology} = require('../../topology');
const {buildGraph, stateOf} = require('../../public/topology-graphic');

function sessionsFromFixture(file) {
  const topology = parseTopology(fs.readFileSync(file, 'utf8'), ['debian13-legacy']);
  const switches = topology.switches.map(sw => ({id: sw.name, kind: 'switch', hostname: sw.name, running: true}));
  const portBySwitch = new Map();
  const hosts = topology.hosts.map(host => ({
    id: host.name, kind: 'vm', hostname: host.name, osHint: host.system, running: false,
    interfaces: host.switches,
    networkInterfaces: host.switches.map(switchId => {
      const port = (portBySwitch.get(switchId) || 0) + 1;
      portBySwitch.set(switchId, port);
      return {switchId, port};
    })
  }));
  return [...switches, ...hosts];
}

test('the LAN and gateway examples produce a node for every session and a distinct curved path for every NIC', () => {
  for (const [file, expectedSwitches, expectedHosts, expectedLinks] of [
    ['topo/lan.topo', 1, 4, 4],
    ['topo/gw.topo', 2, 4, 5]
  ]) {
    const graph = buildGraph(sessionsFromFixture(file));
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
    {id: 'h1', kind: 'vm', hostname: 'h1', interfaces: ['s1', 's1', null], networkInterfaces: [
      {switchId: 's1', port: 1}, {switchId: 's1', port: 2}, {switchId: null, port: null}
    ]}
  ]);
  assert.equal(graph.links.length, 2);
  assert.deepEqual(graph.links.map(link => link.nicIndex), [0, 1]);
  assert.notEqual(graph.links[0].path, graph.links[1].path);
  assert.notEqual(graph.links[0].y1, graph.links[1].y1);
  assert.notEqual(graph.links[0].y2, graph.links[1].y2);
});

test('moving nodes updates their Bézier endpoints without changing network links', () => {
  const sessions = [
    {id: 's1', kind: 'switch', hostname: 's1'},
    {id: 'h1', kind: 'vm', hostname: 'h1', interfaces: ['s1']}
  ];
  const original = buildGraph(sessions);
  const moved = buildGraph(sessions, new Map([['h1', {x: 400, y: 300}], ['s1', {x: 700, y: 220}]]));
  assert.equal(moved.links.length, original.links.length);
  assert.deepEqual(moved.nodes.map(node => node.id), original.nodes.map(node => node.id));
  assert.equal(moved.nodes.find(node => node.id === 'h1').x, 400);
  assert.equal(moved.nodes.find(node => node.id === 's1').y, 220);
  assert.notEqual(moved.links[0].path, original.links[0].path);
});

test('empty and changing session states are represented', () => {
  assert.deepEqual(buildGraph([]).nodes, []);
  assert.equal(stateOf({running: false, hasLaunched: false}), 'ready');
  assert.equal(stateOf({running: false, hasLaunched: true}), 'stopped');
  assert.equal(stateOf({running: true}), 'running');
  assert.equal(stateOf({running: true, busy: true, operation: 'stopping'}), 'stopping');
  assert.equal(stateOf({running: false, error: 'failed'}), 'error');
});
