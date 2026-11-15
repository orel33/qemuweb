'use strict';

// Guest serial console: socket connection, output filtering and buffering, input.
const net = require('net');
const {StringDecoder} = require('string_decoder');
const {filterGuestHookSerial} = require('./guest-hook-filter');

function createSerial(ctx) {
  const {getNode, stateMessage, publishState} = ctx.runtime;

  function connectSerial(node, attempt = 0, generation = node.generation) {
    if (!node.machine || node.stopping || generation !== node.generation || attempt > 100) return;
    const connection = net.createConnection(node.socketPath);
    connection.once('connect', () => {
      // Serial socket chunks can split a UTF-8 character across reads.
      const decoder = new StringDecoder('utf8');
      const emitSerial = text => {
        if (!text) return;
        node.serialBuffer = (node.serialBuffer + text).slice(-262144);
        ctx.events.emit('serial', {nodeId: node.id, data: text});
      };
      const publishSerial = text => emitSerial(filterGuestHookSerial(node, text));
      node.serial = connection;
      publishState(node);
      connection.on('data', data => publishSerial(decoder.write(data)));
      connection.on('close', () => {
        publishSerial(decoder.end());
        emitSerial(node.serialFilterPending);
        node.serialFilterPending = '';
        node.serialFilterPassThrough = false;
        if (node.serial === connection) node.serial = null;
        if (!node.stopping && node.action !== 'reboot' && node.machine) publishState(node, 'Serial console disconnected');
      });
      connection.on('error', error => console.error('serial:', error.message));
    });
    connection.once('error', () => setTimeout(() => connectSerial(node, attempt + 1, generation), 250));
  }

  // Console input from the browser: the guest serial socket, or the VDE terminal of a switch.
  function writeConsoleInput(node, data) {
    if (node.kind === 'switch' && node.switchTerminal) node.switchTerminal.write(data);
    else if (node.serial) node.serial.write(data);
  }

  function resizeSwitchTerminal(node, cols, rows) {
    if (node.kind !== 'switch' || !node.switchTerminal) return;
    try { node.switchTerminal.resize(cols, rows); } catch (_) {}
  }

  function clearConsole(node, line, column) {
    node.serialBuffer = line ? `${line}\x1b[${column + 1}G` : '';
    ctx.events.emit('serial-reset', {nodeId: node.id, preserveLine: true, serial: node.serialBuffer});
  }

  // Current state, logs and serial buffer of a node, sent when a browser selects it.
  function attachConsole(id) {
    const node = getNode(id);
    if (!node) throw new Error('Unknown node.');
    return {
      nodeId: node.id,
      state: {running: !!node.machine, message: stateMessage(node), hasLaunched: node.everStarted},
      logs: node.runLog,
      serial: node.serialBuffer
    };
  }

  return {attachConsole, connectSerial, writeConsoleInput, resizeSwitchTerminal, clearConsole};
}

module.exports = {createSerial};
