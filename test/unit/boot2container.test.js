'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {readCatalog, validateOverrides} = require('../../system-config');

const root = path.resolve(__dirname, '../..');

test('config.json declares valid container system profile with kernel boot', () => {
  const catalog = readCatalog(path.join(root, 'config.json'));
  assert.ok(catalog.systems.container, 'container profile must be defined');
  const qemuProfile = catalog.systems.container.qemu;
  assert.equal(qemuProfile.boot, 'kernel');
  assert.ok(qemuProfile.kernel.includes('linux-'));
  assert.ok(qemuProfile.initrd.includes('initramfs.'));
  if (process.arch === 'arm64' || process.arch === 'aarch64') {
    assert.equal(qemuProfile.arch, 'aarch64');
    assert.ok(qemuProfile.kernel.includes('linux-arm64-qemu'));
    assert.ok(qemuProfile.initrd.includes('initramfs.linux_arm64.cpio.xz'));
    assert.equal(qemuProfile.extraOptions[1], 'virt');
  } else {
    assert.equal(qemuProfile.arch, 'x86_64');
    assert.ok(qemuProfile.kernel.includes('linux-x86_64-qemu'));
    assert.ok(qemuProfile.initrd.includes('initramfs.linux_amd64.cpio.xz'));
    assert.equal(qemuProfile.extraOptions[1], 'q35');
  }
  assert.equal(qemuProfile.containerImage, 'docker.io/library/alpine:3.20');
});

test('system-config validates containerImage overrides and rejects invalid values', () => {
  const valid = validateOverrides({containerImage: 'docker.io/library/ubuntu:latest'});
  assert.equal(valid.containerImage, 'docker.io/library/ubuntu:latest');

  assert.throws(() => {
    validateOverrides({containerImage: 'invalid image with spaces'});
  }, /Container image must be a valid image reference/);

  assert.throws(() => {
    validateOverrides({containerImage: 'image"with"quotes'});
  }, /Container image must be a valid image reference/);
});

test('system-config rejects kernel boot on VirtualBox engine', () => {
  const invalidConfig = {
    schemaVersion: 4,
    systems: {
      default: {
        type: 'linux', arch: 'x86_64', mode: 'text', label: 'Default',
        memory: 512, cpus: 1, clock: 'utc', startupDiskEnabled: false,
        firmware: 'bios', boot: 'disk', 'acceleration:qemu': 'kvm',
        'acceleration:vbox': 'default', 'extraOptions:qemu': ['-machine', 'q35', '-cpu', 'host', '-nic', 'none'],
        cdromInterface: 'ide', 'diskInterface:qemu': 'virtio', 'diskInterface:vbox': 'sata',
        networkModel: 'virtio', image: null
      },
      badVbox: {
        basedOn: 'default',
        label: 'Bad VBox',
        'boot:vbox': 'kernel',
        'image:qemu': 'images/test.raw',
        'image:vbox': 'images/test.vdi'
      }
    }
  };
  const tempConfigFile = path.join(root, 'runtime', 'test-invalid-config.json');
  fs.mkdirSync(path.dirname(tempConfigFile), {recursive: true});
  fs.writeFileSync(tempConfigFile, JSON.stringify(invalidConfig));
  try {
    assert.throws(() => {
      readCatalog(tempConfigFile);
    }, /Direct kernel boot is only supported with QEMU/);
  } finally {
    try { fs.unlinkSync(tempConfigFile); } catch (_) {}
  }
});
