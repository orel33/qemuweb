'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {launchSettingFields, validateLaunchSettings, validateQemuOptions} = require('../../common/launch-settings');

test('launch settings accept valid values and reject unknown or out-of-range ones', () => {
  const valid = {memory: 512, cpus: 2, clock: 'utc', serialConsoles: 1};
  assert.equal(validateLaunchSettings(valid), valid);
  assert.throws(() => validateLaunchSettings({...valid, extra: 1}), /Unknown launch setting: extra/);
  assert.throws(() => validateLaunchSettings({memory: 512, cpus: 2, clock: 'utc'}), /Incomplete launch settings/);
  assert.doesNotThrow(() => validateLaunchSettings({memory: 512}, true));
  assert.throws(() => validateLaunchSettings({...valid, memory: 63}), /Memory must be between/);
  assert.throws(() => validateLaunchSettings({...valid, cpus: 65}), /Processors must be between/);
  assert.throws(() => validateLaunchSettings({...valid, clock: 'gmt'}), /Hardware clock/);
  assert.throws(() => validateLaunchSettings(null), /Invalid launch settings/);
});

test('launch setting field descriptions match the validation limits', () => {
  assert.deepEqual([launchSettingFields.memory.min, launchSettingFields.memory.max], [64, 32768]);
  assert.deepEqual([launchSettingFields.cpus.min, launchSettingFields.cpus.max], [1, 64]);
});

test('QEMU options reject unknown keys, bad buses and control characters', () => {
  assert.throws(() => validateQemuOptions({bogus: 'x'}, true), /Unknown QEMU setting: bogus/);
  assert.throws(() => validateQemuOptions({diskInterface: 'scsi'}, true), /disk bus must be virtio or ide/);
  assert.throws(() => validateQemuOptions({networkModel: 'rtl8139'}, true), /network model/);
  assert.throws(() => validateQemuOptions({machine: 'pc\n'}, true), /Invalid value for machine/);
  assert.throws(() => validateQemuOptions({extraOptions: ['-x', '']}, true), /Invalid QEMU extra options/);
  assert.throws(() => validateQemuOptions({bootDisk: 'zz'}, true), /boot order/);
  assert.doesNotThrow(() => validateQemuOptions({diskInterface: 'virtio', bootDisk: 'c', memory: 256, smp: 1, rtcBase: 'utc'}, true));
});
