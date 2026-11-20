'use strict';

// config.json warnings announced by a runner at startup (runner/config-warnings.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {readCatalog} = require('../../common/system-config');
const {configWarnings, memoryWarning} = require('../../runner/config-warnings');

const catalog = readCatalog(path.join(__dirname, '..', '..', 'config.json'));
const systems = Object.keys(catalog.systems).filter(id => id !== 'default');
const roomy = {engines: ['qemu'], cpus: 64, memoryBytes: 1024 * 2 ** 30};

test('a missing base image is a warning that names the system and the prepare command', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-warnings-'));
  try {
    const warnings = configWarnings({catalog, root: empty, ...roomy});
    assert.equal(warnings.length, systems.length);
    for (const id of systems) assert.ok(warnings.some(text => text.startsWith(`${id}: `) && text.includes(`prepare.sh --system ${id}`)), id);
  } finally { fs.rmSync(empty, {recursive: true, force: true}); }
});

test('no warning when every image exists and the machine is large enough', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-warnings-'));
  try {
    for (const id of systems) {
      const file = path.join(root, catalog.systems[id].qemu.image);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, '');
    }
    assert.deepEqual(configWarnings({catalog, root, ...roomy}), []);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('default memory or processors above the machine are warnings, and the list is bounded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-warnings-'));
  try {
    for (const id of systems) {
      const file = path.join(root, catalog.systems[id].qemu.image);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, '');
    }
    const warnings = configWarnings({catalog, root, engines: ['qemu'], cpus: 0, memoryBytes: 64 * 2 ** 20});
    assert.ok(warnings.some(text => /default memory of \d+ MB exceeds the 64 MB/.test(text)));
    assert.ok(warnings.some(text => /processors exceeds the 0 of this machine/.test(text)));
    const many = {systems: {default: catalog.systems.default, ...Object.fromEntries(Array.from({length: 30}, (_, index) => [`s${index}`, catalog.systems[systems[0]]]))}};
    assert.ok(configWarnings({catalog: many, root: path.join(root, 'none'), ...roomy}).length <= 20);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('QEMU without a usable /dev/kvm, and a runner without any engine, are warnings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-warnings-'));
  try {
    for (const id of systems) {
      const file = path.join(root, catalog.systems[id].qemu.image);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, '');
    }
    assert.ok(configWarnings({catalog, root, ...roomy, kvm: false}).some(text => /\/dev\/kvm is missing or not accessible/.test(text)));
    assert.deepEqual(configWarnings({catalog, root, ...roomy, kvm: true}), []);
    assert.deepEqual(configWarnings({catalog, root, ...roomy, engines: ['vbox'], kvm: false}).filter(text => /kvm/.test(text)), [],
      'a VirtualBox-only runner does not need KVM');
    assert.ok(configWarnings({catalog, root, ...roomy, engines: []}).some(text => /no virtualization engine/.test(text)));
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('the start-time memory warning appears above 90 % of the RAM and never before', () => {
  const total = 8192 * 1024 * 1024;
  assert.equal(memoryWarning({runningMb: 4096, hostMb: 3000, totalBytes: total}), null, '7096 of 8192 MB');
  assert.equal(memoryWarning({runningMb: 0, hostMb: 7372, totalBytes: total}), null, 'exactly 90 %');
  const text = memoryWarning({runningMb: 6000, hostMb: 1500, totalBytes: total});
  assert.match(text, /^this host asks for 1500 MB and the memory of this machine is almost all reserved by running hosts/);
  assert.doesNotMatch(text, /6000|7500/, 'no figure about the other hosts of the runner');
  assert.match(memoryWarning({runningMb: 0, hostMb: 9000, totalBytes: total}), /asks for 9000 MB/);
  for (const bad of [{runningMb: NaN, hostMb: 1, totalBytes: total}, {runningMb: 1, hostMb: undefined, totalBytes: total}, {runningMb: 1, hostMb: 1, totalBytes: 0}]) {
    assert.equal(memoryWarning(bad), null);
  }
});
