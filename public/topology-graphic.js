// Topology overview: layout, link routing and SVG drawing. Positions are in a world coordinate
// system that does not depend on the zoom (the SVG viewport group carries the pan and zoom), so
// there is no frame and no edge: a node can be anywhere. Node positions are browser-local during
// ordinary use; the explicit session archive can carry them to another browser.
(function (root, factory) {
  const icons = typeof module === 'object' && module.exports ? require('./network-node-icons') : root.NetworkNodeIcons;
  const api = factory(icons);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TopologyGraphic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (NodeIcons) {
  const SVG = 'http://www.w3.org/2000/svg';
  const CARD_WIDTH = 244;
  const CARD_HEIGHT = 112;
  const GAP_X = 56;
  const ROW_GAP = 120;
  const MAX_PER_ROW = 6;
  const SHELF_WIDTH = 2600;

  function stateOf(machine) {
    if (machine.error) return 'error';
    if (machine.busy) return machine.operation || 'starting';
    if (machine.running) return 'running';
    return machine.hasLaunched ? 'stopped' : 'ready';
  }

  // ---- Default placement -------------------------------------------------------------------
  // Each connected component is laid out in layers: the BFS levels from its most central node
  // (hosts and switches alternate), ordered by the barycenter of their neighbours to reduce
  // crossings. A level wider than MAX_PER_ROW cards wraps into several rows. Components are
  // packed left to right in shelves.
  function components(ids, adjacency) {
    const seen = new Set();
    const result = [];
    for (const start of ids) {
      if (seen.has(start)) continue;
      const members = [start];
      seen.add(start);
      for (let index = 0; index < members.length; index++) {
        for (const next of adjacency.get(members[index])) if (!seen.has(next)) { seen.add(next); members.push(next); }
      }
      result.push(members);
    }
    return result;
  }

  function levelsFrom(root, adjacency) {
    const depth = new Map([[root, 0]]);
    const queue = [root];
    for (let index = 0; index < queue.length; index++) {
      for (const next of adjacency.get(queue[index])) if (!depth.has(next)) { depth.set(next, depth.get(queue[index]) + 1); queue.push(next); }
    }
    return {depth, order: queue, height: depth.get(queue[queue.length - 1])};
  }

  function layoutComponent(members, adjacency) {
    let best = null;
    for (const candidate of members) {
      const {height} = levelsFrom(candidate, adjacency);
      const degree = adjacency.get(candidate).size;
      if (!best || height < best.height || (height === best.height && degree > best.degree)) best = {id: candidate, height, degree};
    }
    const {depth, order} = levelsFrom(best.id, adjacency);
    const levels = [];
    for (const id of order) (levels[depth.get(id)] ||= []).push(id);
    const index = new Map();
    const reindex = () => levels.forEach(level => level.forEach((id, i) => index.set(id, i / Math.max(1, level.length - 1))));
    reindex();
    const sweep = (level, reference) => {
      const key = id => {
        const refs = [...adjacency.get(id)].filter(other => depth.get(other) === reference);
        return refs.length ? refs.reduce((sum, other) => sum + index.get(other), 0) / refs.length : index.get(id);
      };
      const keys = new Map(level.map(id => [id, key(id)]));
      level.sort((a, b) => keys.get(a) - keys.get(b));
    };
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 1; i < levels.length; i++) { sweep(levels[i], i - 1); reindex(); }
      for (let i = levels.length - 2; i >= 0; i--) { sweep(levels[i], i + 1); reindex(); }
    }
    const positions = new Map();
    let y = 0;
    let width = 0;
    for (const level of levels) {
      const rows = Math.ceil(level.length / MAX_PER_ROW);
      const perRow = Math.ceil(level.length / rows);
      for (let row = 0; row < rows; row++) {
        const items = level.slice(row * perRow, (row + 1) * perRow);
        const rowWidth = items.length * (CARD_WIDTH + GAP_X) - GAP_X;
        width = Math.max(width, rowWidth);
        items.forEach((id, i) => positions.set(id, {x: -rowWidth / 2 + CARD_WIDTH / 2 + i * (CARD_WIDTH + GAP_X), y}));
        y += CARD_HEIGHT + ROW_GAP * (rows > 1 && row < rows - 1 ? 0.35 : 1);
      }
    }
    return {positions, width, height: y - ROW_GAP};
  }

  function autoLayout(machines) {
    const adjacency = new Map(machines.map(machine => [machine.id, new Set()]));
    for (const machine of machines) {
      if (machine.kind === 'switch') continue;
      for (const switchId of machine.interfaces || []) {
        if (!switchId || !adjacency.has(switchId)) continue;
        adjacency.get(machine.id).add(switchId);
        adjacency.get(switchId).add(machine.id);
      }
    }
    const placed = components(machines.map(machine => machine.id), adjacency)
      .map(members => layoutComponent(members, adjacency))
      .sort((a, b) => b.positions.size - a.positions.size);
    const result = new Map();
    let shelfX = 0;
    let shelfY = 0;
    let shelfHeight = 0;
    for (const part of placed) {
      if (shelfX > 0 && shelfX + part.width > SHELF_WIDTH) { shelfX = 0; shelfY += shelfHeight + ROW_GAP; shelfHeight = 0; }
      for (const [id, position] of part.positions) {
        result.set(id, {x: CARD_WIDTH / 2 + 40 + shelfX + part.width / 2 + position.x, y: CARD_HEIGHT / 2 + 40 + shelfY + position.y});
      }
      shelfX += part.width + GAP_X * 2;
      shelfHeight = Math.max(shelfHeight, part.height + CARD_HEIGHT);
    }
    return result;
  }

  // ---- Link routing --------------------------------------------------------------------------
  const NORMALS = {top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0]};

  // The edge of a card a link leaves by: the one the straight line between the card centers
  // crosses.
  function sidesFor(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dy) * CARD_WIDTH >= Math.abs(dx) * CARD_HEIGHT) return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
    return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  }

  // Spreads the links of one card edge along it, ordered by where their other end is, so that
  // links leaving the same edge do not cross each other.
  function spreadAttachments(attachments) {
    const groups = new Map();
    for (const item of attachments) {
      const key = `${item.nodeId}:${item.side}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const group of groups.values()) {
      const vertical = group[0].side === 'top' || group[0].side === 'bottom';
      group.sort((a, b) => (vertical ? a.other.x - b.other.x : a.other.y - b.other.y) || a.order - b.order);
      const length = vertical ? CARD_WIDTH : CARD_HEIGHT;
      const step = group.length < 2 ? 0 : Math.min(52, (length - 56) / (group.length - 1));
      group.forEach((item, index) => { item.offset = (index - (group.length - 1) / 2) * step; });
    }
  }

  function endpoint(node, side, offset) {
    const half = side === 'top' || side === 'bottom' ? [offset, CARD_HEIGHT / 2 * (side === 'top' ? -1 : 1)] : [CARD_WIDTH / 2 * (side === 'left' ? -1 : 1), offset];
    return {x: node.x + half[0], y: node.y + half[1]};
  }

  function routeLinks(links, nodes) {
    const attachments = [];
    for (const link of links) {
      const host = nodes.get(link.hostId);
      const sw = nodes.get(link.switchId);
      [link.hostSide, link.switchSide] = sidesFor(host, sw);
      link.hostEnd = {nodeId: link.hostId, side: link.hostSide, other: sw, order: link.nicIndex * 1000 + (link.port ?? 0), link};
      link.switchEnd = {nodeId: link.switchId, side: link.switchSide, other: host, order: (link.port ?? 1e6) * 1000 + link.nicIndex, link};
      attachments.push(link.hostEnd, link.switchEnd);
    }
    spreadAttachments(attachments);
    for (const link of links) {
      const a = endpoint(nodes.get(link.hostId), link.hostSide, link.hostEnd.offset);
      const b = endpoint(nodes.get(link.switchId), link.switchSide, link.switchEnd.offset);
      link.x1 = a.x; link.y1 = a.y; link.x2 = b.x; link.y2 = b.y;
      const reach = Math.max(36, Math.min(150, Math.hypot(b.x - a.x, b.y - a.y) / 2));
      const n1 = NORMALS[link.hostSide];
      const n2 = NORMALS[link.switchSide];
      link.path = `M ${a.x} ${a.y} C ${a.x + n1[0] * reach} ${a.y + n1[1] * reach}, ${b.x + n2[0] * reach} ${b.y + n2[1] * reach}, ${b.x} ${b.y}`;
      link.hostLabel = labelAt(a, n1);
      link.portLabel = labelAt(b, n2);
      delete link.hostEnd; delete link.switchEnd;
    }
  }

  // Where the label of a link end goes: just outside the card, next to the attachment point.
  function labelAt(point, normal) {
    if (normal[0] !== 0) return {x: point.x + normal[0] * 8, y: point.y - 7, anchor: normal[0] > 0 ? 'start' : 'end'};
    return {x: point.x, y: point.y + (normal[1] < 0 ? -8 : 17), anchor: 'middle'};
  }

  // ---- Graph ---------------------------------------------------------------------------------
  // options.specs(machine) gives {memory, cpus} of a host (MB, vCPUs) when known.
  function buildGraph(inputNodes, positions = new Map(), options = {}) {
    const machines = [...inputNodes];
    const defaults = autoLayout(machines);
    const byId = new Map(machines.map(machine => [machine.id, machine]));
    const nodes = new Map();
    for (const machine of machines) {
      const place = defaults.get(machine.id);
      const stored = positions.get(machine.id);
      const manual = Number.isFinite(stored?.x) && Number.isFinite(stored?.y);
      nodes.set(machine.id, {
        id: machine.id, machine, state: stateOf(machine), manual,
        x: manual ? stored.x : place.x, y: manual ? stored.y : place.y,
        specs: machine.kind === 'switch' ? null : (options.specs?.(machine) || null)
      });
    }
    const links = [];
    for (const machine of machines) {
      if (machine.kind === 'switch') continue;
      (machine.interfaces || []).forEach((switchId, nicIndex) => {
        if (!switchId || byId.get(switchId)?.kind !== 'switch') return;
        const portInfo = machine.networkInterfaces?.[nicIndex];
        links.push({hostId: machine.id, switchId, nicIndex, port: portInfo?.switchId === switchId ? portInfo.port : null});
      });
    }
    routeLinks(links, nodes);
    const hosts = machines.filter(machine => machine.kind !== 'switch').length;
    return {nodes: [...nodes.values()], links, hosts, switches: machines.length - hosts};
  }

  // The bounding box of the cards, in world coordinates, or null for an empty graph.
  function boundsOf(graph) {
    if (!graph.nodes.length) return null;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const node of graph.nodes) {
      minX = Math.min(minX, node.x - CARD_WIDTH / 2); maxX = Math.max(maxX, node.x + CARD_WIDTH / 2);
      minY = Math.min(minY, node.y - CARD_HEIGHT / 2 - 18); maxY = Math.max(maxY, node.y + CARD_HEIGHT / 2 + 18);
    }
    return {minX, minY, maxX, maxY};
  }

  // ---- Drawing -------------------------------------------------------------------------------
  function element(tag, attrs = {}, value) {
    const node = document.createElementNS(SVG, tag);
    for (const [key, attribute] of Object.entries(attrs)) node.setAttribute(key, String(attribute));
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function short(value, limit) {
    const text = String(value || '');
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  function memoryText(megabytes) {
    return megabytes >= 1024 ? `${Math.round(megabytes / 102.4) / 10} GB` : `${megabytes} MB`;
  }

  // The text lines of a node card (and its tooltip): what the machine is, what it has, how it
  // is connected. No IP address: none is known without a guest agent.
  function describe(node, graph) {
    const machine = node.machine;
    const isSwitch = machine.kind === 'switch';
    const mine = graph.links.filter(link => (isSwitch ? link.switchId : link.hostId) === node.id);
    const nicCount = isSwitch ? mine.length : (machine.interfaces || []).length;
    const byId = id => graph.nodes.find(item => item.id === id)?.machine;
    const specs = [];
    if (node.specs?.memory) specs.push(memoryText(node.specs.memory));
    if (node.specs?.cpus) specs.push(`${node.specs.cpus} vCPU`);
    const interfaces = isSwitch
      ? mine.map(link => `port ${link.port ?? '?'}: ${byId(link.hostId)?.hostname} eth${link.nicIndex}`)
      : (machine.interfaces || []).map((switchId, index) => {
        const sw = byId(switchId);
        const port = machine.networkInterfaces?.[index]?.port;
        return `eth${index}: ${sw ? `${sw.hostname}${port == null ? '' : ` port ${port}`}` : 'not connected'}`;
      });
    return {
      kind: isSwitch ? 'VDE switch' : (machine.osHint || 'Host'),
      resources: isSwitch ? `${mine.length} port${mine.length === 1 ? '' : 's'} in use` : (specs.join(' · ') || 'Resources unknown'),
      links: isSwitch ? '' : `${mine.length}/${nicCount} NIC${nicCount === 1 ? '' : 's'} linked`,
      interfaces
    };
  }

  function drawNode(node, graph, selectedId, recording) {
    const machine = node.machine;
    const isSwitch = machine.kind === 'switch';
    const iconType = NodeIcons.typeForMachine(machine.kind);
    const iconStyle = NodeIcons.styles[iconType];
    const info = describe(node, graph);
    const group = element('g', {class: `topology-node ${isSwitch ? 'topology-switch' : 'topology-host'}`, transform: `translate(${node.x}, ${node.y})`, tabindex: '0', role: 'button',
      'aria-label': `${machine.hostname}, ${isSwitch ? 'switch' : 'host'}, ${node.state}. Enter opens its console.`, 'aria-pressed': String(node.id === selectedId)});
    group.dataset.nodeId = node.id;
    group.dataset.state = node.state;
    if (node.id === selectedId) group.classList.add('is-selected');
    const left = -CARD_WIDTH / 2;
    const top = -CARD_HEIGHT / 2;
    group.append(element('rect', {x: left, y: top, width: CARD_WIDTH, height: CARD_HEIGHT, rx: 12, class: 'node-card'}));
    group.append(element('rect', {x: left, y: top, width: 6, height: CARD_HEIGHT, rx: 3, fill: iconStyle.color}));
    group.append(element('circle', {cx: left + 34, cy: top + 28, r: 17, fill: iconStyle.badgeFill}));
    const icon = NodeIcons.create(iconType);
    icon.setAttribute('x', String(left + 22));
    icon.setAttribute('y', String(top + 16));
    icon.setAttribute('aria-hidden', 'true');
    group.append(icon);
    group.append(element('text', {x: left + 60, y: top + 34, class: 'node-name'}, short(machine.hostname, 18)));
    const detail = (y, text, extra = {}) => group.append(element('text', {x: left + 20, y: top + y, class: 'node-detail', ...extra}, text));
    detail(58, short(info.kind, 34));
    detail(76, info.resources);
    group.append(element('circle', {cx: left + 25, cy: top + 94, r: 4.5, class: 'node-dot'}));
    group.append(element('text', {x: left + 36, y: top + 98, class: 'node-status'}, node.state.toUpperCase()));
    if (info.links) group.append(element('text', {x: -left - 14, y: top + 98, class: 'node-detail', 'text-anchor': 'end'}, info.links));
    if (recording?.node(node.id)) {
      group.classList.add('is-recording');
      group.append(recordingMark(-left - 22, top + 18));
    }
    return group;
  }

  // The "recording" sign: a red dot (it pulses unless the user asks for less motion) and REC.
  function recordingMark(x, y) {
    const mark = element('g', {class: 'rec-mark', transform: `translate(${x}, ${y})`});
    mark.append(element('circle', {r: 5, class: 'rec-dot'}), element('text', {x: -9, y: 4, 'text-anchor': 'end', class: 'rec-text'}, 'REC'), element('title', {}, 'Recording a capture'));
    return mark;
  }

  function drawLink(link, graph, selectedLink, recording) {
    const group = element('g', {class: 'topology-link'});
    group.dataset.linkId = `${link.hostId}:${link.nicIndex}`;
    if (selectedLink === group.dataset.linkId) group.classList.add('is-selected');
    group.append(element('path', {d: link.path, class: 'link-hit'}));
    group.append(element('path', {d: link.path, class: 'link-line'}));
    const host = graph.nodes.find(node => node.id === link.hostId).machine;
    const sw = graph.nodes.find(node => node.id === link.switchId).machine;
    const text = (label, content) => element('text', {x: label.x, y: label.y, 'text-anchor': label.anchor, class: 'link-label'}, content);
    group.append(text(link.hostLabel, `eth${link.nicIndex}`), text(link.portLabel, link.port == null ? 'port?' : `#${link.port}`));
    group.append(element('title', {}, `${host.hostname} eth${link.nicIndex} ↔ ${sw.hostname}${link.port == null ? '' : ` port ${link.port}`}`));
    if (recording?.link(link.hostId, link.nicIndex)) {
      group.classList.add('is-recording');
      group.append(recordingMark((link.x1 + link.x2) / 2, (link.y1 + link.y2) / 2));
    }
    return group;
  }

  // Replaces the drawing in `container` (other children, such as the tooltip, stay). view is the
  // {x, y, k} of the viewport: a translation in pixels and the zoom factor.
  function draw(container, nodes, positions, options = {}) {
    const graph = buildGraph(nodes, positions, options);
    for (const old of container.querySelectorAll(':scope > .topology-svg, :scope > .graphic-empty')) old.remove();
    if (!graph.nodes.length) {
      const empty = document.createElement('div');
      empty.className = 'graphic-empty';
      empty.innerHTML = '<img src="/favicon.svg" alt=""><h2>No network yet</h2><p>Add a host or switch, or load a .topo file to see it here.</p>';
      container.prepend(empty);
      return graph;
    }
    const view = options.view || {x: 0, y: 0, k: 1};
    const svg = element('svg', {role: 'group', 'aria-label': `Network topology: ${graph.hosts} hosts, ${graph.switches} switches, ${graph.links.length} connected interfaces`});
    svg.classList.add('topology-svg');
    const viewport = element('g', {class: 'topology-viewport'});
    const links = element('g', {class: 'topology-links'});
    for (const link of graph.links) links.append(drawLink(link, graph, options.selectedLink, options.recording));
    const layer = element('g', {class: 'topology-nodes'});
    for (const node of graph.nodes) layer.append(drawNode(node, graph, options.selectedId, options.recording));
    viewport.append(links, layer);
    svg.append(viewport);
    container.prepend(svg);
    applyView(svg, view);
    return graph;
  }

  // Pans and zooms an already drawn SVG without redrawing it.
  function applyView(svg, view) {
    svg.querySelector('.topology-viewport')?.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    svg.dataset.zoom = view.k < 0.6 ? 'far' : 'near';
  }

  return {CARD_WIDTH, CARD_HEIGHT, buildGraph, boundsOf, describe, draw, applyView, stateOf};
});
