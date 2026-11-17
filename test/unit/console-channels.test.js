// Second serial console (ttyS1): QEMU arguments, console IDs in the runner commands, per-channel
// buffers and input, pending restart. The runner of one session is driven in memory; no emulator
// is spawned.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createSessionRunner} = require('../../runner/session-runner');
const {commands: consoleCommands} = require('../../runner/commands/consoles');

const root = path.join(__dirname, '..', '..');
const commands = {QEMU_IMG: 'qemu-img', QEMU_SYSTEM_X86_64: 'qemu-system-x86_64', GENISOIMAGE: 'genisoimage'};
const HOST = 'h-0000000000000001';
const SWITCH = 's-0000000000000001';

function setup() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-console-'));
  const runtimeDir = path.join(runtimeRoot, 'sessions', 'test');
  fs.mkdirSync(runtimeDir, {recursive: true});
  const session = {nodes: new Map(), engine: 'qemu', runtimeDir, saveMetadata() {}};
  const runner = createSessionRunner({session, commands, root, runtimeRoot, configPath: path.join(root, 'config.json')});
  return {runner, session, runtimeDir, cleanup: () => fs.rmSync(runtimeRoot, {recursive: true, force: true})};
}

test('QEMU gets a second -serial only when ttyS1 is configured', t => {
  const {runner, runtimeDir, cleanup} = setup();
  t.after(cleanup);
  const preview = (system, settings) => runner.previewLaunch(HOST, {system, engine: 'qemu', settings: JSON.stringify(settings)});
  const two = preview('debian13-legacy', {});
  assert.deepEqual(two.settings.serialPorts, ['ttyS0', 'ttyS1']);
  const line = two.commands.at(-1);
  assert.ok(line.indexOf(`unix:${path.join(runtimeDir, HOST, 'serial0.sock')}`) < line.indexOf(`unix:${path.join(runtimeDir, HOST, 'serial1.sock')}`));
  assert.equal((line.match(/-serial/g) || []).length, 2);
  assert.equal(two.console2.guest, 'ttyS1 · 115200 baud');
  const one = preview('debian13-legacy', {serialPorts: ['ttyS0']});
  assert.equal((one.commands.at(-1).match(/-serial/g) || []).length, 1);
  assert.equal(one.console2, null);
  const alpine = preview('alpine', {});
  assert.deepEqual(alpine.settings.serialPorts, ['ttyS0']);
  assert.equal((alpine.commands.at(-1).match(/-serial/g) || []).length, 1);
  assert.throws(() => preview('alpine', {serialPorts: ['ttyS0', 'ttyS1']}), /This system exposes only ttyS0\./);
});

test('catalog and launch settings expose the serial ports of each system', t => {
  const {runner, cleanup} = setup();
  t.after(cleanup);
  assert.deepEqual(runner.imageById('debian13-legacy').serialPorts, ['ttyS0', 'ttyS1']);
  assert.deepEqual(runner.imageById('openwrt').serialPorts, ['ttyS0']);
  assert.deepEqual(runner.launchSettingsFor('debian13-cloud').serialPorts, ['ttyS0', 'ttyS1']);
  assert.throws(() => runner.limitSerialPorts({serialPorts: ['ttyS0', 'ttyS1']}, 'alpine'), /This system exposes only ttyS0\./);
});

test('console IDs select the buffer, the input socket and the clear of one channel', t => {
  const {runner, session, cleanup} = setup();
  t.after(cleanup);
  const host = runner.createNode(HOST, 'host');
  runner.createNode(SWITCH, 'switch');
  const written = [];
  host.serial = {write: data => written.push([0, data])};
  host.serial1 = {write: data => written.push([1, data])};
  host.serialBuffer = 'zero';
  host.serialBuffer1 = 'one';
  assert.equal(runner.attachConsole(HOST).serial, 'zero');
  assert.equal(runner.attachConsole(HOST).nodeId, HOST);
  assert.equal(runner.attachConsole(`${HOST}:1`).serial, 'one');
  assert.equal(runner.attachConsole(`${HOST}:1`).nodeId, `${HOST}:1`);
  for (const id of [`${HOST}:2`, `${SWITCH}:1`, 'h-00000000000000aa', `h-00000000000000aa:1`, 'bogus']) {
    assert.throws(() => runner.attachConsole(id), /Unknown node/, id);
  }
  runner.writeConsoleInput(host, 'a', 0);
  runner.writeConsoleInput(host, 'b', 1);
  assert.deepEqual(written, [[0, 'a'], [1, 'b']]);

  const events = [];
  runner.events.on('serial-reset', payload => events.push(payload));
  assert.deepEqual(consoleCommands['console.clear']({runner}, {nodeId: `${HOST}:1`, line: 'root@h:~# ', column: 10}), {ok: true});
  assert.equal(host.serialBuffer, 'zero');
  assert.equal(host.serialBuffer1, 'root@h:~# \x1b[11G');
  assert.deepEqual(events, [{nodeId: `${HOST}:1`, preserveLine: true, serial: 'root@h:~# \x1b[11G'}]);
  assert.deepEqual(consoleCommands['console.clear']({runner}, {nodeId: `${HOST}:2`}), {ok: false});
  assert.ok(session.nodes.has(HOST));
});

test('the serial ports are part of the node description and of pending restart', t => {
  const {runner, cleanup} = setup();
  t.after(cleanup);
  const host = runner.createNode(HOST, 'host');
  host.engine = 'qemu';
  host.launchSettings = {memory: 1024, cpus: 1, clock: 'utc', serialPorts: ['ttyS0', 'ttyS1']};
  assert.deepEqual(runner.listNodes()[0].serialPorts, ['ttyS0', 'ttyS1']);
  host.machine = {};
  host.activeConfig = runner.activeConfiguration(host);
  assert.equal(runner.pendingRestart(host), false);
  host.launchSettings = {...host.launchSettings, serialPorts: ['ttyS0']};
  assert.equal(runner.pendingRestart(host), true);
  assert.deepEqual(runner.serialPortsOf(host), ['ttyS0', 'ttyS1'], 'the running VM keeps its two ports until restart');
  host.machine = null;
  assert.deepEqual(runner.serialPortsOf(host), ['ttyS0']);
});
