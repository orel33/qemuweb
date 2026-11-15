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
