'use strict';

const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const requiredKeys = ['VBOXMANAGE', 'GENISOIMAGE', 'NODE', 'PYTHON3', 'QEMU_IMG', 'QEMU_SYSTEM_X86_64', 'VDE_SWITCH'];

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const values = {};
  for (const [index, raw] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid ${path.basename(file)} line ${index + 1}: expected NAME=value`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function executable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  }
  catch (_) { return false; }
}

function findCommand(value) {
  if (!value) throw new Error('no command configured');
  if (path.isAbsolute(value)) {
    if (!executable(value)) throw new Error(`not executable: ${value}`);
    return value;
  }
  if (!/^[a-zA-Z0-9_.+-]+$/.test(value)) throw new Error('expected a command name in PATH or an absolute path');
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, value);
    if (executable(candidate)) return candidate;
  }
  throw new Error(`not found in PATH: ${value}`);
}

function resolveCommands(root) {
  const base = readEnvFile(path.join(root, '.env'));
  const local = readEnvFile(path.join(root, '.env.local'));
  const missing = requiredKeys.filter(key => !Object.hasOwn(base, key));
  if (missing.length) throw new Error(`Missing command defaults in .env: ${missing.join(', ')}`);
  const commands = {};
  const failures = [];
  for (const [key, defaultCommand] of Object.entries(base)) {
    try {
      const configured = local[key] || process.env[key] || defaultCommand;
      const resolved = findCommand(configured);
      const result = spawnSync(resolved, ['--version'], {encoding: 'utf8', timeout: 5000, maxBuffer: 65536});
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error((result.stderr || result.stdout || `exit status ${result.status}`).trim().split('\n')[0]);
      commands[key] = resolved;
      console.log(`\x1b[32m✓\x1b[0m ${key}: ${resolved}`);
    } catch (error) {
      failures.push(key);
      console.error(`\x1b[31m✗\x1b[0m ${key}: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(`Startup aborted: unavailable commands: ${failures.join(', ')}`);
  return commands;
}

module.exports = {resolveCommands};
