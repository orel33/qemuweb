'use strict';

// Validation of per-host launch settings and QEMU options (shared by control plane and runner).
const {validatePorts} = require('./console-id');
const qemuProfileFields = ['machine', 'cpuKvm', 'display', 'diskInterface', 'networkModel', 'bootDisk', 'nic'];
const qemuFields = [...qemuProfileFields, 'extraOptions', 'memory', 'smp', 'rtcBase'];
const launchSettingFields = {
  memory: {label: 'Memory', type: 'number', unit: 'MB', min: 64, max: 32768, step: 64},
  cpus: {label: 'Processors', type: 'number', min: 1, max: 64, step: 1},
  clock: {label: 'Hardware clock', type: 'select', options: ['utc', 'localtime']},
  serialPorts: {label: 'Serial ports', type: 'ports'}
};

function validateQemuOptions(options, partial = false) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid QEMU settings.');
  for (const key of Object.keys(options)) {
    if (!qemuFields.includes(key)) throw new Error(`Unknown QEMU setting: ${key}.`);
  }
  if (!partial && qemuFields.some(key => !Object.hasOwn(options, key))) throw new Error('Incomplete QEMU settings.');
  for (const [key, value] of Object.entries(options)) {
    if (key === 'extraOptions') {
      if (!Array.isArray(value) || value.some(arg => typeof arg !== 'string' || !arg || /[\x00-\x1f\x7f]/.test(arg))) throw new Error('Invalid QEMU extra options.');
      continue;
    }
    if (key === 'memory') {
      if (!Number.isInteger(value) || value < 64 || value > 32768) throw new Error('QEMU memory must be between 64 and 32768 MB.');
      continue;
    }
    if (key === 'smp') {
      if (!Number.isInteger(value) || value < 1 || value > 64) throw new Error('QEMU processors must be between 1 and 64.');
      continue;
    }
    if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error(`Invalid value for ${key}.`);
    }
  }
  if (options.rtcBase && !['utc', 'localtime'].includes(options.rtcBase)) throw new Error('QEMU RTC base must be utc or localtime.');
  if (options.diskInterface && !['virtio', 'ide'].includes(options.diskInterface)) throw new Error('QEMU disk bus must be virtio or ide.');
  if (options.networkModel && !['virtio-net-pci', 'e1000'].includes(options.networkModel)) throw new Error('QEMU network model must be virtio-net-pci or e1000.');
  for (const key of ['bootDisk']) {
    if (options[key] && !/^[a-dn]{1,5}$/.test(options[key])) throw new Error(`Invalid QEMU boot order: ${key}.`);
  }
  return options;
}

function validateLaunchSettings(settings, partial = false) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid launch settings.');
  const allowed = ['memory', 'cpus', 'clock', 'serialPorts'];
  for (const key of Object.keys(settings)) if (!allowed.includes(key)) throw new Error(`Unknown launch setting: ${key}.`);
  if (!partial && allowed.some(key => !Object.hasOwn(settings, key))) throw new Error('Incomplete launch settings.');
  if (settings.memory !== undefined && (!Number.isInteger(settings.memory) || settings.memory < 64 || settings.memory > 32768)) throw new Error('Memory must be between 64 and 32768 MB.');
  if (settings.cpus !== undefined && (!Number.isInteger(settings.cpus) || settings.cpus < 1 || settings.cpus > 64)) throw new Error('Processors must be between 1 and 64.');
  if (settings.clock !== undefined && !['utc', 'localtime'].includes(settings.clock)) throw new Error('Hardware clock must be utc or localtime.');
  if (settings.serialPorts !== undefined) validatePorts(settings.serialPorts);
  return settings;
}

module.exports = {launchSettingFields, validateQemuOptions, validateLaunchSettings};
