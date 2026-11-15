'use strict';

// Shared runner context, injected once by runner/index.js (createRunner).
//   session           the session the runner operates on (nodes Map, engine, runtimeDir,
//                     resource caches, saveMetadata()); owned by the control plane
//   commands          resolved executable paths (see preflight.js)
//   root              project root, used to resolve image paths from config.json
//   runtimeRoot       the runtime/ directory (only used to shorten paths in previews)
//   configPath        path of config.json
//   availableEngines  engines usable on this server
//   events            EventEmitter through which the runner reports state, logs and
//                     serial output (see runner/index.js for the event list)
const {EventEmitter} = require('events');

const ctx = {
  session: null,
  commands: null,
  root: null,
  runtimeRoot: null,
  configPath: null,
  availableEngines: [],
  events: new EventEmitter()
};

function configure({session, commands, root, runtimeRoot, configPath}) {
  Object.assign(ctx, {
    session, commands, root, runtimeRoot, configPath,
    availableEngines: commands.VBOXMANAGE ? ['qemu', 'vbox'] : ['qemu']
  });
  return ctx;
}

module.exports = {ctx, configure};
