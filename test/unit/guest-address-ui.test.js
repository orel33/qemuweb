'use strict';

// The address of an interface in the Graphic view (public/topology-graphic.js, socket.js, nodes.js): drawn only
// for a running host that reports it, next to the host end of its link, with the MAC and the addresses in the
// tooltip, cleared when the host stops. The SVG is checked with a minimal fake DOM (no browser).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {buildGraph, describe, addressesOf, addressText, draw} = require('../../public/topology-graphic');
const {publicDir, moduleSource} = require('./web-ui-source');

const host = (extra = {}) => ({id: 'h1', kind: 'host', hostname: 'h1', osHint: 'Debian', running: true, hasLaunched: true, interfaces: ['s1', 's1'],
  networkInterfaces: [{switchId: 's1', port: 1, mac: '52:54:00:aa:bb:01'}, {switchId: 's1', port: 2, mac: '52:54:00:aa:bb:02'}], addresses: {0: ['192.168.0.1/24']}, ...extra});
const sw = {id: 's1', kind: 'switch', hostname: 'sw1', running: true, hasLaunched: true, interfaces: []};

test('only a running host shows addresses, and only well formed ones, at most four', () => {
  assert.deepEqual(addressesOf(host(), 0), ['192.168.0.1/24']);
  assert.deepEqual(addressesOf(host(), 1), []);
  assert.deepEqual(addressesOf(host({running: false}), 0), [], 'a stopped host shows nothing');
  assert.deepEqual(addressesOf(host({addresses: undefined}), 0), []);
  assert.deepEqual(addressesOf(host({addresses: {0: 'not a list'}}), 0), []);
  assert.deepEqual(addressesOf(host({addresses: {0: ['<b>x</b>/24', '10.0.0.1', '10.0.0.2/24', 7, null, 'fec0::1/64', '1.1.1.1/24', '2.2.2.2/24', '3.3.3.3/24']}}), 0),
    ['10.0.0.2/24', 'fec0::1/64', '1.1.1.1/24', '2.2.2.2/24']);
});

test('the text under the interface label is the first address and the count of the others', () => {
  assert.equal(addressText([]), '');
  assert.equal(addressText(['192.168.0.1/24']), '192.168.0.1/24');
  assert.equal(addressText(['192.168.0.1/24', 'fec0::1/64', '10.0.0.1/8']), '192.168.0.1/24 +2');
});

test('the node tooltip lists the address after the interface line', () => {
  const graph = buildGraph([host(), sw]);
  const info = describe(graph.nodes.find(node => node.id === 'h1'), graph);
  assert.deepEqual(info.interfaces, ['eth0: sw1 port 1 · 192.168.0.1/24', 'eth1: sw1 port 2']);
});

test('every link gets an address position next to the host end, apart from the interface label', () => {
  const graph = buildGraph([host(), sw]);
  for (const link of graph.links) {
    assert.ok(Number.isFinite(link.addressLabel.x) && Number.isFinite(link.addressLabel.y), 'finite position');
    assert.notDeepEqual([link.addressLabel.x, link.addressLabel.y], [link.hostLabel.x, link.hostLabel.y], 'not on the eth label');
    assert.ok(['start', 'middle', 'end'].includes(link.addressLabel.anchor));
  }
});

test('draw: the address text, its class and the tooltip with MAC; nothing for a stopped host or a host without address', () => {
  const rendered = machines => {
    const created = [];
    class Node {
      constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.textContent = ''; this.dataset = {}; this.classList = {add() {}}; }
      setAttribute(key, value) { this.attrs[key] = value; }
      append(...items) { this.children.push(...items); }
      replaceChildren(...items) { this.children = items; }
      prepend(...items) { this.children.unshift(...items); }
      querySelectorAll() { return []; }
      querySelector() { return null; }
      remove() {}
    }
    global.document = {createElementNS: (_, tag) => { const node = new Node(tag); created.push(node); return node; }, createElement: tag => new Node(tag)};
    try { draw(new Node('div'), machines, new Map(), {}); } finally { delete global.document; }
    return created;
  };
  const withAddress = rendered([host(), sw]);
  const labels = withAddress.filter(node => node.tag === 'text' && /link-address/.test(node.attrs.class || ''));
  assert.deepEqual(labels.map(node => node.textContent), ['192.168.0.1/24']);
  const titles = withAddress.filter(node => node.tag === 'title').map(node => node.textContent);
  assert.ok(titles.includes('h1 eth0 ↔ sw1 port 1\n192.168.0.1/24\nMAC 52:54:00:aa:bb:01'), JSON.stringify(titles));
  assert.ok(titles.includes('h1 eth1 ↔ sw1 port 2\nMAC 52:54:00:aa:bb:02'));
  for (const machines of [[host({running: false}), sw], [host({addresses: {}}), sw]]) {
    assert.equal(rendered(machines).filter(node => /link-address/.test(node.attrs?.class || '')).length, 0);
  }
});

test('the page keeps the addresses of each node, updates them on guest-info and clears them when the host stops', () => {
  const socket = moduleSource('socket');
  assert.match(socket, /socket\.on\('guest-info', event =>/);
  assert.match(socket, /machine\.addresses = event\.addresses !== null && typeof event\.addresses === 'object' \? event\.addresses : \{\};\n    renderGraphic\(\);/);
  assert.match(socket, /if \(!event\.running\) machine\.addresses = \{\};/);
  const nodes = moduleSource('nodes');
  assert.match(nodes, /addresses: session\.addresses \|\| \{\}/);
  assert.match(nodes, /current\.addresses = session\.addresses \|\| \{\};/);
});

test('the address label has its own style and hides at the far zoom with the other link labels', () => {
  const css = fs.readFileSync(path.join(publicDir, 'css', 'app.css'), 'utf8');
  assert.match(css, /\.topology-link text\.link-address \{[^}]*fill:/);
  assert.match(css, /\.topology-svg\[data-zoom="far"\] \.topology-link text/);
});
