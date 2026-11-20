'use strict';

// Changing the session engine. Nothing of a host is deleted: its settings for both engines stay in
// its host.json config (common/system-config.js), and each engine's working disk stays in the node
// directory (runner/media/disks.js). A switch only selects, host by host, the values and the disk
// of the new engine. It is refused while a host is running or busy.
const fs = require('fs');
const {validateLaunchSettings} = require('../common/launch-settings');
const {validatePorts} = require('../common/console-id');
const {selectedProfile, resolveHostConfig, profileSerialPorts} = require('../common/system-config');

const ENGINE_NAMES = {qemu: 'QEMU', vbox: 'VirtualBox'};

function createEngineSwitch(ctx) {
  const {imageById, readConfig, imagePath, qemuOptionsFor} = ctx.catalog;
  const {workingDiskPath} = ctx.disks;

  const hosts = () => [...ctx.session.nodes.values()].filter(node => node.kind === 'host');

  // Whether a machine is up or an action is in progress on any host.
  function hostsInUse() {
    return hosts().some(node => node.machine || node.action || node.stopping);
  }

  // The values of a host for an engine: its config resolved against the system's profile of that
  // engine. A value the profile no longer allows (config.json changed) falls back to the profile's.
  function engineSettings(node, engine) {
    const profile = selectedProfile(readConfig(), node.selectedImage.id, engine);
    const values = resolveHostConfig(node.hostConfig, profile, engine);
    let settings = {memory: values.memory, cpus: values.cpus, clock: values.clock, serialPorts: values.serialPorts};
    try {
      validateLaunchSettings(settings);
      validatePorts(settings.serialPorts, profileSerialPorts(profile));
    } catch (_) {
      const defaults = resolveHostConfig({}, profile, engine);
      settings = {memory: defaults.memory, cpus: defaults.cpus, clock: defaults.clock, serialPorts: defaults.serialPorts};
    }
    return {settings, startupDiskEnabled: values.startupDiskEnabled};
  }

  // Selects the engine's values and working disk for one stopped host (session.engine is already set).
  function selectEngine(node, engine) {
    const {settings, startupDiskEnabled} = engineSettings(node, engine);
    const image = imageById(node.selectedImage.id);
    const disk = workingDiskPath(node, engine);
    node.engine = engine;
    node.qemuAcceleration = null;
    node.launchSettings = settings;
    node.guestIsoAttached = startupDiskEnabled;
    node.runDisk = fs.existsSync(disk) ? disk : null;
    node.everStarted = !!node.runDisk;
    image.runFiles = node.runDisk ? [node.runDisk] : [];
    node.selectedImage = image;
    node.qemuOptions = engine === 'qemu' && node.runDisk ? qemuOptionsFor(image.id, settings) : null;
    node.activeConfig = null;
    node.lastMessage = node.runDisk ? 'Host stopped; current disk kept' : 'Host ready to start';
  }

  // Hosts whose system has no base image for the session engine: they stay in the session and fail
  // to start with the usual message.
  function unavailableHosts() {
    const engine = ctx.session.engine;
    const format = engine === 'vbox' ? 'vdi' : 'raw';
    return hosts().filter(node => node.selectedImage && !fs.existsSync(imagePath(node.selectedImage.images[format])))
      .map(node => ({id: node.id, name: node.hostname, system: node.selectedImage.id,
        message: `${node.hostname}: no ${ENGINE_NAMES[engine]} image on this server`}));
  }

  function switchEngine(engine) {
    const previous = ctx.session.engine;
    const targets = hosts().filter(node => node.selectedImage);
    ctx.session.engine = engine;
    try {
      for (const node of targets) selectEngine(node, engine);
      ctx.session.saveMetadata(engine);
    } catch (error) {
      ctx.session.engine = previous;
      for (const node of targets) { try { selectEngine(node, previous); } catch (_) { /* keep going */ } }
      throw error;
    }
    return unavailableHosts();
  }

  return {hostsInUse, switchEngine, unavailableHosts, selectEngine};
}

module.exports = {createEngineSwitch, ENGINE_NAMES};
