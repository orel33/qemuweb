'use strict';

// `runner.sh register`: the same startup sequence as the other forms (command line, banner, Options,
// checks), then the registration itself and the runner file. Never prints the tokens.
const fs = require('fs');
const cli = require('../common/cli');
const {registerSpec} = require('./options');
const {serverUrls} = require('./remote-url');
const {registerRunner} = require('./register');
const {writeRunnerConfig} = require('./config-file');

function run({root, argv}) {
  const spec = registerSpec(root);
  const options = cli.commandLine(spec, argv);
  cli.printBanner('runner');
  cli.printOptions(cli.startupRows(spec, options));
  cli.heading('Checking configuration…');
  let urls;
  try {
    urls = serverUrls(options.url, {insecure: options.insecure});
    if (options.ca) fs.accessSync(options.ca, fs.constants.R_OK);
  } catch (error) {
    cli.failure(error.code === 'ENOENT' ? `certificate authority file ${options.ca} does not exist.` : error.message);
    cli.end();
    cli.abort('runner', 'Registration aborted: a check failed (see above).');
  }
  if (urls.plain) cli.warning(`${urls.base} is not encrypted (--insecure): the registration token and later the traffic can be read on the network.`);
  if (fs.existsSync(options.runnerConfig)) {
    if (!options.force) {
      cli.failure(`${options.runnerConfig} exists: it holds the token of a registered runner, which would be lost (--force replaces it, --runner-config FILE chooses another file).`);
      cli.end();
      cli.abort('runner', 'Registration aborted: a check failed (see above).');
    }
    cli.warning(`${options.runnerConfig} exists and will be replaced: the server keeps the previous registration until an administrator removes it.`);
  }
  cli.pass(`server  ${urls.base}`);
  cli.end();
  registerRunner({registerUrl: urls.registerUrl, token: options.token, name: options.name, ca: options.ca}).then(identity => {
    writeRunnerConfig(options.runnerConfig, {url: urls.base, runnerId: identity.runnerId, authToken: identity.authToken, name: identity.name,
      ...(options.given.has('--runtime') ? {runtime: options.runtime} : {}), ...(options.ca ? {ca: options.ca} : {})});
    cli.pass(`Registered as ${identity.name} (${identity.runnerId}); runner file written to ${options.runnerConfig} (mode 0600).`);
    console.log('\nStart it with ./scripts/runner.sh run (or install its service with ./scripts/qwctl.sh, see docs/deployment.md).');
  }).catch(error => cli.abort('runner', `Registration failed: ${error.message}`));
}

module.exports = {run};
