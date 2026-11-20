'use strict';

// The config of a host.json holds the settings of BOTH engines (VBX02): `keyword`, `keyword:qemu` and
// `keyword:vbox`. Resolution for an engine: `keyword:<engine>`, else `keyword`, else the system profile.
// Writing (Host Settings) touches the keys of the current engine only. Pure functions of
// common/system-config.js, then the host.configure command on a runner driven in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {readCatalog, selectedProfile, validateHostConfig, resolveHostConfig, applyHostValues, parseConfigKey} = require('../../common/system-config');
const {createSessionRunner} = require('../../runner/session-runner');
const {commands: hostCommands} = require('../../runner/commands/hosts');
const {commands: settingsCommands} = require('../../runner/commands/settings');

const root = path.join(__dirname, '..', '..');
const catalog = readCatalog(path.join(root, 'config.json'));
const profiles = system => ({qemu: selectedProfile(catalog, system, 'qemu'), vbox: selectedProfile(catalog, system, 'vbox')});
const debian = profiles('debian13-legacy');
const alpine = profiles('alpine');

test('config keys are a keyword with an optional :qemu or :vbox suffix', () => {
  assert.deepEqual(parseConfigKey('memory'), {keyword: 'memory', engine: null});
  assert.deepEqual(parseConfigKey('serialPorts:vbox'), {keyword: 'serialPorts', engine: 'vbox'});
  for (const key of ['memory:xen', 'memory:', ':qemu', 'type', 'image:qemu', 'memory:qemu:vbox', 'Memory']) assert.throws(() => parseConfigKey(key), /may only override/, key);
});

test('resolution for an engine: keyword:<engine>, else keyword, else the system profile', () => {
  const config = {memory: 700, 'memory:vbox': 900, 'cpus:qemu': 3};
  const qemu = resolveHostConfig(config, alpine.qemu, 'qemu');
  const vbox = resolveHostConfig(config, alpine.vbox, 'vbox');
  assert.equal(qemu.memory, 700, 'unsuffixed applies to both engines');
  assert.equal(vbox.memory, 900, 'the suffixed value wins over the unsuffixed one');
  assert.equal(qemu.cpus, 3);
  assert.equal(vbox.cpus, alpine.vbox.cpus, 'a value of the other engine is never used');
  assert.equal(qemu.clock, alpine.qemu.clock);
  assert.deepEqual(resolveHostConfig({}, debian.qemu, 'qemu').serialPorts, ['ttyS0', 'ttyS1']);
  assert.deepEqual(resolveHostConfig({}, debian.vbox, 'vbox').serialPorts, ['ttyS0']);
  assert.equal(resolveHostConfig({'startupDiskEnabled:vbox': true}, alpine.qemu, 'qemu').startupDiskEnabled, alpine.qemu.startupDiskEnabled);
  assert.equal(resolveHostConfig({'startupDiskEnabled:vbox': true}, alpine.vbox, 'vbox').startupDiskEnabled, true);
  // A false value still wins over the next level.
  assert.equal(resolveHostConfig({startupDiskEnabled: true, 'startupDiskEnabled:qemu': false}, alpine.qemu, 'qemu').startupDiskEnabled, false);
});

test('validation: a suffixed value against the profile of its engine, an unsuffixed one against both', () => {
  assert.doesNotThrow(() => validateHostConfig({'serialPorts:qemu': ['ttyS0', 'ttyS1'], 'serialPorts:vbox': ['ttyS0']}, debian));
  assert.throws(() => validateHostConfig({'serialPorts:vbox': ['ttyS0', 'ttyS1']}, debian), /serialPorts:vbox: This system exposes only ttyS0/);
  assert.throws(() => validateHostConfig({serialPorts: ['ttyS0', 'ttyS1']}, debian), /serialPorts: This system exposes only ttyS0/);
  assert.doesNotThrow(() => validateHostConfig({serialPorts: ['ttyS0']}, debian));
  assert.throws(() => validateHostConfig({'memory:qemu': 63}, alpine), /memory:qemu: Memory must be between 64 and 32768 MB/);
  assert.throws(() => validateHostConfig({'clock:vbox': 'gmt'}, alpine), /Clock must be utc or localtime/);
  assert.throws(() => validateHostConfig({'startupDiskEnabled:qemu': 'yes'}, alpine), /startupDiskEnabled must be boolean/);
  assert.throws(() => validateHostConfig([], alpine), /must be an object/);
});

