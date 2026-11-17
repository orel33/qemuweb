'use strict';

// The command line of the server: --listen <port> (--help is handled by main.js). `given`
// remembers whether it was present, for the startup report. The runtime directory is always
// runtime/ of the repository.
const DEFAULT_PORT = 3002;

function parseServerArguments(argv) {
  const options = {port: DEFAULT_PORT, given: new Set()};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name !== '--listen') throw new Error(`Unknown argument: ${name}`);
    if (index + 1 >= argv.length) throw new Error(`Missing value for ${name}`);
    const value = argv[++index];
    if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`Invalid port for --listen: ${value} (1 to 65535)`);
    options.given.add(name);
    options.port = Number(value);
  }
  return options;
}

module.exports = {parseServerArguments, DEFAULT_PORT};
