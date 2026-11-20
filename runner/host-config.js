'use strict';

// host.json content and the host configuration returned to the web layer.
const {selectedProfile, applyHostValues} = require('../common/system-config');
const {writeJsonAtomic} = require('../common/json-file');
const {HOST_SCHEMA_VERSION} = require('../common/schema-versions');
const {readStartupFiles} = require('./media/guest-media');

function createHostConfig(ctx) {
  const {readConfig} = ctx.catalog;
  const {tempFile, startupDirectory, pendingRestart} = ctx.runtime;
  const {guestIsoStatus} = ctx.guestIso;

  function hostConfiguration(node, settings = node.launchSettings, interfaces = node.networkInterfaces,
    startupDiskEnabled = node.guestIsoAttached, name = node.hostname) {
    const profile = selectedProfile(readConfig(), node.selectedImage.id, node.engine);
    return {
      schemaVersion: HOST_SCHEMA_VERSION,
      id: node.id,
      name,
      system: node.selectedImage.id,
      // Only the current engine's keys change; the other engine's settings stay as they were.
      config: applyHostValues(node.hostConfig, {...settings, startupDiskEnabled}, profile, node.engine),
      network: {interfaces}
    };
  }

  function persistHostConfiguration(node) {
    const data = hostConfiguration(node);
    writeJsonAtomic(tempFile(node, 'host.json'), data);
    node.hostConfig = data.config;
  }

  function hostConfigurationResponse(node) {
    return {...hostConfiguration(node), engine: node.engine, systemId: node.selectedImage.id, settings: node.launchSettings,
      networkInterfaces: node.networkInterfaces, startupDiskEnabled: node.guestIsoAttached,
      guestMedia: readStartupFiles(startupDirectory(node)), interfaces: node.networkInterfaces.map(nic => nic.switchId),
      running: !!node.machine, hasLaunched: node.everStarted, pendingRestart: pendingRestart(node),
      guestCdrom: guestIsoStatus(node)};
  }

  return {hostConfiguration, persistHostConfiguration, hostConfigurationResponse};
}

module.exports = {createHostConfig};
