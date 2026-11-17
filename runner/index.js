'use strict';

// Runner facade: what the runner process entry point (runner/main.js) and tests use.
//   createRunnerService   every session of this runner and the command dispatcher (service.js)
//   serveConnection       the runner side of one protocol connection (endpoint.js)
//   resolveCommands       executable paths (preflight.js)
// The control plane never requires runner/: it talks to a runner through the protocol
// (server/runner-client.js).
const {createRunnerService} = require('./service');
const {serveConnection} = require('./endpoint');
const {resolveCommands} = require('./preflight');

module.exports = {createRunnerService, serveConnection, resolveCommands};
