'use strict';

// QEMU human monitor (HMP) client.
const net = require('net');

function createMonitor(ctx) {
  const {getNode, appendLog} = ctx.runtime;

  // Sends one HMP line and returns the reply text. The monitor's readline echoes the typed line, and
  // redraws the whole line for every character it receives (about 2n² bytes for n characters: 135 KB
  // for a 260-character line), always ending the echo with a line break before the reply. The echo
  // is therefore dropped as it arrives, up to that first line break, and only the reply counts against
  // the size limit; escape sequences are removed from the reply and before looking for the prompt.
  function sendMonitorCommand(node, command) {
    return new Promise((resolve, reject) => {
      const monitor = net.createConnection(node.monitorPath);
      let output = '';
      let sent = false;
      let echoed = false;
      let settled = false;
      const timeout = setTimeout(() => finish(new Error('QEMU command timed out.')), 5000);
      const clean = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        monitor.destroy();
        if (error) reject(error);
        else resolve(clean(output).replace(/(?:^|[\r\n])\(qemu\) ?$/, '').trim());
      }
      monitor.on('data', data => {
        let text = data.toString('utf8');
        if (sent && !echoed) {
          const end = text.indexOf('\n');
          if (end < 0) return;
          echoed = true;
          text = text.slice(end + 1);
        }
        output += text;
        if (output.length > 65536) return finish(new Error('Monitor response is too long.'));
        if (!sent) {
          if (!output.includes('(qemu)')) return;
          sent = true;
          output = '';
          monitor.write(`${command}\n`, error => { if (error) finish(error); });
        } else if (echoed && /(?:^|[\r\n])\(qemu\) ?$/.test(clean(output))) finish();
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

  return {sendMonitorCommand, monitor};
}

module.exports = {createMonitor};
