'use strict';

// What `runner.sh run` knows about itself before it connects: the runner file written by register
// (runner/config-file.js) and the server it designates, merged with the options (an option wins; a
// value taken from the file is shown as "(runner file)" in the Options block), and the checks
// printed in "Checking configuration…". The authentication token is never printed.
const fs = require('fs');
const cli = require('../common/cli');
const {readRunnerConfig} = require('./config-file');
const {serverUrls} = require('./remote-url');
const {remoteRunnerRuntime} = require('../common/runtime-dir');

const octal = mode => (mode & 0o777).toString(8).padStart(4, '0');

// Reads the runner file and completes `options` (url, ca, runtime, sources). Returns
// {config, urls, derivedRows(), printChecks()}; an unreadable file or a bad URL is reported
// by printChecks, not thrown.
function load(options) {
  let config = null;
  let fileError = null;
  try { config = readRunnerConfig(options.runnerConfig); } catch (error) { fileError = error; }
  options.sources = {};
  for (const [flag, key] of [['--url', 'url'], ['--ca', 'ca'], ['--runtime', 'runtime']]) {
    if (config && config[key] && !options.given.has(flag)) {
      options[key] = config[key];
      options.sources[flag] = 'runner file';
    }
  }
  // No --runtime and none in the runner file: the default directory is named after the runner's id (two runners of one account never share one).
  if (!options.runtime && config) options.runtime = remoteRunnerRuntime(config.runnerId);
  let urls = null;
  let urlError = null;
  if (options.url) {
    try { urls = serverUrls(options.url, {insecure: options.insecure}); } catch (error) { urlError = error; }
  }

  function printChecks() {
    if (fileError) { cli.failure(fileError.message); return false; }
    let ok = true;
    const mode = fs.statSync(options.runnerConfig).mode;
    cli.pass(`${options.runnerConfig}  (mode ${octal(mode)})`);
    if (mode & 0o077) cli.warning(`${options.runnerConfig} can be read by other users and holds the token of this runner: chmod 600 it.`);
    cli.pass(`registered as ${config.name} (${config.runnerId}) on ${urls ? urls.base : options.url}`);
    if (urlError) { cli.failure(urlError.message); ok = false; }
    else if (urls.plain) cli.warning(`${urls.base} is not encrypted (--insecure): the token and the traffic can be read on the network.`);
    if (options.ca && !fs.existsSync(options.ca)) { cli.failure(`certificate authority file ${options.ca} does not exist.`); ok = false; }
    return ok;
  }

  return {config, fileError, urls, printChecks,
    derivedRows: () => [['Runner', config ? `${config.name} (${config.runnerId})` : 'not registered'], ...(urls ? [['Server WebSocket', urls.connectUrl]] : [])]};
}

module.exports = {load};
