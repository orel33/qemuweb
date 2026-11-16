'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {fileSha256} = require('../../runner/media/image-hash');
const {shellQuote} = require('../../common/shell-quote');

test('fileSha256 matches the real digest and follows file changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-hash-'));
  try {
    const file = path.join(dir, 'image.raw');
    fs.writeFileSync(file, 'abc');
    const first = fileSha256(file);
    assert.deepEqual(first, {size: 3, sha256: crypto.createHash('sha256').update('abc').digest('hex')});
    assert.deepEqual(fileSha256(file), first);
    fs.writeFileSync(file, 'abcd');
    assert.equal(fileSha256(file).size, 4);
    assert.throws(() => fileSha256(dir), /not a regular file/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('shellQuote leaves safe words alone and quotes the rest', () => {
  assert.equal(shellQuote('qemu-system_x86/64'), 'qemu-system_x86/64');
  assert.equal(shellQuote('a b'), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

// --- hash files written by prepare.sh (sha256sum format, not older than the image) ------------
const {fileSha256Async, hashFilePath} = require('../../runner/media/image-hash');
const {spawnSync} = require('node:child_process');
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const FAKE = 'f'.repeat(64);
const seconds = offset => new Date(Date.now() + offset * 1000);

function withImage(t, content = 'image bytes') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-hash-file-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'image.raw');
  fs.writeFileSync(file, content);
  fs.utimesSync(file, seconds(-60), seconds(-60));
  return file;
}
// Writes <image>.sha256 with the given text and modification time (default: after the image).
function writeHashFile(file, text = `${FAKE}  ${path.basename(file)}\n`, when = seconds(0)) {
  fs.writeFileSync(hashFilePath(file), text);
  fs.utimesSync(hashFilePath(file), when, when);
}

test('a hash file that is not older than the image is used without reading the image', async t => {
  const file = withImage(t);
  writeHashFile(file);
  // The recorded value is a fake digest: getting it back proves the image was not hashed.
  assert.deepEqual(fileSha256(file), {size: fs.statSync(file).size, sha256: FAKE});
  const other = withImage(t);
  writeHashFile(other);
  assert.equal((await fileSha256Async(other)).sha256, FAKE);
});

test('a hash file with exactly the modification time of the image is accepted', t => {
  const file = withImage(t);
  const when = fs.statSync(file).mtime;
  writeHashFile(file, undefined, when);
  assert.equal(fileSha256(file).sha256, FAKE);
});

test('a hash file older than the image, or malformed, is ignored and the image is hashed', async t => {
  const content = 'image bytes';
  const expected = digest(content);

  const older = withImage(t, content);
  writeHashFile(older, undefined, seconds(-120));
  assert.equal(fileSha256(older).sha256, expected);

  const rebuilt = withImage(t, content);
  writeHashFile(rebuilt);
  const later = seconds(60);
  fs.utimesSync(rebuilt, later, later);
  assert.equal((await fileSha256Async(rebuilt)).sha256, expected);

  for (const text of ['', 'not a digest\n', `${'f'.repeat(63)}\n`, `${'F'.repeat(64)}  image.raw\n`, `${FAKE}x  image.raw\n`]) {
    const bad = withImage(t, content);
    writeHashFile(bad, text);
    assert.equal(fileSha256(bad).sha256, expected, `ignored: ${JSON.stringify(text)}`);
  }

  const missing = withImage(t, content);
  assert.equal(fileSha256(missing).sha256, expected);
});

test('fileSha256Async matches fileSha256 for an image without a hash file', async t => {
  const file = withImage(t, 'x'.repeat(3 * 1024 * 1024 + 17));
  const sync = fileSha256(file);
  const other = withImage(t, 'x'.repeat(3 * 1024 * 1024 + 17));
  assert.deepEqual(await fileSha256Async(other), sync);
});

test('sha256sum writes the line format that hash files rely on', t => {
  const probe = spawnSync('sha256sum', ['--version'], {encoding: 'utf8'});
  if (probe.error) { t.skip('sha256sum is not available'); return; }
  const file = withImage(t);
  const result = spawnSync('sha256sum', [path.basename(file)], {cwd: path.dirname(file), encoding: 'utf8'});
  assert.equal(result.status, 0);
  writeHashFile(file, result.stdout);
  assert.equal(fileSha256(file).sha256, digest('image bytes'));
  assert.match(result.stdout, new RegExp(`^${digest('image bytes')}  image\\.raw\n$`));
});
