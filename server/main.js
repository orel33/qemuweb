'use strict';

// Entry point of the server: `node server/main.js [options]` (see --help), started by
// scripts/server.sh. It waits for a runner (./scripts/runner.sh, which reads the token file of --local-runner), which keeps its VMs if the server
// restarts; ./scripts/start.sh (npm start) runs both. The sequence is the runner's (runner/main.js):
// the command line first, so that --help and a bad option answer at once, then the banner, the
// Options block and the checks; the web stack (server/serve.js: express, Socket.IO, sessions,
// routes) is loaded only when they have passed.
const path = require('path');
const cli = require('../common/cli');
const {serverSpec} = require('./options');
const {tokenFilePath} = require('../common/local-token');

const root = path.join(__dirname, '..');
const spec = serverSpec(root);
const settings = cli.commandLine(spec, process.argv.slice(2));
cli.printBanner('server');
cli.printOptions(cli.startupRows(spec, settings, settings.localRunner ? [['Local runner token', tokenFilePath(settings.runtime)]] : []));
const checks = require('./startup-checks');
cli.heading('Checking dependencies…');
const dependenciesOk = checks.checkDependencies({packageInfo: require('../package.json')});
cli.end();
if (!dependenciesOk || !checks.checkStartup({root, settings})) cli.abort('server', 'Startup aborted: a check failed (see above).');
require('./serve').serve({root, settings});
