'use strict';

// Every runner the control plane knows, each with its own client (server/runner-client.js).
// An entry: {id, state, capabilities, runtimeRoot, ownerLogin, trusted, client}
//   state         'starting' until its hello, 'online', then 'lost' once its connection closed
//   capabilities  from hello: engines, kvm, cpus, memoryBytes, images, warnings
//   runtimeRoot   the runner's runtime directory as announced in hello (null if absent); the
//                 server touches the runner's files only when it equals its own runtime/
//   ownerLogin    null for a shared runner; reserved for a runner owned by one user (unused)
//   trusted       true only for the local runner (the one started or reached on the server's
//                 own Unix socket, mode 0600): its hello may be adopted (server/session-manager.js).
//                 A hello is untrusted input: later runners (5c) are never trusted by default.
// Events: 'online' (entry, hello) on each hello, 'lost' (entry) once the connection closed.
// There is one entry, "local": the runner of this machine, which dials the server's Unix
// socket (server/runner-gateway.js). pickRunner() is the single place
// where a runner is chosen for a new session.
const path = require('path');
const {EventEmitter} = require('events');

const MAX_PATH = 4096;

class RunnerRegistry extends EventEmitter {
  constructor() {
    super();
    this.runners = new Map();
  }

  // Registers a runner and its client; a previous entry with the same ID must be lost.
  add({id, client, ownerLogin = null, trusted = false}) {
    const previous = this.runners.get(id);
    if (previous && previous.state !== 'lost') throw new Error(`Runner ${id} is already registered.`);
    const entry = {id, state: 'starting', capabilities: null, runtimeRoot: null, ownerLogin, trusted, client};
    this.runners.set(id, entry);
    client.on('hello', hello => {
      if (entry.state === 'lost') return;
      const {engines, kvm, cpus, memoryBytes, images, warnings, runtimeRoot} = hello;
      entry.runtimeRoot = typeof runtimeRoot === 'string' && runtimeRoot.length <= MAX_PATH && path.isAbsolute(runtimeRoot) ? path.resolve(runtimeRoot) : null;
      entry.capabilities = {engines: Array.isArray(engines) ? engines.filter(engine => ['qemu', 'vbox'].includes(engine)) : [],
        kvm: kvm === true, cpus: Number.isSafeInteger(cpus) ? cpus : null,
        memoryBytes: Number.isSafeInteger(memoryBytes) ? memoryBytes : null,
        images: images && typeof images === 'object' && !Array.isArray(images) ? images : {},
        // Text from the runner, shown to the administrator: kept short and bounded.
        warnings: Array.isArray(warnings) ? warnings.filter(item => typeof item === 'string').slice(0, 20).map(item => item.slice(0, 300)) : []};
      entry.state = 'online';
      this.emit('online', entry, hello);
    });
    client.on('close', () => {
      if (entry.state === 'lost') return;
      entry.state = 'lost';
      this.emit('lost', entry);
    });
    return entry;
  }

  get(id) { return this.runners.get(id) || null; }

  list() { return [...this.runners.values()]; }

  // The runner a new session of `login` goes to. Placement arrives in 5c; until then, the
  // local runner when it is online.
  pickRunner(_login) {
    const local = this.runners.get('local');
    if (!local || local.state !== 'online') throw Object.assign(new Error(local?.state === 'starting' ? 'The runner is not ready; try again in a moment.' : 'No runner is connected.'), {status: 503});
    return local;
  }
}

module.exports = {RunnerRegistry};
