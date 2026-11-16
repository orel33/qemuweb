'use strict';

// Runner facade: the only module the rest of the code may require from runner/.
// The runner depends only on common/ and Node built-ins. One runner drives one session, received
// by injection (createRunner() is called once per session), and reports everything through its
// own EventEmitter (runner.events):
//   state         {nodeId, running, hasLaunched, pendingRestart, message}
//   log           {nodeId, line}
//   logs-reset    {nodeId}
//   serial        {nodeId, data}
//   serial-reset  {nodeId, serial?, preserveLine?}
//   nodes-removed {ids}
// Their payloads are exactly what the web layer forwards to browsers over Socket.IO.
const {createContext} = require('./context');
const {resolveCommands} = require('./preflight');
const guestMedia = require('./media/guest-media');
const {fileSha256, fileSha256Async} = require('./media/image-hash');
const {createCatalog} = require('./catalog');
const {createSessionRuntime} = require('./session-runtime');
const {createDisks} = require('./media/disks');
const {createGuestIsoManager} = require('./media/guest-iso');
const {createNics} = require('./network/nics');
const {createQemu} = require('./engines/qemu');
const {createVirtualBox} = require('./engines/vbox');
const {createMonitor} = require('./engines/qemu-monitor');
const {createSerial} = require('./console/serial');
const {createVdeSwitch} = require('./network/vde-switch');
const {createHostConfig} = require('./host-config');
const {createLaunchPreview} = require('./launch-preview');
const {createLifecycle} = require('./node-lifecycle');
const {createResources} = require('./resources');

const SAMPLING_INTERVAL_MS = 2000;

// Creates one runner for one session. Each call returns an independent instance with its
// own context, EventEmitter and resource sampling timer. hostNodes() optionally lists the
// nodes of every session on this machine (see context.js).
function createRunner({session, commands, root, runtimeRoot, configPath, hostNodes}) {
  const ctx = createContext({session, commands, root, runtimeRoot, configPath, hostNodes});
  // Dependency order: each module uses only the modules created before it.
  ctx.catalog = createCatalog(ctx);
  ctx.runtime = createSessionRuntime(ctx);
  ctx.disks = createDisks(ctx);
  ctx.guestIso = createGuestIsoManager(ctx);
  ctx.nics = createNics(ctx);
  ctx.qemu = createQemu(ctx);
  ctx.vbox = createVirtualBox(ctx);
  ctx.monitor = createMonitor(ctx);
  ctx.serial = createSerial(ctx);
  ctx.vde = createVdeSwitch(ctx);
  ctx.hostConfig = createHostConfig(ctx);
  ctx.preview = createLaunchPreview(ctx);
  ctx.lifecycle = createLifecycle(ctx);
  ctx.resources = createResources(ctx);
  const {catalog, runtime, guestIso, nics, vde, hostConfig, lifecycle, serial} = ctx;
  const {previewLaunch} = ctx.preview;
  const {monitor} = ctx.monitor;
  const {sampleResources, metricsSnapshot} = ctx.resources;
  let resourceTimer = null;
  return {
    events: ctx.events,
    availableEngines: ctx.availableEngines,

    // Nodes
    getNode: runtime.getNode,
    createNode: (id, kind, {existingDir = false} = {}) => runtime.getNode(id, true, kind, existingDir),
    listNodes: runtime.listNodes,
    sessionPaths: runtime.sessionPaths,
    stateMessage: runtime.stateMessage,
    pendingRestart: runtime.pendingRestart,
    publishState: runtime.publishState,
    appendLog: runtime.appendLog,
    setNodeHostname: runtime.setNodeHostname,
    removeHostnameAlias: runtime.removeHostnameAlias,
    tempFile: runtime.tempFile,
    startupDirectory: runtime.startupDirectory,
    persistSwitchConfiguration: runtime.persistSwitchConfiguration,
    persistHostConfiguration: hostConfig.persistHostConfiguration,
    hostConfiguration: hostConfig.hostConfiguration,
    hostConfigurationResponse: hostConfig.hostConfigurationResponse,
    previewLaunch,

    // Lifecycle
    start: lifecycle.start,
    stop: lifecycle.stop,
    reboot: lifecycle.reboot,
    reset: lifecycle.reset,
    startSwitch: vde.startSwitch,
    stopSwitch: vde.stopSwitch,
    destroyNode: lifecycle.destroyNode,
    exitAllNodes: lifecycle.exitAllNodes,
    // Stops every running host, then every running switch, and keeps the nodes and their
    // disks. Returns the IDs of the stopped nodes; throws once everything was tried if a node
    // could not be stopped.
    async stopAllNodes() {
      const stopped = [];
      const errors = [];
      for (const kind of ['host', 'switch']) {
        const running = [...session.nodes.values()].filter(node => node.kind === kind && node.machine);
        await Promise.all(running.map(async node => {
          try {
            if (kind === 'host') await lifecycle.stop(node);
            else await vde.stopSwitch(node);
            stopped.push(node.id);
          } catch (error) { errors.push(`${node.hostname || node.id}: ${error.message}`); }
        }));
      }
      if (errors.length) throw new Error(`Some nodes could not be stopped: ${errors.join('; ')}`);
      return stopped;
    },
    shutdown: async () => {
      stopResourceSampling();
      for (const kind of ['host', 'switch']) {
        await Promise.all([...session.nodes.values()].filter(node => node.kind === kind)
          .map(node => lifecycle.destroyNode(node).catch(error => console.error('Session shutdown:', error))));
      }
    },

    // Console and monitor
    attachConsole: serial.attachConsole,
    writeConsoleInput: serial.writeConsoleInput,
    resizeSwitchTerminal: serial.resizeSwitchTerminal,
    clearConsole: serial.clearConsole,
    monitor,

    // Network
    validateNetworkInterfaces: nics.validateNetworkInterfaces,
    assignNetworkInterfaces: nics.assignNetworkInterfaces,

    // System catalog and engine selection
    readConfig: catalog.readConfig,
    imageById: catalog.imageById,
    imagePath: catalog.imagePath,
    allocateName: catalog.allocateName,
    qemuOptionsFor: catalog.qemuOptionsFor,
    launchSettingsFor: catalog.launchSettingsFor,
    requireSessionEngine: catalog.requireSessionEngine,

    // Startup media
    guestIsoStatus: guestIso.guestIsoStatus,
    buildGuestIso: guestIso.buildGuestIso,
    cleanupGuestIsoFiles: guestIso.cleanupGuestIsoFiles,
    media: guestMedia,
    fileSha256,
    fileSha256Async,

    // Resource metrics
    metricsSnapshot,
    startResourceSampling() {
      if (resourceTimer) return;
      resourceTimer = setInterval(() => sampleResources().catch(error => console.error('Resource sampling:', error)), SAMPLING_INTERVAL_MS);
      resourceTimer.unref();
    },
    stopResourceSampling
  };

  function stopResourceSampling() {
    clearInterval(resourceTimer);
    resourceTimer = null;
  }
}

module.exports = {createRunner, resolveCommands};
