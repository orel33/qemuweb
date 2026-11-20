'use strict';

const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const cli = require('../common/cli');

// A runner needs the common tools and at least one engine: a missing engine only disables the
// hosts of that engine (config.json is shared by runners that do not all have both).
const requiredKeys = ['VDE_SWITCH', 'VDETERM', 'GENISOIMAGE', 'NODE', 'PYTHON3'];
const engineKeys = {qemu: ['QEMU_SYSTEM_X86_64', 'QEMU_IMG'], vbox: ['VBOXMANAGE']};
const engineNames = {qemu: 'QEMU', vbox: 'VirtualBox'};
// tcpdump serves the live view of the Capture dialog only (runner/capture-live.js): without it the
// runner starts and the capture itself, written by QEMU, keeps working.
const toolKeys = ['TCPDUMP'];
const optionalKeys = [...engineKeys.qemu, ...engineKeys.vbox, ...toolKeys];
// Directories searched after PATH: tcpdump lives in an sbin directory a user's PATH often lacks.
const extraDirectories = {TCPDUMP: ['/usr/sbin', '/sbin', '/usr/local/sbin']};
const commandLabels = {
  QEMU_SYSTEM_X86_64: 'QEMU',
  QEMU_IMG: 'QEMU disk tools',
  VBOXMANAGE: 'VirtualBox',
  TCPDUMP: 'tcpdump',
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

function findCommand(value, extraDirs = []) {
  if (!value) throw new Error('no command configured');
  if (path.isAbsolute(value)) {
    if (!executable(value)) throw new Error(`not executable: ${value}`);
    return value;
  }
  if (!/^[a-zA-Z0-9_.+-]+$/.test(value)) throw new Error('expected a command name in PATH or an absolute path');
  for (const directory of [...(process.env.PATH || '').split(path.delimiter), ...extraDirs]) {
    if (!directory) continue;
    const candidate = path.join(directory, value);
    if (executable(candidate)) return candidate;
  }
  throw new Error(`not found in PATH: ${value}`);
}

function resolveCommands(root) {
  const base = readEnvFile(path.join(root, '.env'));
  const local = readEnvFile(path.join(root, '.env.local'));
  const missing = [...requiredKeys, ...engineKeys.qemu].filter(key => !Object.hasOwn(base, key));
  if (missing.length) throw new Error(`Missing command defaults in .env: ${missing.join(', ')}`);
  const commands = {};
  const failures = [];
  const labelWidth = Math.max(...[...requiredKeys, ...optionalKeys].map(key => commandLabels[key].length));
  cli.heading('Checking dependencies…');
  for (const key of [...requiredKeys, ...optionalKeys]) {
    const defaultCommand = base[key];
    const label = commandLabels[key].padEnd(labelWidth);
    const configured = local[key] || process.env[key] || defaultCommand;
    const source = local[key] ? '.env.local' : process.env[key] ? 'environment' : '.env';
    const setting = `${key}=${configured ?? ""}, ${source}`;
    try {
      const resolved = findCommand(configured, extraDirectories[key]);
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
          throw new Error('QEMU lacks VDE support. See docs/install.md > Troubleshooting > QEMU without VDE support.');
        }
      }
      commands[key] = resolved;
      cli.pass(`${label}  ${resolved}  (${setting})`);
    } catch (error) {
      if (requiredKeys.includes(key)) {
        failures.push(key);
        cli.failure(`${label}  ${error.message}  (${setting})`);
      } else {
        commands[key] = null;
        const engine = Object.keys(engineKeys).find(name => engineKeys[name].includes(key));
        const effect = engine ? `${engineNames[engine]} hosts disabled` : 'the live view of captures is unavailable';
        cli.skipped(`${label}  unavailable (${error.message}); ${effect}  (${setting})`);
      }
    }
  }
  // Informational: VirtualBox 7.1 and QEMU/KVM cannot hold VT-x/AMD-V at the same time.
  if (commands.VBOXMANAGE && commands.QEMU_SYSTEM_X86_64) {
    cli.skipped('VirtualBox and QEMU/KVM hosts cannot run at the same time on this machine: the runner refuses to start one while the other runs');
  }
  cli.end();
  if (failures.length) throw new Error(`Startup aborted: unavailable commands: ${failures.join(', ')}`);
  if (!availableEngines(commands).length) throw new Error('Startup aborted: no virtualization engine is available; install QEMU (with KVM) or VirtualBox.');
  return commands;
}

// The engines a set of resolved commands can run: QEMU needs its emulator and disk tool.
function availableEngines(commands) {
  return Object.keys(engineKeys).filter(engine => engineKeys[engine].every(key => commands[key]));
}

module.exports = {resolveCommands, availableEngines, findCommand};
