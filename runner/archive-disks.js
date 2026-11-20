'use strict';

// Working disks of a session archive on load: the base image identities recorded in each host.json
// (`baseImages`, keyed by the format of the base image a disk depends on: raw for disk.qcow2, vdi
// for disk.vdi), their comparison with the images of this machine, and the check of each disk file.
// A host may carry both disks. Used by runner/archive-snapshot.js.
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const {WORKING_DISKS} = require('./media/disks');
const {checkVdiDisk} = require('./media/vdi');

const FORMAT_LABELS = {raw: 'QEMU', vdi: 'VirtualBox'};

function createArchiveDisks({runner, commands}) {
  const {imageById, imagePath, fileSha256Async} = runner;

  function removeDisks(snapshot, stage, hosts) {
    for (const host of hosts) {
      for (const kind of WORKING_DISKS) fs.rmSync(path.join(stage, host.id, kind.file), {force: true});
      host.disks = [];
    }
  }

  // The identity a host.json records for one disk: {size, sha256}, strictly.
  function validIdentity(identity) {
    return identity && typeof identity === 'object' && !Array.isArray(identity) &&
      Object.keys(identity).every(key => ['size', 'sha256'].includes(key)) &&
      Number.isSafeInteger(identity.size) && /^[0-9a-f]{64}$/.test(identity.sha256);
  }

  // Checks the identities against the archive's disk files and this machine's base images.
  // discardDisks drops every working disk of the archive (hosts start from the current images).
  // Returns the warnings; throws when a disk cannot be reused and the user did not ask to discard.
  async function checkDisks(snapshot, stage, {discardDisks = false} = {}) {
    const withDisk = snapshot.hosts.filter(host => host.disks.length);
    if (discardDisks) {
      removeDisks(snapshot, stage, withDisk);
      return withDisk.length ? [{hosts: withDisk.map(host => host.id),
        message: `Working disks of ${withDisk.map(host => host.name).join(', ')} were discarded and these hosts will start from the current base images.`}] : [];
    }
    for (const host of snapshot.hosts) {
      const recorded = host.baseImages === undefined ? [] : Object.keys(host.baseImages);
      if (host.baseImages !== undefined && (!host.baseImages || typeof host.baseImages !== 'object' || Array.isArray(host.baseImages))) throw new Error(`Invalid base image identity for ${host.name}.`);
      if (recorded.length !== host.disks.length || recorded.some(format => !host.disks.includes(format) || !validIdentity(host.baseImages[format]))) {
        throw new Error(`Invalid base image identity for ${host.name}.`);
      }
    }
    for (const kind of WORKING_DISKS) {
      const holders = withDisk.filter(host => host.disks.includes(kind.format));
      for (const id of new Set(holders.map(host => host.system))) {
        let actual = null;
        try { actual = await fileSha256Async(imagePath(imageById(id).images[kind.format])); } catch (_) { /* not installed */ }
        const stale = holders.filter(host => host.system === id &&
          (!actual || host.baseImages[kind.format].size !== actual.size || host.baseImages[kind.format].sha256 !== actual.sha256));
        if (!stale.length) continue;
        const names = stale.map(host => host.name).join(', ');
        throw new Error(`Base image ${id} ${actual ? 'changed since this session was saved' : `is not installed on this server (${FORMAT_LABELS[kind.format]} format)`}; working disks of ${names} cannot be reused. Enable "Discard working disks" to load the session without them.`);
      }
    }
    return [];
  }

  // Checks each disk file of the archive and prepares it for this machine.
  function verifyDisks(snapshot, stage) {
    for (const host of snapshot.hosts) {
      const image = imageById(host.system);
      if (host.disks.includes('raw')) {
        const disk = path.join(stage, host.id, 'disk.qcow2');
        const info = JSON.parse(execFileSync(commands.QEMU_IMG, ['info', '--output=json', disk], {encoding: 'utf8', maxBuffer: 1024 * 1024}));
        if (info.format !== 'qcow2' || info.encrypted || info['data-file'] || info['format-specific']?.data?.['data-file'] || info['format-specific']?.data?.['data-file-raw'] || info['backing-filename-format'] !== 'raw' ||
            !info['backing-filename'] || info['virtual-size'] !== host.baseImages.raw.size) throw new Error(`Incompatible QCOW2 overlay for ${host.name}.`);
        execFileSync(commands.QEMU_IMG, ['rebase', '-u', '-f', 'qcow2', '-F', 'raw', '-b', imagePath(image.images.raw), disk], {maxBuffer: 1024 * 1024});
        execFileSync(commands.QEMU_IMG, ['check', '-f', 'qcow2', disk], {maxBuffer: 1024 * 1024});
      }
      if (host.disks.includes('vdi')) {
        try { checkVdiDisk(path.join(stage, host.id, 'disk.vdi'), imagePath(image.images.vdi)); }
        catch (error) { throw new Error(`Incompatible VirtualBox disk for ${host.name}: ${error.message}`, {cause: error}); }
      }
    }
  }

  return {checkDisks, verifyDisks};
}

module.exports = {createArchiveDisks};
