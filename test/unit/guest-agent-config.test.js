'use strict';

// guestAgent: a profile capability (the image contains the guest agent of the engine), one boolean per
// engine in the system profile. It is not a host setting: Host Settings and host.json never carry it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {readCatalog, selectedProfile, editableKeys, parseConfigKey, validateOverrides, resolveHostConfig, applyHostValues} = require('../../common/system-config');

const configPath = path.join(__dirname, '..', '..', 'config.json');
const shipped = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Reads a catalog made from the shipped one, after `change` edited its systems.
function catalogWith(change) {
  const copy = structuredClone(shipped);
  change(copy.systems);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-guest-agent-'));
  const file = path.join(directory, 'config.json');
  fs.writeFileSync(file, JSON.stringify(copy));
  try { return readCatalog(file); } finally { fs.rmSync(directory, {recursive: true, force: true}); }
}

test('every shipped system has a boolean guestAgent for each engine', () => {
  const catalog = readCatalog(configPath);
  for (const id of Object.keys(catalog.systems)) {
    for (const engine of ['qemu', 'vbox']) assert.equal(typeof catalog.systems[id][engine].guestAgent, 'boolean', `${id}/${engine}`);
  }
});

test('guestAgent:qemu is true only on the systems whose image has qemu-guest-agent, and VirtualBox is false everywhere', () => {
  const catalog = readCatalog(configPath);
  assert.equal(selectedProfile(catalog, 'debian13-legacy', 'qemu').guestAgent, true);
  for (const id of ['debian13-cloud', 'alpine', 'openwrt']) assert.equal(selectedProfile(catalog, id, 'qemu').guestAgent, false, id);
  for (const id of ['debian13-legacy', 'debian13-cloud', 'alpine', 'openwrt']) assert.equal(selectedProfile(catalog, id, 'vbox').guestAgent, false, `${id}/vbox`);
});

test('true and false are accepted, anything else is refused, per engine', () => {
  assert.doesNotThrow(() => catalogWith(systems => { systems.alpine['guestAgent:qemu'] = true; systems.alpine['guestAgent:vbox'] = true; }));
  for (const value of ['true', 'yes', 1, 0, null, [], {}]) {
    assert.throws(() => catalogWith(systems => { systems.alpine['guestAgent:qemu'] = value; }), /guestAgent:qemu must be true or false: alpine/, JSON.stringify(value));
    assert.throws(() => catalogWith(systems => { systems.alpine['guestAgent:vbox'] = value; }), /guestAgent:vbox must be true or false: alpine/, JSON.stringify(value));
  }
  assert.throws(() => catalogWith(systems => { systems.default['guestAgent:qemu'] = 'true'; }), /guestAgent:qemu must be true or false/);
});

test('the unsuffixed key and the other engine are resolved by the suffix scheme', () => {
  const catalog = catalogWith(systems => {
    systems.default.guestAgent = false;
    delete systems.default['guestAgent:qemu']; delete systems.default['guestAgent:vbox'];
    systems.alpine.guestAgent = true;
    systems.alpine['guestAgent:vbox'] = false;
  });
  assert.equal(selectedProfile(catalog, 'alpine', 'qemu').guestAgent, true, 'the unsuffixed value applies to QEMU');
  assert.equal(selectedProfile(catalog, 'alpine', 'vbox').guestAgent, false, 'the suffixed value wins on VirtualBox');
  assert.equal(selectedProfile(catalog, 'openwrt', 'qemu').guestAgent, false);
});

test('a system without any guestAgent value is refused (the default profile must give one)', () => {
  assert.throws(() => catalogWith(systems => { delete systems.default['guestAgent:qemu']; }), /guestAgent:qemu must be true or false/);
});

test('guestAgent is not a host keyword: not editable, not in the host config, not resolved or stored', () => {
  const catalog = readCatalog(configPath);
  const profile = selectedProfile(catalog, 'debian13-legacy', 'qemu');
  assert.ok(!editableKeys.includes('guestAgent'));
  assert.throws(() => parseConfigKey('guestAgent'), /may only override/);
  assert.throws(() => parseConfigKey('guestAgent:qemu'), /may only override/);
  assert.throws(() => validateOverrides({guestAgent: true}, profile), /may only override/);
  assert.ok(!('guestAgent' in resolveHostConfig({}, profile, 'qemu')));
  assert.deepEqual(applyHostValues({}, {memory: 2048}, profile, 'qemu'), {'memory:qemu': 2048});
});

test('the system list and the image of the runner give guestAgent for the engine of the session', t => {
  const {createSessionRunner} = require('../../runner/session-runner');
  const {commands: settingsCommands} = require('../../runner/commands/settings');
  const root = path.join(__dirname, '..', '..');
  for (const engine of ['qemu', 'vbox']) {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-guest-agent-rt-'));
    t.after(() => fs.rmSync(runtimeRoot, {recursive: true, force: true}));
    const runtimeDir = path.join(runtimeRoot, 'sessions', 'test');
    fs.mkdirSync(runtimeDir, {recursive: true});
    const session = {nodes: new Map(), engine, runtimeDir, saveMetadata() {}};
    const commands = {QEMU_IMG: 'qemu-img', QEMU_SYSTEM_X86_64: 'qemu-system-x86_64', GENISOIMAGE: 'genisoimage', VBOXMANAGE: 'VBoxManage'};
    const runner = createSessionRunner({session, commands, root, runtimeRoot, configPath});
    const systems = settingsCommands['catalog.systems']({session, runner});
    assert.ok(systems.length >= 4);
    for (const system of systems) {
      assert.equal(typeof system.guestAgent, 'boolean', `${engine}/${system.id}`);
      assert.equal(system.guestAgent, runner.imageById(system.id).guestAgent, `${engine}/${system.id}: system list and image agree`);
    }
    assert.equal(systems.find(system => system.id === 'debian13-legacy').guestAgent, engine === 'qemu');
  }
});
