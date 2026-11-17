'use strict';

// Every runner the control plane knows, each with its own client (server/runner-client.js).
// An entry: {id, name, state, capabilities, ownerLogin, local, trusted, paused, registeredAt,
//            address, connectedAt, lostAt, client}
//   state         'starting' until its hello, 'online', then 'lost' once its connection closed
//   capabilities  from hello: engines, kvm, cpus, memoryBytes, images, warnings, limits ({maxSessions})
//   local         true only for the runner that dialled the server's own Unix socket
//                 (server/runner-gateway.js). It is the one fact that lets the server touch a
//                 runner's files (session directories, aliases): never the paths a hello announces,
//                 which any remote runner could forge.
//   trusted       true only for the local runner: its hello may be adopted (server/session-manager.js).
//                 A hello is untrusted input: a remote runner is never trusted.
//   paused        drained by an administrator: no new session is placed on it, the running ones continue
//   registeredAt  ordering of the runners for placement ties (0 for the local runner)
//   address       the remote end of a remote runner (text, bounded), else null
//   ownerLogin    null for a shared runner; reserved for a runner owned by one user (unused)
// Events: 'online' (entry, hello) on each hello, 'lost' (entry) once the connection closed.
// The local runner has the entry "local"; a remote runner has its registered ID (server/runner-store.js)
// and, once lost, its entry stays (state 'lost') until it reconnects: add() then replaces it.
// pickRunner() is the single place where a runner is chosen for a new session.
const {EventEmitter} = require('events');

const MAX_LIMIT = 1e6;

class RunnerRegistry extends EventEmitter {
  constructor() {
    super();
    this.runners = new Map();
  }

  // Registers a runner and its client; a previous entry with the same ID must be lost.
  add({id, client, name = id, local = false, trusted = false, paused = false, registeredAt = 0, address = null, ownerLogin = null}) {
    const previous = this.runners.get(id);
    if (previous && previous.state !== 'lost') throw new Error(`Runner ${id} is already registered.`);
    const entry = {id, name, state: 'starting', capabilities: null, ownerLogin, local, trusted, paused, registeredAt, address,
      connectedAt: Date.now(), lostAt: null, client};
    this.runners.set(id, entry);
    client.on('hello', hello => {
      if (entry.state === 'lost') return;
      const {engines, kvm, cpus, memoryBytes, images, warnings, limits} = hello;
      const maxSessions = limits?.maxSessions;
      entry.capabilities = {engines: Array.isArray(engines) ? engines.filter(engine => ['qemu', 'vbox'].includes(engine)) : [],
        kvm: kvm === true, cpus: Number.isSafeInteger(cpus) ? cpus : null,
        memoryBytes: Number.isSafeInteger(memoryBytes) ? memoryBytes : null,
        images: images && typeof images === 'object' && !Array.isArray(images) ? images : {},
        // Text from the runner, shown to the administrator: kept short and bounded.
        warnings: Array.isArray(warnings) ? warnings.filter(item => typeof item === 'string').slice(0, 20).map(item => item.slice(0, 300)) : [],
        limits: {maxSessions: Number.isSafeInteger(maxSessions) && maxSessions > 0 && maxSessions <= MAX_LIMIT ? maxSessions : null}};
      entry.state = 'online';
      this.emit('online', entry, hello);
    });
    client.on('close', () => {
      if (entry.state === 'lost') return;
      entry.state = 'lost';
      entry.lostAt = Date.now();
      this.emit('lost', entry);
    });
    return entry;
  }

  get(id) { return this.runners.get(id) || null; }

  list() { return [...this.runners.values()]; }

  // Forgets a lost runner (an administrator removed it).
  remove(id) {
    const entry = this.runners.get(id);
    if (entry && entry.state === 'lost') this.runners.delete(id);
  }

  // The runner a new session of `login` goes to. `sessionsOf(runnerId)` counts the sessions a
  // runner already holds. Candidates: online, not paused, with an engine, under their maxSessions.
  // The least loaded wins (sessions / maxSessions, the plain count when there is no limit); a
  // tie goes to the local runner, then to the earliest registered. Throws a 503 when there is
  // none; the reasons go to the server log.
  pickRunner(_login, sessionsOf = () => 0) {
    const candidates = [];
    const reasons = [];
    for (const entry of this.runners.values()) {
      const maxSessions = entry.capabilities?.limits?.maxSessions ?? null;
      const sessions = sessionsOf(entry.id);
      if (entry.state !== 'online') reasons.push(`${entry.id}: ${entry.state === 'lost' ? 'offline' : 'not ready'}`);
      else if (entry.paused) reasons.push(`${entry.id}: paused`);
      else if (!entry.capabilities.engines.length) reasons.push(`${entry.id}: no engine`);
      else if (maxSessions !== null && sessions >= maxSessions) reasons.push(`${entry.id}: full (${sessions}/${maxSessions})`);
      else candidates.push({entry, load: maxSessions ? sessions / maxSessions : sessions});
    }
    if (!candidates.length) {
      console.warn(`No runner is available${reasons.length ? ` (${reasons.join('; ')})` : ' (none registered)'}.`);
      const starting = [...this.runners.values()].some(entry => entry.state === 'starting');
      throw Object.assign(new Error(starting ? 'The runner is not ready; try again in a moment.' : 'No runner is available.'), {status: 503});
    }
    candidates.sort((a, b) => a.load - b.load || Number(b.entry.local) - Number(a.entry.local) || a.entry.registeredAt - b.entry.registeredAt);
    return candidates[0].entry;
  }
}

module.exports = {RunnerRegistry};
