'use strict';

// The command line of the server: --listen <port> and --runtime <dir> (--help is handled by
// main.js). Each value remembers whether it was given or is the default, for the startup report.
const path = require('path');

const DEFAULT_PORT = 3002;

function parseServerArguments(argv, {root}) {
  const options = {port: DEFAULT_PORT, runtime: path.join(root, 'runtime'), given: new Set()};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name !== '--listen' && name !== '--runtime') throw new Error(`Unknown argument: ${name}`);
    if (index + 1 >= argv.length) throw new Error(`Missing value for ${name}`);
    const value = argv[++index];
    options.given.add(name);
    if (name === '--listen') {
      if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`Invalid port for --listen: ${value} (1 to 65535)`);
      options.port = Number(value);
    } else {
      options.runtime = path.resolve(value);
    }
  }
  return options;
}

module.exports = {parseServerArguments, DEFAULT_PORT};
