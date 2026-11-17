'use strict';

// Guest serial consoles: socket connections, output filtering and buffering, input. A host has
// one console per serial port (channel 0 = ttyS0, channel 1 = ttyS1); a console is named by a
// console ID (common/console-id.js): the node ID for channel 0, '<node ID>:1' for channel 1.
const net = require('net');
const {StringDecoder} = require('string_decoder');
const {baseNodeId, consoleChannel, consoleId} = require('../../common/console-id');
const {filterGuestHookSerial} = require('./guest-hook-filter');

// Node fields of each channel: the QEMU socket path, the connection and the replay buffer.
const CHANNELS = [
  {socketPath: 'socketPath', connection: 'serial', buffer: 'serialBuffer'},
  {socketPath: 'socketPath1', connection: 'serial1', buffer: 'serialBuffer1'}
];

function createSerial(ctx) {
  const {getNode, stateMessage, publishState, consoleCount} = ctx.runtime;

  function connectSerial(node) {
    const channels = node.engine?.startsWith('qemu') ? consoleCount(node) : 1;
    for (let channel = 0; channel < channels; channel++) connectChannel(node, channel, 0, node.generation);
  }

  function connectChannel(node, channel, attempt, generation) {
    if (!node.machine || node.stopping || generation !== node.generation || attempt > 100) return;
    const fields = CHANNELS[channel];
    const connection = net.createConnection(node[fields.socketPath]);
    connection.once('connect', () => {
      // Serial socket chunks can split a UTF-8 character across reads.
      const decoder = new StringDecoder('utf8');
      const emitSerial = text => {
        if (!text) return;
        node[fields.buffer] = (node[fields.buffer] + text).slice(-262144);
        ctx.events.emit('serial', {nodeId: consoleId(node.id, channel), data: text});
      };
      // Only the boot console (ttyS0) carries the startup hook's marker lines.
      const publishSerial = text => emitSerial(channel === 0 ? filterGuestHookSerial(node, text) : text);
      node[fields.connection] = connection;
      if (ctx.flow.paused) connection.pause();
      if (channel === 0) publishState(node);
      connection.on('data', data => publishSerial(decoder.write(data)));
      connection.on('close', () => {
        publishSerial(decoder.end());
        if (channel === 0) {
          emitSerial(node.serialFilterPending);
          node.serialFilterPending = '';
          node.serialFilterPassThrough = false;
        }
        if (node[fields.connection] === connection) node[fields.connection] = null;
        if (channel === 0 && !node.stopping && node.action !== 'reboot' && node.machine) publishState(node, 'Serial console disconnected');
      });
      connection.on('error', error => console.error('serial:', error.message));
    });
    connection.once('error', () => setTimeout(() => connectChannel(node, channel, attempt + 1, generation), 250));
  }

  function closeSerial(node) {
    for (const fields of CHANNELS) {
      if (node[fields.connection]) { node[fields.connection].destroy(); node[fields.connection] = null; }
    }
  }

  // Console input from the browser: the guest serial socket of a channel, or the VDE terminal of a switch.
  function writeConsoleInput(node, data, channel = 0) {
    if (node.kind === 'switch' && node.switchTerminal) node.switchTerminal.write(data);
    else if (node[CHANNELS[channel].connection]) node[CHANNELS[channel].connection].write(data);
  }

  function resizeSwitchTerminal(node, cols, rows) {
    if (node.kind !== 'switch' || !node.switchTerminal) return;
    try { node.switchTerminal.resize(cols, rows); } catch (_) {}
  }

  function clearConsole(node, line, column, channel = 0) {
    const buffer = CHANNELS[channel].buffer;
    node[buffer] = line ? `${line}\x1b[${column + 1}G` : '';
    ctx.events.emit('serial-reset', {nodeId: consoleId(node.id, channel), preserveLine: true, serial: node[buffer]});
  }

  // The node and channel of a console ID, or null when the session has no such console. A
  // console ID of channel 1 is accepted for any host: a system without ttyS1 has an empty one.
  function resolveConsole(id) {
    const channel = consoleChannel(id);
    const node = channel === null ? null : getNode(baseNodeId(id));
    return node && (channel === 0 || node.kind === 'host') ? {node, channel} : null;
  }

  // Current state, logs and serial buffer of a console, sent when a browser selects it.
  function attachConsole(id) {
    const target = resolveConsole(id);
    if (!target) throw new Error('Unknown node.');
    const {node, channel} = target;
    return {
      nodeId: id,
      state: {running: !!node.machine, message: stateMessage(node), hasLaunched: node.everStarted},
      logs: node.runLog,
      serial: node[CHANNELS[channel].buffer]
    };
  }

  // Pauses or resumes every console source of the session (serial sockets, switch terminals)
  // while the control connection is congested; nothing is dropped.
  function setConsoleFlow(paused) {
    for (const node of ctx.session.nodes.values()) {
      const sources = node.kind === 'switch' ? [node.switchTerminal] : CHANNELS.map(fields => node[fields.connection]);
      for (const source of sources) {
        if (!source) continue;
        try { if (paused) source.pause(); else source.resume(); } catch (_) {}
      }
    }
  }

  return {attachConsole, resolveConsole, setConsoleFlow, connectSerial, closeSerial, writeConsoleInput, resizeSwitchTerminal, clearConsole};
}

module.exports = {createSerial};