test('writing sets the keys of the current engine only and keeps everything else', () => {
  const start = {'memory:qemu': 2048, 'cpus:vbox': 2, clock: 'localtime'};
  const next = applyHostValues(start, {memory: 4096, cpus: 4, clock: 'localtime', startupDiskEnabled: alpine.vbox.startupDiskEnabled, serialPorts: ['ttyS0']}, alpine.vbox, 'vbox');
  assert.deepEqual(next, {'memory:qemu': 2048, 'cpus:vbox': 4, clock: 'localtime', 'memory:vbox': 4096}, 'the QEMU value and the unsuffixed one are untouched');
  assert.deepEqual(start, {'memory:qemu': 2048, 'cpus:vbox': 2, clock: 'localtime'}, 'the input is not modified');
});

test('a value equal to what the engine would use without its own key is not stored, and its old key goes', () => {
  const values = {memory: alpine.vbox.memory, cpus: alpine.vbox.cpus, clock: alpine.vbox.clock, startupDiskEnabled: alpine.vbox.startupDiskEnabled, serialPorts: ['ttyS0']};
  assert.deepEqual(applyHostValues({}, values, alpine.vbox, 'vbox'), {});
  assert.deepEqual(applyHostValues({'memory:vbox': 4096, 'memory:qemu': 1}, values, alpine.vbox, 'vbox'), {'memory:qemu': 1});
  // serialPorts equal to the system default of THAT engine: the default differs between engines.
  assert.deepEqual(applyHostValues({}, {serialPorts: ['ttyS0']}, debian.qemu, 'qemu'), {'serialPorts:qemu': ['ttyS0']});
  assert.deepEqual(applyHostValues({}, {serialPorts: ['ttyS0']}, debian.vbox, 'vbox'), {});
});

test('with an unsuffixed value, the profile default is stored explicitly for the engine (else it would resolve to the unsuffixed value)', () => {
  const next = applyHostValues({memory: 700}, {memory: alpine.qemu.memory}, alpine.qemu, 'qemu');
  assert.deepEqual(next, {memory: 700, 'memory:qemu': alpine.qemu.memory});
  assert.equal(resolveHostConfig(next, alpine.qemu, 'qemu').memory, alpine.qemu.memory);
  assert.equal(resolveHostConfig(next, alpine.vbox, 'vbox').memory, 700, 'the other engine still uses the unsuffixed value');
  assert.deepEqual(applyHostValues({memory: 700}, {memory: 700}, alpine.qemu, 'qemu'), {memory: 700});
});

test('writing validates the values against the profile of the engine (serialPorts of that engine)', () => {
  assert.throws(() => applyHostValues({}, {serialPorts: ['ttyS0', 'ttyS1']}, debian.vbox, 'vbox'), /This system exposes only ttyS0/);
  assert.doesNotThrow(() => applyHostValues({}, {serialPorts: ['ttyS0', 'ttyS1']}, debian.qemu, 'qemu'));
});

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-host-config-'));
  const runtimeDir = path.join(dir, 'sessions', 'test');
  fs.mkdirSync(runtimeDir, {recursive: true});
  const session = {id: '0000000000000001', nodes: new Map(), engine: 'qemu', runtimeDir, saveMetadata() {}};
  const runner = createSessionRunner({session, commands: {QEMU_IMG: 'q', QEMU_SYSTEM_X86_64: 'q', GENISOIMAGE: 'g', VBOXMANAGE: 'v'}, root, runtimeRoot: dir, configPath: path.join(root, 'config.json')});
  t.after(() => { runner.stopResourceSampling(); fs.rmSync(dir, {recursive: true, force: true}); });
  const emit = () => {};
  const configure = (id, change) => {
    const current = hostCommands['host.config']({runner}, {nodeId: id});
    const body = {name: current.name, systemId: current.systemId, engine: current.engine, settings: {...current.settings, ...change},
      interfaces: current.interfaces, guestMedia: current.guestMedia, startupDiskEnabled: current.startupDiskEnabled};
    return hostCommands['host.configure']({session, runner, emit}, {nodeId: id, body});
  };
  const config = id => JSON.parse(fs.readFileSync(path.join(runtimeDir, id, 'host.json'), 'utf8')).config;
  return {runner, session, emit, configure, config, runtimeDir};
}

