// Topology overview. Node positions are browser-local during ordinary use;
// the explicit session archive can carry them to another browser.
(function (root, factory) {
  const icons = typeof module === 'object' && module.exports ? require('./network-node-icons') : root.NetworkNodeIcons;
  const api = factory(icons);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TopologyGraphic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (NodeIcons) {
  const SVG = 'http://www.w3.org/2000/svg';
  const WIDTH = 1120;
  const CARD_WIDTH = 212;

  function stateOf(machine) {
    if (machine.error) return 'error';
    if (machine.busy) return machine.operation || 'starting';
    if (machine.running) return 'running';
    return machine.hasLaunched ? 'stopped' : 'ready';
  }

  function spread(index, count, range = 34) {
    return count < 2 ? 0 : (index / (count - 1) - 0.5) * range * 2;
  }

  function buildGraph(sessions, positions = new Map()) {
    const machines = [...sessions];
    const switches = machines.filter(machine => machine.kind === 'switch');
    const switchOrder = new Map(switches.map((sw, index) => [sw.id, index]));
    const hosts = machines.filter(machine => machine.kind !== 'switch').sort((a, b) => {
      const rank = host => {
        const connected = (host.interfaces || []).filter(id => switchOrder.has(id));
        return connected.length ? connected.reduce((sum, id) => sum + switchOrder.get(id), 0) / connected.length : Infinity;
      };
      return rank(a) - rank(b);
    });
    const byId = new Map(machines.map(machine => [machine.id, machine]));
    const rows = Math.max(Math.ceil(hosts.length / 2), switches.length, 1);
    const height = Math.max(510, 150 + rows * 160);
    const nodes = new Map();
    hosts.forEach((host, index) => nodes.set(host.id, {
      id: host.id, machine: host, x: index % 2 ? 945 : 175,
      y: 155 + Math.floor(index / 2) * 160, state: stateOf(host)
    }));
    switches.forEach((sw, index) => nodes.set(sw.id, {
      id: sw.id, machine: sw, x: 560,
      y: height * (index + 1) / (switches.length + 1), state: stateOf(sw)
    }));
    for (const [id, position] of positions) {
      const node = nodes.get(id);
      if (!node || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
      node.x = Math.max(CARD_WIDTH / 2, Math.min(WIDTH - CARD_WIDTH / 2, position.x));
      node.y = Math.max(48, Math.min(height - 48, position.y));
    }

    const links = [];
    const switchSides = new Map();
    for (const host of hosts) {
      const interfaces = host.interfaces || [];
      interfaces.forEach((switchId, nicIndex) => {
        if (!switchId || !byId.has(switchId) || byId.get(switchId).kind !== 'switch') return;
        const portInfo = host.networkInterfaces?.[nicIndex];
        const port = portInfo?.switchId === switchId ? portInfo.port : null;
        const side = nodes.get(host.id).x < nodes.get(switchId).x ? 'left' : 'right';
        const link = {hostId: host.id, switchId, nicIndex, port, side};
        links.push(link);
        const key = `${switchId}:${side}`;
        if (!switchSides.has(key)) switchSides.set(key, []);
        switchSides.get(key).push(link);
      });
    }
    for (const group of switchSides.values()) {
      group.sort((a, b) => (a.port ?? Infinity) - (b.port ?? Infinity) || a.hostId.localeCompare(b.hostId) || a.nicIndex - b.nicIndex);
      group.forEach((link, index) => { link.switchOffset = spread(index, group.length); });
    }
    for (const link of links) {
      const host = nodes.get(link.hostId);
      const sw = nodes.get(link.switchId);
      const side = link.side === 'left' ? 1 : -1;
      const count = host.machine.interfaces?.length || 1;
      link.hostOffset = spread(link.nicIndex, count);
      link.x1 = host.x + side * CARD_WIDTH / 2;
      link.y1 = host.y + link.hostOffset;
      link.x2 = sw.x - side * CARD_WIDTH / 2;
      link.y2 = sw.y + link.switchOffset;
      const bend = (link.x2 - link.x1) * 0.46;
      link.path = `M ${link.x1} ${link.y1} C ${link.x1 + bend} ${link.y1}, ${link.x2 - bend} ${link.y2}, ${link.x2} ${link.y2}`;
    }
    return {width: WIDTH, height, nodes: [...nodes.values()], links, hosts: hosts.length, switches: switches.length};
  }

  function element(tag, attrs = {}, value) {
    const node = document.createElementNS(SVG, tag);
    for (const [key, attribute] of Object.entries(attrs)) node.setAttribute(key, String(attribute));
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function short(value, limit = 25) {
    const text = String(value || '');
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  function draw(container, sessions, onSelect, positions) {
    const graph = buildGraph(sessions, positions);
    container.replaceChildren();
    if (!graph.nodes.length) {
      const empty = document.createElement('div');
      empty.className = 'graphic-empty';
      empty.innerHTML = '<img src="/favicon.svg" alt=""><h2>No network yet</h2><p>Add a host or switch, or load a .topo file to see it here.</p>';
      container.append(empty);
      return graph;
    }
    const svg = element('svg', {viewBox: `0 0 ${graph.width} ${graph.height}`, role: 'group', 'aria-label': `Network topology: ${graph.hosts} hosts, ${graph.switches} switches, ${graph.links.length} connected interfaces`});
    svg.classList.add('topology-svg');
    const paths = element('g', {class: 'topology-links'});
    for (const link of graph.links) {
      const group = element('g', {class: 'topology-link'});
      group.append(element('path', {d: link.path}));
      const hostLabel = element('text', {x: link.x1 + (link.side === 'left' ? 10 : -10), y: link.y1 - 7, 'text-anchor': link.side === 'left' ? 'start' : 'end'}, `eth${link.nicIndex}`);
      const portLabel = element('text', {x: link.x2 + (link.side === 'left' ? -10 : 10), y: link.y2 - 7, 'text-anchor': link.side === 'left' ? 'end' : 'start'}, link.port == null ? 'port pending' : `#${link.port}`);
      group.append(hostLabel, portLabel);
      group.append(element('title', {}, `${graph.nodes.find(node => node.id === link.hostId).machine.hostname} eth${link.nicIndex} → ${graph.nodes.find(node => node.id === link.switchId).machine.hostname}${link.port == null ? '' : ` port ${link.port}`}`));
      paths.append(group);
    }
    svg.append(paths);
    const nodeLayer = element('g', {class: 'topology-nodes'});
    for (const node of graph.nodes) {
      const machine = node.machine;
      const isSwitch = machine.kind === 'switch';
      const iconType = NodeIcons.typeForMachine(machine.kind);
      const iconStyle = NodeIcons.styles[iconType];
      const group = element('g', {class: `topology-node ${isSwitch ? 'topology-switch' : 'topology-host'}`, transform: `translate(${node.x}, ${node.y})`, tabindex: '0', role: 'button', 'aria-label': `Open ${machine.hostname} ${isSwitch ? 'switch' : 'host'} terminal; ${node.state}`});
      group.dataset.sessionId = node.id;
      group.dataset.state = node.state;
      const interfaceDetails = isSwitch ? '' : (machine.interfaces || []).map((switchId, index) => {
        const sw = graph.nodes.find(item => item.id === switchId)?.machine;
        const portInfo = machine.networkInterfaces?.[index];
        const port = portInfo?.switchId === switchId ? portInfo.port : null;
        return `eth${index}: ${sw?.hostname || 'disconnected'}${port == null ? '' : ` port ${port}`}`;
      }).join(' · ');
      group.append(element('title', {}, `${machine.hostname} · ${node.state}${machine.message ? ` · ${machine.message}` : ''}${interfaceDetails ? ` · ${interfaceDetails}` : ''}`));
      group.append(element('rect', {x: -106, y: -48, width: 212, height: 96, rx: 12, class: 'node-card'}));
      group.append(element('rect', {x: -106, y: -48, width: 6, height: 96, rx: 3, fill: iconStyle.color}));
      group.append(element('circle', {cx: -76, cy: -15, r: 17, fill: iconStyle.badgeFill}));
      const icon = NodeIcons.create(iconType);
      icon.setAttribute('x', '-88');
      icon.setAttribute('y', '-27');
      icon.setAttribute('aria-hidden', 'true');
      group.append(icon);
      group.append(element('text', {x: -51, y: -11, class: 'node-name'}, short(machine.hostname, 20)));
      group.append(element('text', {x: -86, y: 18, class: 'node-detail'}, short(isSwitch ? `${graph.links.filter(link => link.switchId === node.id).length} connected ports` : `${machine.interfaces?.length || 0} interfaces · ${machine.osHint || 'Host'}`, 27)));
      group.append(element('text', {x: -86, y: 36, class: 'node-status'}, node.state.toUpperCase()));
      group.addEventListener('click', () => onSelect(node.id));
      group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id); } });
      nodeLayer.append(group);
    }
    svg.append(nodeLayer);
    container.append(svg);
    return graph;
  }

  return {buildGraph, draw, stateOf};
});
