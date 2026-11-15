'use strict';

// Ethernet interfaces: validation, MAC and switch port assignment, switch links.
const crypto = require('crypto');

function createNics(ctx) {
  const {getNode} = ctx.runtime;

  function validateNetworkInterfaces(value, engine, requireRunning = true) {
    if (value === undefined) value = [null];
    if (!Array.isArray(value) || value.length > 4) throw new Error('At most four Ethernet interfaces are supported.');
    return value.map((switchId, index) => {
      if (switchId === null) return null;
      const sw = getNode(switchId);
      if (!sw || sw.kind !== 'switch' || (requireRunning && !sw.machine)) throw new Error(`Ethernet ${index}: start its VDE switch first.`);
      return sw;
    });
  }

  function assignNetworkInterfaces(node, switches) {
    const previous = node.networkInterfaces || [];
    const planned = [];
    const otherInterfaces = [...ctx.session.nodes.values()].flatMap(other => [
      ...(other.id === node.id ? [] : other.networkInterfaces || []),
      ...(other.activeConfig?.networkInterfaces || [])
    ]);
    const usedMacs = new Set(otherInterfaces.map(nic => nic.mac));
    for (const [index, sw] of switches.entries()) {
      const switchId = sw?.id ?? null;
      const retained = previous[index];
      if (retained && retained.switchId === switchId) {
        planned.push(retained);
        usedMacs.add(retained.mac);
        continue;
      }
      let mac;
      for (let salt = 0; ; salt++) {
        const digest = crypto.createHash('sha256').update(`${node.id}:${index}${salt ? `:${salt}` : ''}`).digest();
        mac = `02:${[...digest.subarray(0, 5)].map(byte => byte.toString(16).padStart(2, '0')).join(':')}`;
        if (!usedMacs.has(mac)) break;
      }
      usedMacs.add(mac);
      if (sw === null) {
        planned.push({switchId: null, port: null, mac});
        continue;
      }
      const usedPorts = new Set([...otherInterfaces, ...planned]
        .filter(nic => nic.switchId === switchId).map(nic => nic.port));
      const port = Array.from({length: 32}, (_, n) => n + 1).find(n => !usedPorts.has(n));
      if (!port) throw new Error(`No free port on ${sw.hostname}.`);
      planned.push({switchId, port, mac});
    }
    return planned;
  }

  function linkedHosts(switchId) {
    return [...ctx.session.nodes.values()].filter(node => node.kind === 'host' &&
      [...node.networkInterfaces, ...(node.machine ? node.activeConfig?.networkInterfaces || [] : [])]
        .some(nic => nic.switchId === switchId));
  }

  return {validateNetworkInterfaces, assignNetworkInterfaces, linkedHosts};
}

module.exports = {createNics};