test('Host Settings under VirtualBox never changes the QEMU values, and they are back after switching', t => {
  const {runner, session, emit, configure, config} = setup(t);
  const ID = 'h-0000000000000001';
  hostCommands['host.create']({session, runner, emit}, {body: {id: ID, name: 'web', imageId: 'alpine', settings: {memory: 2048}}});
  assert.deepEqual(config(ID), {'memory:qemu': 2048});

  settingsCommands['session.setEngine']({session, runner, emit}, {body: {engine: 'vbox'}});
  const shown = hostCommands['host.config']({runner}, {nodeId: ID});
  assert.equal(shown.engine, 'vbox');
  assert.equal(shown.settings.memory, alpine.vbox.memory, 'Host Settings reads the VirtualBox values');
  assert.ok(!('engine' in JSON.parse(fs.readFileSync(path.join(session.runtimeDir, ID, 'host.json'), 'utf8'))), 'host.json has no engine');

  configure(ID, {memory: 3072, cpus: 2});
  assert.deepEqual(config(ID), {'memory:qemu': 2048, 'memory:vbox': 3072, 'cpus:vbox': 2});
  // A value equal to the VirtualBox default is not stored.
  configure(ID, {cpus: alpine.vbox.cpus});
  assert.deepEqual(config(ID), {'memory:qemu': 2048, 'memory:vbox': 3072});

  settingsCommands['session.setEngine']({session, runner, emit}, {body: {engine: 'qemu'}});
  assert.equal(runner.getNode(ID).launchSettings.memory, 2048);
  configure(ID, {memory: alpine.qemu.memory});
  assert.deepEqual(config(ID), {'memory:vbox': 3072}, 'QEMU default: its key goes, the VirtualBox value stays');
  // Setting the engine of an existing host is refused, as before: the page and the session must agree.
  assert.throws(() => hostCommands['host.configure']({session, runner, emit}, {nodeId: ID, body: {...configureBody(runner, ID), engine: 'vbox'}}), /read-only/);
});

function configureBody(runner, id) {
  const current = hostCommands['host.config']({runner}, {nodeId: id});
  return {name: current.name, systemId: current.systemId, engine: current.engine, settings: current.settings,
    interfaces: current.interfaces, guestMedia: current.guestMedia, startupDiskEnabled: current.startupDiskEnabled};
}

test('the startup disk option and serial ports are per engine too', t => {
  const {runner, session, emit, configure, config} = setup(t);
  const ID = 'h-0000000000000001';
  hostCommands['host.create']({session, runner, emit}, {body: {id: ID, name: 'srv', imageId: 'debian13-legacy'}});
  assert.deepEqual(config(ID), {});
  configure(ID, {serialPorts: ['ttyS0']});
  assert.deepEqual(config(ID), {'serialPorts:qemu': ['ttyS0']});
  settingsCommands['session.setEngine']({session, runner, emit}, {body: {engine: 'vbox'}});
  assert.deepEqual(runner.getNode(ID).launchSettings.serialPorts, ['ttyS0']);
  assert.deepEqual(config(ID), {'serialPorts:qemu': ['ttyS0']}, 'no VirtualBox key for the single VirtualBox port');
  settingsCommands['session.setEngine']({session, runner, emit}, {body: {engine: 'qemu'}});
  assert.deepEqual(runner.getNode(ID).launchSettings.serialPorts, ['ttyS0']);
  runner.getNode(ID).guestIsoAttached = true;
  runner.persistHostConfiguration(runner.getNode(ID));
  assert.deepEqual(config(ID), {'serialPorts:qemu': ['ttyS0'], 'startupDiskEnabled:qemu': true});
});
