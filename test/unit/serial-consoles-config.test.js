'use strict';

// serialConsoles: profile capability, host override, validation, and its exclusion from profileHash.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {readCatalog, selectedProfile, profileHash, validateOverrides, sparseOverrides, serialConsoleLimit} = require('../../common/system-config');
const {validateLaunchSettings, launchSettingFields} = require('../../common/launch-settings');

const catalog = readCatalog(path.join(__dirname, '..', '..', 'config.json'));

test('profile hashes ignore serialConsoles, so archives saved before the key still load', () => {
  // These hashes were recorded before serialConsoles existed in config.json.
  assert.equal(profileHash(catalog.systems.default.qemu), 'aa4aabbae085fecd9bf5d8973dee7f7024c08d4bae3aca9ae4c3b13cbadaf7d1');
  assert.equal(profileHash(selectedProfile(catalog, 'debian13-legacy', 'qemu')), 'cf88d97a8e670257d4af622a610c18f021d9b7ecebafc309b68757c7933aae90');
  const legacy = selectedProfile(catalog, 'debian13-legacy', 'qemu');
  assert.equal(profileHash({...legacy, serialConsoles: 1}), profileHash(legacy));
  const {serialConsoles, ...without} = legacy;
  assert.equal(profileHash(without), profileHash(legacy));
});

test('only the Debian QEMU profiles expose two consoles', () => {
  for (const id of ['debian13-legacy', 'debian13-cloud']) {
    assert.equal(serialConsoleLimit(selectedProfile(catalog, id, 'qemu')), 2, id);
    assert.equal(serialConsoleLimit(selectedProfile(catalog, id, 'vbox')), 1, `${id}/vbox`);
  }
  for (const id of ['alpine', 'openwrt']) assert.equal(serialConsoleLimit(selectedProfile(catalog, id, 'qemu')), 1, id);
});

test('validateOverrides checks serialConsoles against the profile', () => {
  const debian = selectedProfile(catalog, 'debian13-legacy', 'qemu');
  const alpine = selectedProfile(catalog, 'alpine', 'qemu');
  assert.doesNotThrow(() => validateOverrides({serialConsoles: 1}, debian));
  assert.doesNotThrow(() => validateOverrides({serialConsoles: 2}, debian));
  assert.throws(() => validateOverrides({serialConsoles: 2}, alpine), /exposes only 1 console/);
  for (const value of [0, 3, 1.5, '2', true]) assert.throws(() => validateOverrides({serialConsoles: value}), /Serial consoles must be 1 or 2/, String(value));
});

test('sparseOverrides keeps serialConsoles only when it differs from the system default', () => {
  const debian = selectedProfile(catalog, 'debian13-legacy', 'qemu');
  const alpine = selectedProfile(catalog, 'alpine', 'qemu');
  assert.deepEqual(sparseOverrides(debian, {serialConsoles: 2}), {});
  assert.deepEqual(sparseOverrides(debian, {serialConsoles: 1}), {serialConsoles: 1});
  assert.deepEqual(sparseOverrides(alpine, {serialConsoles: 1}), {});
});

test('launch settings validate serialConsoles', () => {
  const valid = {memory: 512, cpus: 1, clock: 'utc', serialConsoles: 2};
  assert.equal(validateLaunchSettings(valid), valid);
  assert.throws(() => validateLaunchSettings({...valid, serialConsoles: 3}), /Serial consoles must be 1 or 2/);
  assert.throws(() => validateLaunchSettings({...valid, serialConsoles: 0}), /Serial consoles must be 1 or 2/);
  assert.deepEqual([launchSettingFields.serialConsoles.min, launchSettingFields.serialConsoles.max], [1, 2]);
});
