'use strict';

// Working disks: qcow2 overlay creation arguments and run-file cleanup. A host may own one working
// disk per engine in its node directory, disk.qcow2 (QEMU) and disk.vdi (VirtualBox); an engine
// uses only its own. Both formats are kept when the session engine changes.
const fs = require('fs');
const path = require('path');

const DISK_FILES = {qemu: 'disk.qcow2', vbox: 'disk.vdi'};
// The working disk kinds, by the format of the base image each one depends on (host.json baseImages).
const WORKING_DISKS = [{format: 'raw', engine: 'qemu', file: 'disk.qcow2'}, {format: 'vdi', engine: 'vbox', file: 'disk.vdi'}];

function createDisks(ctx) {
  const {imagePath} = ctx.catalog;

  function qemuOverlayArgs(image, overlay) {
    return ['create', '-f', 'qcow2', '-F', 'raw', '-b', imagePath(image.images.raw), overlay];
  }

  function cleanupRunFiles(node, image) {
    for (const file of image.runFiles || []) { try { fs.unlinkSync(file); } catch (_) {} }
    image.runFiles = [];
    node.runDisk = null;
  }

  // The working disk file of a node for an engine, whether it exists or not.
  function workingDiskPath(node, engine) { return path.join(node.runtimeDir, DISK_FILES[engine]); }

  // The engines for which the node has a working disk file.
  function workingDiskEngines(node) {
    return Object.keys(DISK_FILES).filter(engine => fs.existsSync(workingDiskPath(node, engine)));
  }

  return {qemuOverlayArgs, cleanupRunFiles, workingDiskPath, workingDiskEngines};
}

module.exports = {createDisks, DISK_FILES, WORKING_DISKS};
