'use strict';

// QEMU human monitor (HMP) client.
const net = require('net');
const {getNode, appendLog} = require('../session-runtime');

function sendMonitorCommand(node, command) {
  return new Promise((resolve, reject) => {
    const monitor = net.createConnection(node.monitorPath);
    let output = '';
    let sent = false;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('QEMU command timed out.')), 5000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      monitor.destroy();
      if (error) reject(error);
      else {
        const reply = output.slice(output.indexOf('\n') + 1).replace(/(?:^|[\r\n])\(qemu\) ?$/, '').trim();
        resolve(reply);
      }
    }
    monitor.on('data', data => {
      output += data.toString('utf8');
      if (output.length > 65536) return finish(new Error('Monitor response is too long.'));
      if (!sent && output.includes('(qemu)')) {
        sent = true;
        output = '';
        monitor.write(`${command}\n`, error => { if (error) finish(error); });
      } else if (sent && output.includes('\n') && /(?:^|[\r\n])\(qemu\) ?$/.test(output.slice(output.indexOf('\n') + 1))) finish();
    });
    monitor.once('error', finish);
    monitor.once('close', () => { if (!settled) finish(new Error('QEMU monitor connection closed.')); });
  });
}

// Runs one command on the monitor of a running QEMU host, logging it and its output.
async function monitor(nodeId, command) {
  const node = getNode(nodeId);
  if (!node || node.kind !== 'host' || !node.machine || !node.engine.startsWith('qemu') || node.action) throw new Error('Monitor is available only for a running QEMU host.');
  if (typeof command !== 'string' || !command.trim() || command.length > 256 || /[\r\n\x00-\x1f\x7f]/.test(command)) throw new Error('Enter a single-line QEMU command (maximum 256 characters).');
  appendLog(node, `$ monitor: ${command}`);
  const output = await sendMonitorCommand(node, command);
  appendLog(node, output || '(no output)');
  return output;
}

module.exports = {sendMonitorCommand, monitor};
