'use strict';

// host.json content and the host configuration returned to the web layer.
const {selectedProfile, profileHash, sparseOverrides} = require('../common/system-config');
const {writeJsonAtomic} = require('../common/json-file');
const {readStartupFiles} = require('./media/guest-media');
const {readConfig} = require('./catalog');
const {tempFile, startupDirectory, pendingRestart} = require('./session-runtime');
const {guestIsoStatus} = require('./media/guest-iso');

function hostConfiguration(node, settings = node.launchSettings, interfaces = node.networkInterfaces,
  startupDiskEnabled = node.guestIsoAttached, name = node.hostname) {
  const profile = selectedProfile(readConfig(), node.selectedImage.id, node.engine);
  const hash = profileHash(profile);
  if (node.profileHash && node.profileHash !== hash) {
    throw new Error(`System profile changed for ${name}; restore its original config.json or recreate the host.`);
  }
  node.profileHash = hash;
  return {
    schemaVersion: 3,
    id: node.id,
    name,
    system: node.selectedImage.id,
    engine: node.engine,
    profileHash: hash,
    config: sparseOverrides(profile, {...settings, startupDiskEnabled}),
    network: {interfaces}
  };
}

function persistHostConfiguration(node) {
  writeJsonAtomic(tempFile(node, 'host.json'), hostConfiguration(node));
}

function hostConfigurationResponse(node) {
  return {...hostConfiguration(node), systemId: node.selectedImage.id, settings: node.launchSettings,
    networkInterfaces: node.networkInterfaces, startupDiskEnabled: node.guestIsoAttached,
    guestMedia: readStartupFiles(startupDirectory(node)), interfaces: node.networkInterfaces.map(nic => nic.switchId),
    running: !!node.machine, hasLaunched: node.everStarted, pendingRestart: pendingRestart(node),
    guestCdrom: guestIsoStatus(node)};
}

module.exports = {hostConfiguration, persistHostConfiguration, hostConfigurationResponse};
