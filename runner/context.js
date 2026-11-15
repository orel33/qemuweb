'use strict';

// Per-runner context, created once per runner instance by runner/index.js (createRunner).
// Each runner drives one session, so nothing here is shared between runners.
//   session           the session the runner operates on (id, nodes Map, engine, runtimeDir,
//                     resource caches, saveMetadata()); owned by the control plane
//   commands          resolved executable paths (see preflight.js)
//   root              project root, used to resolve image paths from config.json
//   runtimeRoot       the runtime/ directory (only used to shorten paths in previews)
//   configPath        path of config.json
//   availableEngines  engines usable on this server
//   hostNodes()       every node of every session on this server; QEMU/KVM and VirtualBox
//                     cannot run side by side on one machine, whichever session owns them
//   events            EventEmitter through which the runner reports state, logs and
//                     serial output (see runner/index.js for the event list)
// The runner modules are attached to the context as they are created (ctx.catalog,
// ctx.runtime, ...), in dependency order, so that each one can use the previous ones.
const {EventEmitter} = require('events');

function createContext({session, commands, root, runtimeRoot, configPath, hostNodes}) {
  return {
    session, commands, root, runtimeRoot, configPath,
    availableEngines: commands.VBOXMANAGE ? ['qemu', 'vbox'] : ['qemu'],
    hostNodes: hostNodes || (() => [...session.nodes.values()]),
    events: new EventEmitter()
  };
}

module.exports = {createContext};
