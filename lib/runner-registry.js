'use strict';

// Every runner the control plane knows, each with its own client (lib/runner-client.js).
// An entry: {id, state, capabilities, ownerLogin, client}
//   state         'starting' until its hello, 'online', then 'lost' once its connection closed
//   capabilities  from hello: engines, kvm, cpus, memoryBytes, images
//   ownerLogin    null for a shared runner; reserved for a runner owned by one user (unused)
// Events: 'online' (entry, hello) on each hello, 'lost' (entry) once the connection closed,
// after the entry's own onLost(entry) handler, set by whoever started the runner (for the
// local runner, lib/local-runner.js kills its processes while its sessions are still bound).
// In 5a/5b there is one entry, "local", started by server.js; pickRunner() is the single
// place where a runner is chosen for a new session.
const {EventEmitter} = require('events');

class RunnerRegistry extends EventEmitter {
  constructor() {
    super();
    this.runners = new Map();
  }

  // Registers a runner and its client; a previous entry with the same ID must be lost.
  add({id, client, ownerLogin = null, onLost = null}) {
    const previous = this.runners.get(id);
    if (previous && previous.state !== 'lost') throw new Error(`Runner ${id} is already registered.`);
    const entry = {id, state: 'starting', capabilities: null, ownerLogin, client};
    this.runners.set(id, entry);
    client.on('hello', hello => {
      if (entry.state === 'lost') return;
      const {engines, kvm, cpus, memoryBytes, images} = hello;
      entry.capabilities = {engines: Array.isArray(engines) ? engines.filter(engine => ['qemu', 'vbox'].includes(engine)) : [],
        kvm: kvm === true, cpus: Number.isSafeInteger(cpus) ? cpus : null,
        memoryBytes: Number.isSafeInteger(memoryBytes) ? memoryBytes : null,
        images: images && typeof images === 'object' && !Array.isArray(images) ? images : {}};
      entry.state = 'online';
      this.emit('online', entry, hello);
    });
    client.on('close', () => {
      if (entry.state === 'lost') return;
      entry.state = 'lost';
      if (onLost) {
        try { onLost(entry); } catch (error) { console.error(`Runner ${id} loss:`, error); }
      }
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
    if (!local || local.state !== 'online') throw Object.assign(new Error('No runner is available; try again in a moment.'), {status: 503});
    return local;
  }

  // Server stop: every online runner stops every node of its sessions.
  async shutdown() {
    await Promise.all(this.list().filter(entry => entry.state === 'online').map(entry =>
      entry.client.request('runner.shutdown').catch(error => console.error(`Runner ${entry.id} shutdown:`, error.message))));
  }
}

module.exports = {RunnerRegistry};
