'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {readCatalog} = require('../../system-config');
const {resolveCommands} = require('../../command-preflight');

const root = path.resolve(__dirname, '../..');

test('config.json declares valid ARM64 profiles with EFI firmware', () => {
  const catalog = readCatalog(path.join(root, 'config.json'));

  assert.ok(catalog.systems['debian13-cloud-arm64'], 'debian13-cloud-arm64 profile must be defined');
  const debianArm = catalog.systems['debian13-cloud-arm64'].qemu;
  assert.equal(debianArm.arch, 'aarch64');
  assert.equal(debianArm.firmware, 'efi');
  assert.equal(debianArm.extraOptions[1], 'virt');
  assert.equal(debianArm.image, 'images/debian13-cloud-arm64.raw');

  assert.ok(catalog.systems['alpine-arm64'], 'alpine-arm64 profile must be defined');
  const alpineArm = catalog.systems['alpine-arm64'].qemu;
  assert.equal(alpineArm.arch, 'aarch64');
  assert.equal(alpineArm.firmware, 'efi');
  assert.equal(alpineArm.extraOptions[1], 'virt');
  assert.equal(alpineArm.image, 'images/alpine-arm64.raw');
});

test('command-preflight detects optional ARM64 EFI firmware and binaries', () => {
  const cmds = resolveCommands(root);
  assert.ok(cmds.QEMU_SYSTEM_X86_64, 'QEMU x86_64 must be present');
  if (cmds.QEMU_EFI_AARCH64) {
    assert.ok(cmds.QEMU_EFI_AARCH64.includes('edk2') || cmds.QEMU_EFI_AARCH64.includes('EFI') || cmds.QEMU_EFI_AARCH64.includes('AAVMF'), 'EFI firmware path must be recognized');
  }
});

test('ARM64 system profiles declare aarch64 architecture for acceleration resolution', () => {
  const catalog = readCatalog(path.join(root, 'config.json'));
  for (const id of ['debian13-cloud-arm64', 'alpine-arm64']) {
    const profile = catalog.systems[id].qemu;
    assert.equal(profile.arch, 'aarch64');
  }
});

