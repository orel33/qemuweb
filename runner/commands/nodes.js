'use strict';

// Node commands: listing, switches, start, stop, Resume all, Stop all, reboot, reset, monitor,
// rename and deletion. Each command receives {session, runner, emit} (runner/service.js) and
// the request arguments; its result is the JSON body of the matching HTTP route.
const {entityKind} = require('../../common/node-id');
const {statusError} = require('./errors');

const commands = {
  'nodes.list': ({runner}) => runner.listNodes(),

  'node.preview': ({runner}, {nodeId, query}) => runner.previewLaunch(nodeId, query || {}),

  // Stops every host, then every switch, and keeps the nodes (the admin's Stop all too).
  'nodes.stopAll': async ({runner}) => ({stopped: await runner.stopAllNodes()}),

  // Starts every stopped switch, then every stopped host (Resume all); running or busy nodes
  // are skipped. A node that cannot start is reported in startErrors and the others still start.
  'nodes.startAll': async ({runner}) => {
    const {started, startErrors} = await runner.startAllNodes();
    return {started, startErrors};
  },

  'node.start': async ({runner}, {nodeId, engine, imageId}) => {
    const {getNode, startSwitch, start, publishState} = runner;
    try {
      const configured = getNode(nodeId);
      if (configured?.kind === 'switch') {
        await startSwitch(configured);
        return {ok: true};
      }
      if (!configured || configured.kind !== 'host' || !configured.selectedImage) throw new Error('Unknown host configuration.');
      if (engine !== configured.engine || imageId !== configured.selectedImage.id) throw new Error('Host system and engine differ from the saved configuration.');
      start(configured.id, configured.engine, configured.selectedImage.id, {
        interfaces: configured.networkInterfaces.map(nic => nic.switchId), settings: configured.launchSettings,
        startupDiskEnabled: configured.guestIsoAttached
      });
      return {ok: true, nodeId: configured.id, name: configured.hostname};
    } catch (error) {
      const message = error.stderr ? error.stderr.toString().trim() : error.message;
      console.error(message);
      let node = null;
      try { node = getNode(nodeId); if (node && node.kind === 'host') publishState(node, message); } catch (_) {}
      throw statusError(message, node?.kind === 'switch' ? 400 : 500);
    }
  },

  'switch.create': async ({session, runner, emit}, {id, name, autostart = true}) => {
    const {getNode, setNodeHostname, persistSwitchConfiguration, startSwitch, stateMessage, destroyNode} = runner;
    let node;
    try {
      if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(name)) throw new Error('Switch name must be 1–32 letters, digits, underscores or hyphens.');
      entityKind(id, 'switch');
      if (session.nodes.has(id)) throw statusError('Switch ID already exists; retry with another ID.', 409);
      if ([...session.nodes.values()].some(s => s.kind === 'switch' && s.hostname === name)) throw new Error('Switch name already exists.');
      node = getNode(id, true, 'switch');
      setNodeHostname(node, name);
      node.lastMessage = 'VDE switch ready to start';
      persistSwitchConfiguration(node);
      session.saveMetadata();
      if (autostart) await startSwitch(node);
      emit('nodes-changed', {nodeId: id, running: !!node.machine, hasLaunched: node.everStarted, message: stateMessage(node)});
      return {id, name, running: !!node.machine, message: stateMessage(node)};
    } catch (error) {
      if (node) {
        try { await destroyNode(node); }
        catch (cleanupError) { console.error('Cannot clean up failed switch:', cleanupError); }
      }
      throw statusError(error.message, error.status || (node ? 500 : 400));
    }
  },

  'node.stop': async ({runner}, {nodeId}) => {
    const {getNode, stopSwitch, stop, publishState} = runner;
    const target = getNode(nodeId);
    if (target?.kind === 'switch') {
      try { await stopSwitch(target); return {ok: true}; }
      catch (error) { throw statusError(error.message, 400); }
    }
    try {
      if (target && target.action) throw new Error('An action is already in progress for this host.');
      await stop(target);
      return {ok: true};
    } catch (error) {
      console.error(error);
      try { const node = getNode(nodeId); if (node) publishState(node, error.message); } catch (_) {}
      throw statusError(error.message, 500);
    }
  },

  'node.reboot': async ({runner}, {nodeId}) => { await runner.reboot(runner.getNode(nodeId)); return {ok: true}; },

  'node.reset': async ({runner}, {nodeId}) => { await runner.reset(runner.getNode(nodeId)); return {ok: true}; },

  'node.monitor': async ({runner}, {nodeId, command}) => ({ok: true, output: await runner.monitor(nodeId, command)}),

  'node.rename': ({session, runner, emit}, {nodeId, name}) => {
    const {getNode, setNodeHostname, persistHostConfiguration} = runner;
    const node = getNode(nodeId);
    if (!node || node.kind !== 'host') throw new Error('Unknown host.');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid name (1 to 64 characters).');
    if ([...session.nodes.values()].some(other => other.id !== node.id && other.hostname === name.trim())) throw new Error('Host name already exists.');
    const previous = node.hostname;
    setNodeHostname(node, name.trim());
    try { persistHostConfiguration(node); }
    catch (error) { setNodeHostname(node, previous); throw error; }
    emit('node-renamed', {nodeId: node.id, name: node.hostname});
    return {name: node.hostname};
  },

  'node.delete': async ({runner, emit}, {nodeId}) => {
    await runner.destroyNode(runner.getNode(nodeId));
    emit('nodes-removed', {ids: [nodeId]});
    return {ok: true};
  },

  // Per-host CPU and memory metrics.
  'nodes.metrics': ({runner}) => runner.metricsSnapshot()
};

module.exports = {commands};
