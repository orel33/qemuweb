'use strict';

// Warnings about config.json that are worth showing when a runner starts, as plain sentences:
// a system whose base image is missing, or default resources larger than the machine. They are
// announced in hello (runner/service.js) and printed by the runner itself at startup
// (runner/main.js). Errors that make config.json unusable are not here: readCatalog throws on them.
const fs = require('fs');
const path = require('path');
const {selectedProfile} = require('../common/system-config');

const MAX_WARNINGS = 20;

// catalog: the result of readCatalog; root: the directory image paths are relative to;
// engines: the engines this runner can run; kvm: whether /dev/kvm is usable; cpus and memoryBytes:
// what the machine has. config.json is shared by runners that differ, so a system that this
// runner cannot run is a warning for this runner, never an error.
function configWarnings({catalog, root, engines, kvm = true, cpus, memoryBytes}) {
  const warnings = [];
  if (engines.includes('qemu') && !kvm) {
    warnings.push('QEMU is installed but /dev/kvm is missing or not accessible: QEMU hosts cannot start (add this user to the kvm group, or use VirtualBox).');
  }
  if (!engines.length) warnings.push('This runner has no virtualization engine: install QEMU (with KVM) or VirtualBox.');
  for (const system of Object.keys(catalog.systems)) {
    if (system === 'default') continue;
    for (const engine of engines) {
      const profile = selectedProfile(catalog, system, engine);
      if (typeof profile.image === 'string' && !fs.existsSync(path.resolve(root, profile.image))) {
        warnings.push(`${system}: ${profile.image} is missing on this runner; run bash scripts/prepare.sh --system ${system}.`);
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

// Start-time check: the memory reserved by the hosts running on this runner, with the host being
// started, above 90 % of the machine's RAM. runningMb: the memory (MB) of the other hosts of
// this runner that are running; hostMb: the host being started. Returns a sentence for the
// host's Log, or null. It never blocks the start.
const MEMORY_WARNING_RATIO = 0.9;
function memoryWarning({runningMb, hostMb, totalBytes}) {
  if (!Number.isFinite(runningMb) || !Number.isFinite(hostMb) || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  const reservedMb = runningMb + hostMb;
  const totalMb = Math.round(totalBytes / 1024 / 1024);
  if (reservedMb <= totalMb * MEMORY_WARNING_RATIO) return null;
  return `hosts of this runner reserve ${reservedMb} MB of the ${totalMb} MB of this machine; it may swap or an emulator may be killed.`;
}

module.exports = {configWarnings, memoryWarning};
