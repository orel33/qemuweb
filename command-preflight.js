'use strict';

const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const requiredKeys = ['QEMU_SYSTEM_X86_64', 'QEMU_IMG', 'VDE_SWITCH', 'VDETERM', 'GENISOIMAGE', 'NODE', 'PYTHON3'];
const optionalKeys = ['VBOXMANAGE'];
const allKeys = [...requiredKeys, ...optionalKeys];
const commandLabels = {
  QEMU_SYSTEM_X86_64: 'QEMU',
  QEMU_IMG: 'QEMU disk tools',
  VBOXMANAGE: 'VirtualBox',
  VDE_SWITCH: 'VDE switch',
  VDETERM: 'VDE terminal',
  GENISOIMAGE: 'ISO image tool',
  NODE: 'Node.js',
  PYTHON3: 'Python 3'
};

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

function findCommandCandidates(value, key) {
  if (key === 'GENISOIMAGE' && value === 'genisoimage') {
    for (const name of ['genisoimage', 'mkisofs', 'xorrisofs']) {
      try { return findCommand(name); } catch (_) {}
    }
  }
  return findCommand(value);
}

function fixPtyHelperPermissions(root) {
  try {
    const nodePtyPkg = require.resolve('node-pty/package.json', {paths: [root]});
    const nodePtyDir = path.dirname(nodePtyPkg);
    const prebuildsDir = path.join(nodePtyDir, 'prebuilds');
    if (fs.existsSync(prebuildsDir)) {
      for (const entry of fs.readdirSync(prebuildsDir, {withFileTypes: true})) {
        if (entry.isDirectory()) {
          const helper = path.join(prebuildsDir, entry.name, 'spawn-helper');
          if (fs.existsSync(helper)) {
            try { fs.chmodSync(helper, 0o755); } catch (_) {}
          }
        }
      }
    }
  } catch (_) {}
}

function resolveCommands(root) {
  const base = readEnvFile(path.join(root, '.env'));
  const local = readEnvFile(path.join(root, '.env.local'));
  const missing = allKeys.filter(key => !Object.hasOwn(base, key));
  if (missing.length) throw new Error(`Missing command defaults in .env: ${missing.join(', ')}`);
  const commands = {};
  const failures = [];
  const labelWidth = Math.max(...allKeys.map(key => commandLabels[key].length));
  console.log('Checking dependencies…');
  for (const key of allKeys) {
    const defaultCommand = base[key];
    const label = commandLabels[key].padEnd(labelWidth);
    try {
      const configured = local[key] || process.env[key] || defaultCommand;
      const resolved = findCommandCandidates(configured, key);
      // vdeterm treats its first argument as a management socket and has no version flag.
      if (key !== 'VDETERM') {
        const result = spawnSync(resolved, ['--version'], {encoding: 'utf8', timeout: 5000, maxBuffer: 65536});
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error((result.stderr || result.stdout || `exit status ${result.status}`).trim().split('\n')[0]);
      }
      if (key === 'QEMU_SYSTEM_X86_64') {
        const result = spawnSync(resolved, ['-netdev', 'help'], {encoding: 'utf8', timeout: 5000, maxBuffer: 65536});
        if (result.error) throw result.error;
        if (!/(^|\s)vde(\s|$)/m.test(`${result.stdout}\n${result.stderr}`)) {
          throw new Error('QEMU lacks VDE support. See README.md > Troubleshooting > Install QEMU.');
        }
      }
      commands[key] = resolved;
      console.log(`  \x1b[32m✓\x1b[0m ${label}  ${resolved}`);
    } catch (error) {
      if (requiredKeys.includes(key)) {
        failures.push(key);
        console.error(`  \x1b[31m✗\x1b[0m ${label}  ${error.message}`);
      } else {
        commands[key] = null;
        console.log(`  - ${label}  unavailable (${error.message}); VirtualBox hosts disabled`);
      }
    }
  }
  if (failures.length) throw new Error(`Startup aborted: unavailable commands: ${failures.join(', ')}`);
  fixPtyHelperPermissions(root);
  return commands;
}

module.exports = {resolveCommands};
