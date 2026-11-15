'use strict';

// Per-node guest startup ISO: status, creation and cleanup.
const crypto = require('crypto');
const fs = require('fs');
const {shellQuote} = require('../../common/shell-quote');
const {readStartupFiles, createGuestIso} = require('./guest-media');

function createGuestIsoManager(ctx) {
  const {appendLog, tempFile, startupDirectory} = ctx.runtime;

  function guestIsoStatus(node) {
    const attachedNow = !!node.machine && !!node.activeGuestIso;
    return {
      created: !!node.guestIso && fs.existsSync(node.guestIso),
      attached: node.guestIsoAttached,
      attachedNow,
      currentIso: attachedNow && node.activeGuestIso === node.guestIso,
      outdated: node.guestIsoOutdated || (!!node.guestIsoSource &&
        JSON.stringify(readStartupFiles(startupDirectory(node))) !== JSON.stringify(node.guestIsoSource))
    };
  }

  function buildGuestIso(node, destination = tempFile(node, `startup-${crypto.randomUUID()}.iso`)) {
    const next = destination;
    createGuestIso({directory: startupDirectory(node), destination: next, genisoimage: ctx.commands.GENISOIMAGE,
      hostname: node.hostname, interfaces: node.networkInterfaces,
      onCommand: (command, args) => appendLog(node, `$ ${[command, ...args].map(shellQuote).join(' ')}`)});
    const previous = node.guestIso;
    node.guestMedia = readStartupFiles(startupDirectory(node));
    node.guestIsoSource = node.guestMedia;
    node.guestIso = next;
    node.guestIsoOutdated = false;
    node.guestIsoFiles.add(next);
    if (previous && previous !== node.activeGuestIso) {
      fs.rmSync(previous, {force: true});
      node.guestIsoFiles.delete(previous);
    }
    appendLog(node, `# Guest setup ISO created: ${next} (label QWEBSTART; read-only)`);
    return guestIsoStatus(node);
  }

  function cleanupGuestIsoFiles(node) {
    for (const file of node.guestIsoFiles) fs.rmSync(file, {force: true});
    node.guestIsoFiles.clear();
    node.guestIso = null;
    node.guestIsoSource = null;
    node.activeGuestIso = null;
  }

  return {guestIsoStatus, buildGuestIso, cleanupGuestIsoFiles};
}

module.exports = {createGuestIsoManager};
