'use strict';

// host.json content and the host configuration returned to the web layer.
const {selectedProfile, sparseOverrides} = require('../common/system-config');
const {writeJsonAtomic} = require('../common/json-file');
const {readStartupFiles} = require('./media/guest-media');

function createHostConfig(ctx) {
  const {readConfig} = ctx.catalog;
  const {tempFile, startupDirectory, pendingRestart} = ctx.runtime;
  const {guestIsoStatus} = ctx.guestIso;

  function hostConfiguration(node, settings = node.launchSettings, interfaces = node.networkInterfaces,
    startupDiskEnabled = node.guestIsoAttached, name = node.hostname) {
    const profile = selectedProfile(readConfig(), node.selectedImage.id, node.engine);
    return {
      schemaVersion: 3,
      id: node.id,
      name,
      system: node.selectedImage.id,
      engine: node.engine,
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

  return {hostConfiguration, persistHostConfiguration, hostConfigurationResponse};
}

module.exports = {createHostConfig};
