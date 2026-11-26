// sendMonitorCommand (runner/engines/qemu-monitor.js) against a fake HMP monitor on a Unix socket:
// no QEMU is started. The fake behaves like QEMU's readline: it echoes every typed character by
// redrawing the whole line with escape sequences (about 2n² bytes for a line of n characters), ends
// the echo with a line break, then sends the reply and the prompt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createMonitor} = require('../../runner/engines/qemu-monitor');

const BANNER = "QEMU 11.1.3 monitor - type 'help' for more information\r\n(qemu) ";

async function fakeMonitor(t, reply) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-mon-'));
  const socket = path.join(dir, 'mon.sock');
  const server = net.createServer(connection => {
    connection.write(BANNER);
    let line = '';
    connection.on('data', data => {
      for (const character of data.toString('utf8')) {
        if (character === '\n') {
          connection.write(`\r\n${reply(line)}(qemu) `);
          line = '';
        } else {
          line += character;
          connection.write(`${line}\x1b[K${'\x1b[D'.repeat(line.length)}`);
        }
      }
    });
    connection.on('error', () => {});
  });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => { server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  const {sendMonitorCommand} = createMonitor({runtime: {getNode() {}, appendLog() {}}});
  return command => sendMonitorCommand({monitorPath: socket}, command);
}

test('a long command line, echoed with escape sequences, still gets its reply', async t => {
  const send = await fakeMonitor(t, () => '');
  const base = 'object_add filter-dump,id=cap-eth0-20261119T232602Z,netdev=lan0,file=/tmp/qemuweb-demo-uGPrRN/runtime/sessions/9880ad4a/h-b2f98c44/captures/eth0-20261119T232602Z.pcap,queue=all,';
  const command = base + 'x'.repeat(280 - base.length);
  assert.equal(command.length, 280);
  // The echo alone is far above the 65536 characters of a reply.
  assert.ok(2 * command.length ** 2 > 65536);
  assert.equal(await send(command), '');
  assert.equal(await send('x'.repeat(300)), '', 'a 300-character line');
});

test('the reply of a long command is kept, without escape sequences or the prompt', async t => {
  const send = await fakeMonitor(t, line => `Error: unknown ${line.length} \x1b[1mchars\x1b[0m\r\n`);
  assert.equal(await send('y'.repeat(300)), 'Error: unknown 300 chars');
  assert.equal(await send('info status'), 'Error: unknown 11 chars');
});

test('a short command and a multi-line reply behave as before', async t => {
  const send = await fakeMonitor(t, () => 'line one\r\nline two\r\n');
  assert.equal(await send('info network'), 'line one\r\nline two');
});

test('the size limit still applies to the reply itself', async t => {
  const send = await fakeMonitor(t, () => `${'z'.repeat(70000)}\r\n`);
  await assert.rejects(send('info big'), /Monitor response is too long/);
});

test('a monitor that closes without a prompt fails', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-mon-'));
  const socket = path.join(dir, 'mon.sock');
  const server = net.createServer(connection => connection.end('no prompt here'));
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => { server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  const {sendMonitorCommand} = createMonitor({runtime: {getNode() {}, appendLog() {}}});
  await assert.rejects(sendMonitorCommand({monitorPath: socket}, 'info'), /closed/);
});
