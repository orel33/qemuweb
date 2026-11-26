'use strict';

// Topology (.topo) commands: preview, loading and export. Each command receives
// {session, runner, emit} (runner/service.js) and the request arguments; its result is the
// JSON body (or, for topology.export, the text) of the matching HTTP route.
const {newEntityId} = require('../../common/node-id');
const {parseTopology, formatTopology} = require('../../common/topology');

function validateTopologyRequest({session, runner}, body) {
  const {text, engine = session.engine} = body || {};
  if (!['qemu', 'vbox'].includes(engine)) throw new Error('Unknown engine.');
  runner.requireSessionEngine(engine);
  const topology = parseTopology(text, Object.keys(runner.readConfig().systems).filter(id => id !== 'default'));
  return {topology, engine};
}

const commands = {
  'topology.preview': (context, {body}) => {
    const {topology} = validateTopologyRequest(context, body);
    return {hosts: topology.hosts.length, switches: topology.switches.length, links: topology.hosts.reduce((count, host) => count + host.switches.length, 0)};
  },

  'topology.load': async (context, {body}) => {
    const {session, runner, emit} = context;
    const {getNode, setNodeHostname, persistSwitchConfiguration, persistHostConfiguration,
      startupDirectory, imageById, launchSettingsFor, assignNetworkInterfaces,
      validateNetworkInterfaces, startSwitch, start, publishState, destroyNode} = runner;
    const {defaultStartupScript, writeStartupScript, readStartupFiles} = runner.media;
    const created = [];
    try {
      const {topology, engine} = validateTopologyRequest(context, body);
      const {autostart = false} = body || {};
      if (typeof autostart !== 'boolean') throw new Error('Invalid topology options.');
      const used = new Set([...session.nodes.values()].map(node => node.hostname?.toLowerCase()));
      for (const entry of [...topology.switches, ...topology.hosts]) if (used.has(entry.name.toLowerCase())) throw new Error(`Name already exists: ${entry.name}.`);
      const switchIds = new Map();
      for (const sw of topology.switches) {
        const id = newEntityId('switch', session.nodes);
        const node = getNode(id, true, 'switch'); created.push(id);
        setNodeHostname(node, sw.name); node.lastMessage = 'VDE switch ready to start';
        persistSwitchConfiguration(node);
        switchIds.set(sw.name, id);
      }
      for (const host of topology.hosts) {
        const id = newEntityId('host', session.nodes);
        const interfaces = assignNetworkInterfaces({id}, validateNetworkInterfaces(host.switches.map(name => switchIds.get(name)), engine, false));
        const node = getNode(id, true, 'host'); created.push(id);
        setNodeHostname(node, host.name); node.selectedImage = imageById(host.system); node.engine = engine;
        node.networkInterfaces = interfaces; node.launchSettings = launchSettingsFor(host.system);
        node.guestIsoAttached = node.selectedImage.startupDiskEnabled;
        writeStartupScript(startupDirectory(node), defaultStartupScript(interfaces));
        node.guestMedia = readStartupFiles(startupDirectory(node));
        node.lastMessage = 'Host ready to start';
        persistHostConfiguration(node);
      }
      session.saveMetadata();
      const errors = [];
      if (autostart) {
        for (const id of created) {
          const node = session.nodes.get(id);
          try {
            if (node.kind === 'switch') await startSwitch(node);
            else start(id, engine, node.selectedImage.id, {interfaces: node.networkInterfaces.map(nic => nic.switchId)});
          } catch (error) {
            node.lastMessage = `Start failed: ${error.message}`;
            errors.push(`${node.hostname}: ${error.message}`);
            publishState(node, node.lastMessage);
          }
        }
      }
      if (created.length) emit('nodes-changed', {nodeId: null});
      return {created: created.length, errors};
    } catch (error) {
      for (const id of created.reverse()) {
        const node = session.nodes.get(id);
        if (node) {
          try { await destroyNode(node); }
          catch (cleanupError) { console.error('Topology rollback:', cleanupError); }
        }
      }
      throw error;
    }
  },

  // The session as .topo text.
  'topology.export': ({session, runner}) => {
    const all = [...session.nodes.values()];
    const switches = all.filter(node => node.kind === 'switch').map(node => ({name: node.hostname}));
    const hosts = all.filter(node => node.kind === 'host').map(node => ({
      name: node.hostname, system: node.selectedImage?.id,
      switches: node.networkInterfaces.map(nic => {
        const sw = nic.switchId && session.nodes.get(nic.switchId);
        if (!sw || sw.kind !== 'switch') throw new Error(`Host ${node.hostname} has a disconnected interface; .topo cannot represent it.`);
        return sw.hostname;
      })
    }));
    const text = formatTopology({switches, hosts});
    parseTopology(text, Object.keys(runner.readConfig().systems).filter(id => id !== 'default'));
    return {text};
  }
};

module.exports = {commands};
