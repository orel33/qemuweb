'use strict';

// The runner's start-up check (runner/preflight.js) with fake programs in temporary directories:
// tcpdump is an optional tool found in PATH or in an sbin directory; a missing one is reported on
// its line of the table and never stops the runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {resolveCommands, findCommand} = require('../../runner/preflight');

const ENV_FILE = ['VBOXMANAGE=VBoxManage', 'GENISOIMAGE=genisoimage', 'NODE=node', 'PYTHON3=python3', 'QEMU_IMG=qemu-img',
  'QEMU_SYSTEM_X86_64=qemu-system-x86_64', 'TCPDUMP=tcpdump', 'VDE_SWITCH=vde_switch', 'VDETERM=vdeterm'].join('\n');

function fakeProgram(dir, name) {
  // Answers --version, and lists the vde netdev for `-netdev help` (the QEMU check).
  fs.writeFileSync(path.join(dir, name), '#!/bin/sh\necho "fake $0 1.0"\necho vde\n', {mode: 0o755});
}

function withRunnerFixture(t, {tools = [], envFile = ENV_FILE} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-preflight-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, '.env'), envFile);
  for (const name of ['vde_switch', 'vdeterm', 'genisoimage', 'node', 'python3', 'qemu-system-x86_64', 'qemu-img', ...tools]) fakeProgram(bin, name);
  const saved = {PATH: process.env.PATH, TCPDUMP: process.env.TCPDUMP, log: console.log, error: console.error};
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  process.env.PATH = bin;
  delete process.env.TCPDUMP;
  t.after(() => {
    process.env.PATH = saved.PATH;
    if (saved.TCPDUMP !== undefined) process.env.TCPDUMP = saved.TCPDUMP;
    console.log = saved.log;
    console.error = saved.error;
    fs.rmSync(root, {recursive: true, force: true});
  });
  return {root, bin, lines};
}

test('findCommand searches PATH, then the extra directories, for a bare name', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-find-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; });
  process.env.PATH = '/nonexistent';
  assert.throws(() => findCommand('tcpdump', [dir]), /not found in PATH: tcpdump/, 'not there yet');
  fs.writeFileSync(path.join(dir, 'tcpdump'), '#!/bin/sh\n', {mode: 0o755});
  assert.equal(findCommand('tcpdump', [dir]), path.join(dir, 'tcpdump'), 'found only in an extra (sbin) directory');
  assert.throws(() => findCommand('tcpdump'), /not found in PATH/, 'extra directories are not searched by default');
  process.env.PATH = `/nonexistent:${dir}`;
  assert.equal(findCommand('tcpdump'), path.join(dir, 'tcpdump'), 'found in PATH');
  fs.chmodSync(path.join(dir, 'tcpdump'), 0o644);
  assert.throws(() => findCommand('tcpdump'), /not found in PATH/, 'not executable');
});

test('tcpdump found in PATH: resolved, labelled and shown in the table with its .env setting', t => {
  const {lines, bin} = withRunnerFixture(t, {tools: ['tcpdump']});
  const commands = resolveCommands(path.join(path.dirname(bin)));
  assert.equal(commands.TCPDUMP, path.join(bin, 'tcpdump'));
  assert.ok(lines.some(line => line.includes('✓') && /tcpdump +/.test(line) && line.includes(`${path.join(bin, 'tcpdump')}  (TCPDUMP=tcpdump, .env)`)), lines.join('\n'));
});

test('tcpdump missing: a warning line, a null command, no failure and the other commands intact', t => {
  const {lines, root, bin} = withRunnerFixture(t);
  const commands = resolveCommands(root);
  assert.equal(commands.TCPDUMP, null);
  assert.equal(commands.VDE_SWITCH, path.join(bin, 'vde_switch'));
  const line = lines.find(item => /tcpdump +unavailable/.test(item));
  assert.ok(line, lines.join('\n'));
  assert.match(line, /^ {2}- /, 'the neutral "unavailable" mark, not a failure');
  assert.match(line, /the live view of captures is unavailable {2}\(TCPDUMP=tcpdump, \.env\)$/);
  assert.ok(!lines.some(item => item.includes('✗')), 'no failure line');
});

test('TCPDUMP set to an absolute path or by .env.local is honoured, and a bad one does not stop the runner', t => {
  const {root, bin} = withRunnerFixture(t, {tools: ['tcpdump']});
  fs.mkdirSync(path.join(root, 'other'));
  fakeProgram(path.join(root, 'other'), 'mydump');
  fs.writeFileSync(path.join(root, '.env.local'), `TCPDUMP=${path.join(root, 'other', 'mydump')}\n`);
  assert.equal(resolveCommands(root).TCPDUMP, path.join(root, 'other', 'mydump'));
  fs.writeFileSync(path.join(root, '.env.local'), `TCPDUMP=${path.join(root, 'nowhere')}\n`);
  assert.equal(resolveCommands(root).TCPDUMP, null, 'a bad path only disables the live view');
  assert.ok(fs.existsSync(path.join(bin, 'tcpdump')));
});

test('a missing required command still aborts the start-up, tcpdump or not', t => {
  const {root, bin} = withRunnerFixture(t, {tools: ['tcpdump']});
  fs.rmSync(path.join(bin, 'vdeterm'));
  assert.throws(() => resolveCommands(root), /Startup aborted: unavailable commands: VDETERM/);
});
