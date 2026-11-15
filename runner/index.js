'use strict';

// Runner facade: the only module the rest of the code may require from runner/.
// The runner depends only on common/ and Node built-ins. It receives its session by injection
// and reports everything through an EventEmitter (runner.events):
//   state         {nodeId, running, hasLaunched, pendingRestart, message}
//   log           {nodeId, line}
//   logs-reset    {nodeId}
//   serial        {nodeId, data}
//   serial-reset  {nodeId, serial?, preserveLine?}
//   nodes-removed {ids}
// Their payloads are exactly what the web layer forwards to browsers over Socket.IO.
const {configure, ctx} = require('./context');
const {resolveCommands} = require('./preflight');
const guestMedia = require('./media/guest-media');
const {fileSha256} = require('./media/image-hash');
const catalog = require('./catalog');
const runtime = require('./session-runtime');
const hostConfig = require('./host-config');
const guestIso = require('./media/guest-iso');
const serial = require('./console/serial');
const nics = require('./network/nics');
const vde = require('./network/vde-switch');
const lifecycle = require('./node-lifecycle');
const {monitor} = require('./engines/qemu-monitor');
const {previewLaunch} = require('./launch-preview');
const {sampleResources, metricsSnapshot} = require('./resources');

const SAMPLING_INTERVAL_MS = 2000;

function createRunner({session, commands, root, runtimeRoot, configPath}) {
  configure({session, commands, root, runtimeRoot, configPath});
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
