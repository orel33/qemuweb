'use strict';

// The system list and the launch preview with the VirtualBox engine (BUG: after the engine of a
// session changed, the Host Settings dialog was empty because the page still held the QEMU
// profiles: debian13-legacy offered ttyS0 and ttyS1, which the VirtualBox profile refuses).
// The runner of one session is driven in memory; nothing is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createSessionRunner} = require('../../runner/session-runner');
const {commands: settingsCommands} = require('../../runner/commands/settings');
const {moduleSource} = require('./web-ui-source');

const root = path.join(__dirname, '..', '..');
const commands = {QEMU_IMG: 'qemu-img', QEMU_SYSTEM_X86_64: 'qemu-system-x86_64', GENISOIMAGE: 'genisoimage', VBOXMANAGE: 'VBoxManage'};
const HOST = 'h-0000000000000001';

function setup(engine) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-vbox-systems-'));
  const runtimeDir = path.join(runtimeRoot, 'sessions', 'test');
  fs.mkdirSync(runtimeDir, {recursive: true});
  const session = {nodes: new Map(), engine, runtimeDir, saveMetadata() {}};
  const runner = createSessionRunner({session, commands, root, runtimeRoot, configPath: path.join(root, 'config.json')});
  return {runner, session, cleanup: () => fs.rmSync(runtimeRoot, {recursive: true, force: true})};
}

test('the VirtualBox system list gives every system a profile with memory, cpus, clock and serial ports', t => {
  const {runner, session, cleanup} = setup('vbox');
  t.after(cleanup);
  const systems = settingsCommands['catalog.systems']({session, runner});
  assert.ok(systems.length >= 4);
  for (const system of systems) {
    assert.ok(Number.isInteger(system.memory) && Number.isInteger(system.cpus), system.id);
    assert.ok(['utc', 'localtime'].includes(system.clock), system.id);
    assert.deepEqual(system.serialPorts, ['ttyS0'], `${system.id}: VirtualBox hosts have a single console`);
  }
});

test('the profiles of the two engines differ, so a draft built with one is refused by the other', t => {
  const qemu = setup('qemu');
  const vbox = setup('vbox');
  t.after(qemu.cleanup);
  t.after(vbox.cleanup);
  const qemuLegacy = settingsCommands['catalog.systems'](qemu).find(system => system.id === 'debian13-legacy');
  const vboxLegacy = settingsCommands['catalog.systems'](vbox).find(system => system.id === 'debian13-legacy');
  assert.deepEqual(qemuLegacy.serialPorts, ['ttyS0', 'ttyS1']);
  assert.deepEqual(vboxLegacy.serialPorts, ['ttyS0']);
  const preview = settings => vbox.runner.previewLaunch(HOST, {system: 'debian13-legacy', engine: 'vbox', settings: JSON.stringify(settings)});
  assert.throws(() => preview({serialPorts: qemuLegacy.serialPorts}), /This system exposes only ttyS0\./, 'the stale QEMU draft that emptied the dialog');
  assert.equal(preview({serialPorts: vboxLegacy.serialPorts}).engine, 'vbox');
});

test('the launch preview of a new VirtualBox host works for every system from its own profile', t => {
  const {runner, session, cleanup} = setup('vbox');
  t.after(cleanup);
  for (const system of settingsCommands['catalog.systems']({session, runner})) {
    const settings = {memory: system.memory, cpus: system.cpus, clock: system.clock, serialPorts: system.serialPorts};
    const preview = runner.previewLaunch(HOST, {system: system.id, engine: 'vbox', interfaces: '[null]', settings: JSON.stringify(settings),
      startupDiskEnabled: String(!!system.startupDiskEnabled)});
    assert.equal(preview.engine, 'vbox', system.id);
    assert.deepEqual(preview.settings, settings, system.id);
    assert.equal(preview.monitor, null);
    assert.ok(preview.commands.at(-1).includes('startvm'), system.id);
    assert.ok(preview.commands.some(line => line.includes('createvm')), system.id);
  }
});

test('the page reads the system list again when the engine changes, and the route is never cached', () => {
  assert.match(moduleSource('nodes'), /export async function followEngineChange\(engine = generalSettings\.engine\) \{[\s\S]{0,200}refreshSystems\(\),/);
  assert.match(moduleSource('nodes'), /onChanged: async body => \{\s*const warning = await followEngineChange\(body\.engine\);/);
  assert.match(moduleSource('socket'), /followEngineChange\(event\.engine\)/);
  const systems = moduleSource('systems');
  assert.match(systems, /requestJson\('\/api\/systems', \{cache: 'no-store'\}/);
  assert.match(systems, /store\.images = items;/);
  assert.match(fs.readFileSync(path.join(root, 'server', 'routes', 'settings.js'), 'utf8'), /handle\('catalog\.systems', \(\) => \(\{\}\), 500, \{noStore: true\}\)/);
});
