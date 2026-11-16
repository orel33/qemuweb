'use strict';

// Per-session context, created once per session by runner/session-runner.js
// (createSessionRunner). Nothing here is shared between sessions, except hostNodes() and flow.
//   session           the session (runner/session.js: id, nodes Map, engine, runtimeDir,
//                     resource caches, saveMetadata())
//   commands          resolved executable paths (see preflight.js)
//   root              project root, used to resolve image paths from config.json
//   runtimeRoot       the runtime directory of the runner (only used to shorten paths in previews)
//   configPath        path of config.json
//   availableEngines  engines usable on this runner
//   hostNodes()       every node of every session of this runner; QEMU/KVM and VirtualBox
//                     cannot run side by side on one machine, whichever session owns them
//   flow              {paused}: console sources (serial sockets, switch terminals) are paused
//                     while the control connection is congested (runner/endpoint.js)
//   events            EventEmitter through which the runner reports state, logs and
//                     serial output (see runner/session-runner.js for the event list)
// The runner modules are attached to the context as they are created (ctx.catalog,
// ctx.runtime, ...), in dependency order, so that each one can use the previous ones.
const {EventEmitter} = require('events');

function createContext({session, commands, root, runtimeRoot, configPath, hostNodes, flow}) {
  return {
    session, commands, root, runtimeRoot, configPath,
    availableEngines: commands.VBOXMANAGE ? ['qemu', 'vbox'] : ['qemu'],
    hostNodes: hostNodes || (() => [...session.nodes.values()]),
    flow: flow || {paused: false},
    events: new EventEmitter()
  };
}

module.exports = {createContext};
