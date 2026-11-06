'use strict';

function parseTopology(text, systems, mapping = {}) {
  if (typeof text !== 'string' || text.length > 262144) throw new Error('Topology must be text under 256 KB.');
  const known = new Set(systems);
  const names = new Set();
  const switches = [];
  const hosts = [];
  const unknown = new Set();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const words = line.split(/\s+/);
    const type = words.shift();
    if (type !== 'SWITCH' && type !== 'HOST') throw new Error(`Line ${index + 1}: unsupported directive ${type}.`);
    if ((type === 'SWITCH' && words.length !== 1) || (type === 'HOST' && (words.length < 2 || words.length > 6))) throw new Error(`Line ${index + 1}: invalid ${type} syntax or interface limit exceeded.`);
    const system = type === 'HOST' ? words.shift() : null;
    const name = words.shift();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name)) throw new Error(`Line ${index + 1}: invalid name ${name}.`);
    if (names.has(name.toLowerCase())) throw new Error(`Line ${index + 1}: duplicate name ${name}.`);
    names.add(name.toLowerCase());
    if (type === 'SWITCH') switches.push({name});
    else {
      const resolved = known.has(system) ? system : mapping[system];
      if (!known.has(resolved)) unknown.add(system);
      hosts.push({name, system: resolved || system, switches: words});
    }
  }
  if (unknown.size) {
    const error = new Error(`Unknown systems: ${[...unknown].join(', ')}. Choose a mapping.`);
    error.unknownSystems = [...unknown];
    throw error;
  }
  const switchNames = new Set(switches.map(sw => sw.name));
  const ports = new Map();
  for (const host of hosts) for (const name of host.switches) {
    if (!switchNames.has(name)) throw new Error(`Host ${host.name}: unknown switch ${name}.`);
    const count = (ports.get(name) || 0) + 1;
    if (count > 32) throw new Error(`Switch ${name}: maximum 32 ports.`);
    ports.set(name, count);
  }
  if (!switches.length && !hosts.length) throw new Error('Topology is empty.');
  return {switches, hosts};
}

function formatTopology(topology) {
  return [...topology.switches.map(sw => `SWITCH ${sw.name}`), ...topology.hosts.map(host => ['HOST', host.system, host.name, ...host.switches].join(' '))].join('\n') + '\n';
}

module.exports = {parseTopology, formatTopology};
