'use strict';

// Node positions of the Graphic view (session data, common/graphic-layout.js). The control
// plane decides who may move a node (one driver at a time, server/sockets.js node-position);
// the runner validates again and keeps the positions in layout.json.
const {normalizePosition} = require('../../common/graphic-layout');

const commands = {
  // {positions: {nodeId: {x, y}}}: the positions of the session's nodes.
  'layout.get': ({session}) => ({positions: Object.fromEntries(session.positions)}),

  // Sets the position of one node of the session: {nodeId, x, y}.
  'layout.set': ({session}, {nodeId, x, y}) => {
    const position = normalizePosition({x, y});
    if (typeof nodeId !== 'string' || !session.nodes.has(nodeId)) throw new Error('Unknown node.');
    if (!position) throw new Error('Invalid node position.');
    session.setPosition(nodeId, position);
    return {ok: true};
  }
};

module.exports = {commands};
