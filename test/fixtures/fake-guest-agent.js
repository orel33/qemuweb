'use strict';

// A fake qemu-ga for the guest agent tests (test/unit/guest-agent.test.js, guest-agent-cli.test.js): no QEMU, no VM.
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fixtures = require('./guest-agent-replies');

// A fake qemu-ga on a Unix socket qga.sock, in a new temporary directory or in `directory` (then left to the caller). mode: ok | silent | no-command | huge | malformed | error | wrong-sync
async function startFakeAgent(t, mode, value = fixtures.debianLegacy, {directory = null} = {}) {
  const own = directory === null;
  if (own) directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-qga-'));
  const file = path.join(directory, 'qga.sock');
  const seen = [];
  const server = net.createServer(connection => {
    let pending = '';
    let open = true;
    connection.on('close', () => { open = false; });
    connection.on('error', () => {});
    connection.on('data', chunk => {
      if (mode === 'silent') return;
      pending += chunk.toString('latin1');
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).replace(/^\xff+/, '');
        pending = pending.slice(end + 1);
        const request = JSON.parse(line);
        seen.push(request.execute);
        if (request.execute === 'guest-sync-delimited') {
          connection.write(Buffer.from(`\xff${JSON.stringify({return: mode === 'wrong-sync' ? request.arguments.id + 1 : request.arguments.id})}\n`, 'latin1'));
        } else if (mode === 'no-command') {
          // answers the handshake, never the command
        } else if (mode === 'huge') {
          const block = Buffer.alloc(16384, 0x41);
          const flood = () => { while (open && connection.write(block)); if (open) connection.once('drain', flood); };
          flood();
        } else if (mode === 'malformed') connection.write('this is not json\n');
        else if (mode === 'error') connection.write(`${JSON.stringify({error: {class: 'CommandNotFound', desc: 'Command has been disabled'}})}\n`);
        else connection.write(`${JSON.stringify({return: value})}\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(file, resolve));
  t.after(() => { server.close(); if (own) fs.rmSync(directory, {recursive: true, force: true}); });
  return {file, seen};
}

module.exports = {startFakeAgent};
