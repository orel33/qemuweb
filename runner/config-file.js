'use strict';

// The runner file of a remote runner, written by `register` and read by `run`:
// ~/.config/qemuweb-runner/runner.json by default (--runner-config FILE)
// (--runner-config). The directory is 0700 and the file 0600: it holds the authentication token.
//   {"url": "https://qemuweb.example.org", "runnerId": "r-1a2b3c4d", "authToken": "...", "name": "salle-12",
//    "runtime": "/home/me/qemuweb/runtime", "ca": "/home/me/ca.pem",
//    "limits": {"maxSessions": 4, "memoryBytes": 17179869184, "cpus": 8}}
// runtime, ca and limits are optional (limits are edited by hand: the server places no more than
// maxSessions sessions on the runner). The token is never printed.
const fs = require('fs');
const path = require('path');
const {writeJsonAtomic} = require('../common/json-file');

const KEYS = ['url', 'runnerId', 'authToken', 'name', 'runtime', 'ca', 'limits'];
const LIMIT_KEYS = ['maxSessions', 'memoryBytes', 'cpus'];

function validate(data, file) {
  const fail = message => { throw new Error(`${file}: ${message}`); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('not a JSON object.');
  for (const key of Object.keys(data)) if (!KEYS.includes(key)) fail(`unknown field "${key}".`);
  if (typeof data.url !== 'string' || !data.url) fail('"url" is missing.');
  if (typeof data.runnerId !== 'string' || !/^r-[0-9a-f]{8}$/.test(data.runnerId)) fail('"runnerId" is missing or invalid.');
  if (typeof data.authToken !== 'string' || !data.authToken || data.authToken.length > 256) fail('"authToken" is missing or invalid.');
  if (typeof data.name !== 'string') fail('"name" is missing.');
  for (const key of ['runtime', 'ca']) if (data[key] !== undefined && (typeof data[key] !== 'string' || !path.isAbsolute(data[key]))) fail(`"${key}" must be an absolute path.`);
  if (data.limits !== undefined) {
    if (!data.limits || typeof data.limits !== 'object' || Array.isArray(data.limits)) fail('"limits" must be an object.');
    for (const [key, value] of Object.entries(data.limits)) {
      if (!LIMIT_KEYS.includes(key) || !Number.isSafeInteger(value) || value <= 0) fail(`invalid limit "${key}": expected ${LIMIT_KEYS.join(', ')} as positive whole numbers.`);
    }
  }
  return data;
}

// The configuration, or an Error that says what is wrong (a missing file: run register first).
function readRunnerConfig(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${file} does not exist: register this runner first (./scripts/runner.sh register --help).`);
    throw error;
  }
  let data;
  try { data = JSON.parse(text); }
  catch (error) { throw new Error(`Cannot parse ${file}: ${error.message}`); }
  return validate(data, file);
}

// Writes the file (mode 0600) in a directory of mode 0700, creating it.
function writeRunnerConfig(file, config) {
  validate(config, file);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  fs.chmodSync(directory, 0o700);
  writeJsonAtomic(file, Object.fromEntries(KEYS.filter(key => config[key] !== undefined).map(key => [key, config[key]])));
  fs.chmodSync(file, 0o600);
}

module.exports = {validateRunnerConfig: validate, readRunnerConfig, writeRunnerConfig};
