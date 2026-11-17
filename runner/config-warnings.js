'use strict';

// Warnings about config.json that are worth showing when a runner starts, as plain sentences:
// a system whose base image is missing, or default resources larger than the machine. They are
// announced in hello (runner/service.js) and printed by the server at startup. Errors that make
// config.json unusable are not here: readCatalog throws on them.
const fs = require('fs');
const path = require('path');
const {selectedProfile} = require('../common/system-config');

const MAX_WARNINGS = 20;

// catalog: the result of readCatalog; root: the directory image paths are relative to;
// engines: the engines this runner can run; cpus and memoryBytes: what the machine has.
function configWarnings({catalog, root, engines, cpus, memoryBytes}) {
  const warnings = [];
  for (const system of Object.keys(catalog.systems)) {
    if (system === 'default') continue;
    for (const engine of engines) {
      const profile = selectedProfile(catalog, system, engine);
      if (typeof profile.image === 'string' && !fs.existsSync(path.resolve(root, profile.image))) {
        warnings.push(`${system}: ${profile.image} is missing; run bash scripts/prepare.sh --system ${system}.`);
      }
    }
    const qemu = selectedProfile(catalog, system, 'qemu');
    if (Number.isFinite(memoryBytes) && qemu.memory * 1024 * 1024 > memoryBytes) {
      warnings.push(`${system}: the default memory of ${qemu.memory} MB exceeds the ${Math.round(memoryBytes / 1024 / 1024)} MB of this machine.`);
    }
    if (Number.isFinite(cpus) && qemu.cpus > cpus) {
      warnings.push(`${system}: the default of ${qemu.cpus} processors exceeds the ${cpus} of this machine.`);
    }
  }
  return warnings.slice(0, MAX_WARNINGS);
}

module.exports = {configWarnings};
