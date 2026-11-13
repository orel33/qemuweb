'use strict';

const fs = require('fs');
const crypto = require('crypto');

const engines = ['qemu', 'vbox'];
const editableKeys = ['memory', 'cpus', 'clock', 'startupDiskEnabled'];
const keywords = new Set(['type', 'arch', 'mode', 'label', ...editableKeys, 'firmware',
  'acceleration', 'boot', 'extraOptions', 'cdromInterface', 'diskInterface', 'networkModel', 'image']);

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function validateOverrides(overrides) {
  if (!isObject(overrides) || Object.keys(overrides).some(key => !editableKeys.includes(key))) {
    throw new Error('Host config may only override memory, cpus, clock and startupDiskEnabled.');
  }
  if (overrides.memory !== undefined && (!Number.isInteger(overrides.memory) || overrides.memory < 64 || overrides.memory > 32768)) throw new Error('Memory must be between 64 and 32768 MB.');
  if (overrides.cpus !== undefined && (!Number.isInteger(overrides.cpus) || overrides.cpus < 1 || overrides.cpus > 64)) throw new Error('Processors must be between 1 and 64.');
  if (overrides.clock !== undefined && !['utc', 'localtime'].includes(overrides.clock)) throw new Error('Clock must be utc or localtime.');
  if (overrides.startupDiskEnabled !== undefined && typeof overrides.startupDiskEnabled !== 'boolean') throw new Error('startupDiskEnabled must be boolean.');
  return overrides;
}

function validateProfile(profile, id, engine) {
  if (profile.type !== 'linux' || profile.arch !== 'x86_64' || profile.mode !== 'text' ||
      typeof profile.label !== 'string' || !profile.label.trim()) throw new Error(`Invalid Linux/x86_64/text profile: ${id}/${engine}.`);
  validateOverrides(Object.fromEntries(editableKeys.map(key => [key, profile[key]])));
  if (profile.firmware !== 'bios' || profile.boot !== 'disk' || profile.cdromInterface !== 'ide' ||
      !['virtio', 'e1000'].includes(profile.networkModel) ||
      (engine === 'qemu' && (profile.acceleration !== 'kvm' || !['ide', 'virtio'].includes(profile.diskInterface))) ||
      (engine === 'vbox' && (profile.acceleration !== 'default' || profile.diskInterface !== 'sata'))) {
    throw new Error(`Invalid hardware profile: ${id}/${engine}.`);
  }
  if (engine === 'qemu') {
    const args = profile.extraOptions;
    const pairs = Array.isArray(args) && args.length === 6
      ? Object.fromEntries([0, 2, 4].map(index => [args[index], args[index + 1]]))
      : {};
    if (!Array.isArray(args) || args.length !== 6 || args.some(value => typeof value !== 'string') ||
        new Set(args.filter((_, index) => index % 2 === 0)).size !== 3 ||
        pairs['-machine'] !== 'q35' || pairs['-cpu'] !== 'host' || pairs['-nic'] !== 'none') {
      throw new Error(`Invalid extraOptions:qemu for ${id}.`);
    }
  } else if (profile.extraOptions !== undefined) {
    throw new Error(`extraOptions:vbox is not defined for the current runner: ${id}.`);
  }
  if (id === 'default' && profile.image === null) return;
  if (typeof profile.image !== 'string' || !profile.image || /[\x00-\x1f\x7f]/.test(profile.image)) {
    throw new Error(`Missing image for ${id}/${engine}.`);
  }
}

function readCatalog(file) {
  let catalog;
  try { catalog = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot read config.json: ${error.message}`); }
  if (!isObject(catalog) || catalog.schemaVersion !== 4 || !isObject(catalog.systems) || !isObject(catalog.systems.default)) {
    throw new Error('config.json must contain schemaVersion 4 and systems.default.');
  }
  if (Object.keys(catalog).some(key => !['schemaVersion', 'systems'].includes(key))) throw new Error('Unknown top-level key in config.json.');
  const cache = new Map(), visiting = new Set();
  function resolve(id) {
    if (cache.has(id)) return cache.get(id);
    if (visiting.has(id)) throw new Error(`System inheritance cycle at ${id}.`);
    const source = catalog.systems[id];
    if (!isObject(source) || !/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error(`Invalid system ${id}.`);
    for (const key of Object.keys(source)) {
      if (key === 'basedOn') continue;
      const match = /^([^:]+)(?::([^:]+))?$/.exec(key);
      if (!match || !keywords.has(match[1]) || (match[2] && !engines.includes(match[2]))) {
        throw new Error(`Unknown keyword systems.${id}.${key}.`);
      }
    }
    visiting.add(id);
    const parent = source.basedOn;
    if (id !== 'default' && (typeof parent !== 'string' || !Object.hasOwn(catalog.systems, parent))) throw new Error(`Unknown parent for ${id}.`);
    if (id === 'default' && parent !== undefined) throw new Error('systems.default cannot inherit another system.');
    const inherited = parent ? resolve(parent) : {qemu: {}, vbox: {}};
    const result = {};
    for (const engine of engines) {
      const profile = {...inherited[engine]};
      for (const [key, value] of Object.entries(source)) if (keywords.has(key)) profile[key] = value;
      for (const [key, value] of Object.entries(source)) if (key.endsWith(`:${engine}`)) profile[key.slice(0, -engine.length - 1)] = value;
      validateProfile(profile, id, engine);
      result[engine] = profile;
    }
    visiting.delete(id);
    cache.set(id, result);
    return result;
  }
  for (const id of Object.keys(catalog.systems)) resolve(id);
  return {systems: Object.fromEntries(cache)};
}

function selectedProfile(catalog, system, engine) {
  const profiles = catalog.systems[system];
  if (!profiles || !engines.includes(engine) || system === 'default') throw new Error(`Unknown system or engine: ${system}/${engine}.`);
  return profiles[engine];
}

function profileHash(profile) {
  const ordered = Object.fromEntries(Object.keys(profile).sort().map(key => [key, profile[key]]));
  return crypto.createHash('sha256').update(JSON.stringify(ordered), 'utf8').digest('hex');
}

function sparseOverrides(profile, values) {
  validateOverrides(values);
  return Object.fromEntries(editableKeys.filter(key => values[key] !== undefined && values[key] !== profile[key])
    .map(key => [key, values[key]]));
}

module.exports = {readCatalog, selectedProfile, profileHash, validateOverrides, sparseOverrides, editableKeys};
