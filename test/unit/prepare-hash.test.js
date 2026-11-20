'use strict';

// scripts/prepare.sh --hash: exit status and messages. The script is copied into a temporary
// project root with a minimal config.json and a fake images/ directory; --hash exits before any
// download or build, and nothing outside the temporary root is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'prepare.sh');

function makeRoot(images) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-prepare-hash-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'images'));
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'prepare.sh'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({systems: {default: {}, x: {}, y: {}}}));
  for (const [name, content] of Object.entries(images)) fs.writeFileSync(path.join(root, 'images', name), content);
  return root;
}

function hash(root, args) {
  const result = spawnSync('bash', [path.join(root, 'scripts', 'prepare.sh'), '--hash', ...args], {encoding: 'utf8'});
  return {status: result.status, out: result.stdout, err: result.stderr};
}

function lines(text) { return text.split('\n').filter(Boolean); }

function withRoot(images, body) {
  const root = makeRoot(images);
  try { body(root); } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

test('--system with no image at all fails with status 2 and a message', () => {
  withRoot({'x.raw': ''}, root => { // an empty file is no image
    const result = hash(root, ['--system', 'x']);
    assert.equal(result.status, 2);
    assert.deepEqual(lines(result.out), ['  x.raw: no image', '  x.vdi: no image']);
    assert.match(result.err, /prepare\.sh: Nothing to hash for x: no image built \(run: bash scripts\/prepare\.sh --system x\)\./);
    assert.deepEqual(fs.readdirSync(path.join(root, 'images')), ['x.raw']);
  });
});

test('--system with one format records it, warns about the other and exits 0', () => {
  withRoot({'x.raw': 'raw data'}, root => {
    const result = hash(root, ['--system', 'x']);
    assert.equal(result.status, 0);
    assert.deepEqual(lines(result.out), ['  x.raw: hash recorded', '  x.vdi: no image']);
    assert.match(result.err, /prepare\.sh: x\.vdi is missing/);
    assert.match(fs.readFileSync(path.join(root, 'images', 'x.raw.sha256'), 'utf8'), /^[0-9a-f]{64} {2}x\.raw\n$/);
    assert.equal(fs.existsSync(path.join(root, 'images', 'x.vdi.sha256')), false);
  });
});

test('--system with both formats records them, then reports them up to date', () => {
  withRoot({'x.raw': 'raw data', 'x.vdi': 'vdi data'}, root => {
    const first = hash(root, ['--system', 'x']);
    assert.equal(first.status, 0);
    assert.deepEqual(lines(first.out), ['  x.raw: hash recorded', '  x.vdi: hash recorded']);
    assert.equal(first.err, '');
    const second = hash(root, ['--system', 'x']);
    assert.equal(second.status, 0);
    assert.deepEqual(lines(second.out), ['  x.raw: hash up to date', '  x.vdi: hash up to date']);
    assert.deepEqual(fs.readdirSync(path.join(root, 'images')).sort(), ['x.raw', 'x.raw.sha256', 'x.vdi', 'x.vdi.sha256']);
  });
});

test('an unknown system is refused', () => {
  withRoot({}, root => {
    const result = hash(root, ['--system', 'nope']);
    assert.equal(result.status, 2);
    assert.match(result.err, /Unknown system: nope/);
  });
});

test('without --system, unbuilt systems are skipped and the status is 0 when one system has an image', () => {
  withRoot({'x.raw': 'raw data', 'x.vdi': 'vdi data'}, root => {
    const result = hash(root, []);
    assert.equal(result.status, 0);
    assert.deepEqual(lines(result.out), ['  x.raw: hash recorded', '  x.vdi: hash recorded', '  y: not built, skipped']);
  });
});

test('without --system and without any image, the status is 2', () => {
  withRoot({}, root => {
    const result = hash(root, []);
    assert.equal(result.status, 2);
    assert.deepEqual(lines(result.out), ['  x: not built, skipped', '  y: not built, skipped']);
    assert.match(result.err, /prepare\.sh: Nothing to hash: no image built/);
    assert.deepEqual(fs.readdirSync(path.join(root, 'images')), []);
  });
});
