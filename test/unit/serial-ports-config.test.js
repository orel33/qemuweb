'use strict';

// serialPorts: profile capability, host override, validation.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {readCatalog, selectedProfile, validateOverrides, sparseOverrides, profileSerialPorts} = require('../../common/system-config');
const {validateLaunchSettings, launchSettingFields} = require('../../common/launch-settings');

const catalog = readCatalog(path.join(__dirname, '..', '..', 'config.json'));
const debian = selectedProfile(catalog, 'debian13-legacy', 'qemu');
const alpine = selectedProfile(catalog, 'alpine', 'qemu');
const badLists = [['ttyS1'], ['ttyS0', 'ttyS0'], ['ttyS0', 'ttyS2'], ['ttyS1', 'ttyS0'], ['ttyS0', 'ttyS1', 'ttyS2'], [], 'ttyS0', 2, null, [0]];

test('only the Debian QEMU profiles expose ttyS0 and ttyS1', () => {
  for (const id of ['debian13-legacy', 'debian13-cloud']) {
    assert.deepEqual(profileSerialPorts(selectedProfile(catalog, id, 'qemu')), ['ttyS0', 'ttyS1'], id);
    assert.deepEqual(profileSerialPorts(selectedProfile(catalog, id, 'vbox')), ['ttyS0'], `${id}/vbox`);
  }
  for (const id of ['alpine', 'openwrt']) assert.deepEqual(profileSerialPorts(selectedProfile(catalog, id, 'qemu')), ['ttyS0'], id);
});

test('validateOverrides checks serialPorts against the profile', () => {
  assert.doesNotThrow(() => validateOverrides({serialPorts: ['ttyS0']}, debian));
  assert.doesNotThrow(() => validateOverrides({serialPorts: ['ttyS0', 'ttyS1']}, debian));
  assert.throws(() => validateOverrides({serialPorts: ['ttyS0', 'ttyS1']}, alpine), /This system exposes only ttyS0\./);
  assert.doesNotThrow(() => validateOverrides({serialPorts: ['ttyS0']}, alpine));
  for (const value of badLists) assert.throws(() => validateOverrides({serialPorts: value}), /Serial ports must be a list starting with ttyS0/, JSON.stringify(value));
  for (const value of badLists) assert.throws(() => validateOverrides({serialPorts: value}, debian), /Serial ports must be|exposes only ttyS0, ttyS1/, JSON.stringify(value));
});

test('the old numeric serialConsoles key is no longer accepted', () => {
  assert.throws(() => validateOverrides({serialConsoles: 2}), /may only override/);
  assert.throws(() => validateLaunchSettings({memory: 512, cpus: 1, clock: 'utc', serialConsoles: 2}), /Unknown launch setting/);
});

test('sparseOverrides keeps serialPorts only when it differs from the system default', () => {
  assert.deepEqual(sparseOverrides(debian, {serialPorts: ['ttyS0', 'ttyS1']}), {});
  assert.deepEqual(sparseOverrides(debian, {serialPorts: ['ttyS0']}), {serialPorts: ['ttyS0']});
  assert.deepEqual(sparseOverrides(alpine, {serialPorts: ['ttyS0']}), {});
});

test('launch settings validate serialPorts', () => {
  const valid = {memory: 512, cpus: 1, clock: 'utc', serialPorts: ['ttyS0', 'ttyS1']};
  assert.equal(validateLaunchSettings(valid), valid);
  for (const value of badLists) assert.throws(() => validateLaunchSettings({...valid, serialPorts: value}), /Serial ports must be a list starting with ttyS0/, JSON.stringify(value));
  assert.equal(launchSettingFields.serialPorts.type, 'ports');
});
