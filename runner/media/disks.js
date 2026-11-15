'use strict';

// Working disks: qcow2 overlay creation arguments and run-file cleanup.
const fs = require('fs');
const {imagePath} = require('../catalog');

function qemuOverlayArgs(image, overlay) {
  return ['create', '-f', 'qcow2', '-F', 'raw', '-b', imagePath(image.images.raw), overlay];
}

function cleanupRunFiles(node, image) {
  for (const file of image.runFiles || []) { try { fs.unlinkSync(file); } catch (_) {} }
  image.runFiles = [];
  node.runDisk = null;
}

module.exports = {qemuOverlayArgs, cleanupRunFiles};
