// Network node icons. Monitor and network are based on Lucide icons;
// the network icon adds a center child to match the supplied design.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NetworkNodeIcons = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SVG = 'http://www.w3.org/2000/svg';
  const ICONS = {
    host: {
      baseColor: '#2563EB', color: '#70A8FF', badgeFill: '#1b3553',
      shapes: [
        ['rect', {x: 2, y: 3, width: 20, height: 14, rx: 2}],
        ['line', {x1: 8, x2: 16, y1: 21, y2: 21}],
        ['line', {x1: 12, x2: 12, y1: 17, y2: 21}]
      ]
    },
    switch: {
      baseColor: '#16A34A', color: '#57DC91', badgeFill: '#1d3d2c',
      shapes: [
        ['rect', {x: 2, y: 7, width: 20, height: 10, rx: 2}],
        ['rect', {x: 4.5, y: 10, width: 3, height: 4, rx: 0.5}],
        ['rect', {x: 8.5, y: 10, width: 3, height: 4, rx: 0.5}],
        ['rect', {x: 12.5, y: 10, width: 3, height: 4, rx: 0.5}],
        ['rect', {x: 16.5, y: 10, width: 3, height: 4, rx: 0.5}]
      ]
    },
    network: {
      baseColor: '#9333EA', color: '#C49AFF', badgeFill: '#35254a',
      shapes: [
        ['rect', {x: 9, y: 2, width: 6, height: 6, rx: 1}],
        ['rect', {x: 2, y: 16, width: 5, height: 6, rx: 1}],
        ['rect', {x: 9.5, y: 16, width: 5, height: 6, rx: 1}],
        ['rect', {x: 17, y: 16, width: 5, height: 6, rx: 1}],
        ['path', {d: 'M12 8v4M4.5 16v-3a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v3M12 12v4'}]
      ]
    }
  };
  const styles = Object.freeze(Object.fromEntries(Object.entries(ICONS).map(([type, icon]) =>
    [type, Object.freeze({baseColor: icon.baseColor, color: icon.color, badgeFill: icon.badgeFill})]
  )));

  function typeForMachine(kind) {
    return kind === 'switch' ? 'switch' : 'host';
  }

  function apply(svg, type) {
    const icon = ICONS[type];
    if (!icon) throw new RangeError(`Unknown network node icon: ${type}`);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', icon.color);
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.replaceChildren(...icon.shapes.map(([tag, attributes]) => {
      const shape = document.createElementNS(SVG, tag);
      for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, String(value));
      return shape;
    }));
    return svg;
  }

  function create(type, size = 24) {
    const svg = apply(document.createElementNS(SVG, 'svg'), type);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    return svg;
  }

  function applyAdd(svg, type) {
    apply(svg, type);
    const glyph = document.createElementNS(SVG, 'g');
    glyph.setAttribute('transform', 'translate(0 5) scale(0.75)');
    while (svg.firstChild) glyph.append(svg.firstChild);
    svg.append(glyph);
    const plus = document.createElementNS(SVG, 'path');
    plus.setAttribute('d', 'M20 2v6M17 5h6');
    svg.append(plus);
    return svg;
  }

  return {styles, typeForMachine, apply, applyAdd, create};
});
