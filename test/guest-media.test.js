'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {validateBootFiles, createGuestIso, LABEL} = require('../guest-media');

test('guest startup media rejects traversal, duplicate names, oversized files and path collisions', () => {
  const basic = {script: '#!/bin/sh\n', resources: []};
  assert.deepEqual(validateBootFiles(basic), basic);
  for (const filename of ['../secret', '/etc/passwd', 'foo//bar', 'foo/./bar', 'start.sh', 'start.sh/child', '.qemuweb-media/child']) {
    assert.throws(() => validateBootFiles({...basic, resources: [{path: filename, contentBase64: 'YQ=='}]}));
  }
  assert.throws(() => validateBootFiles({...basic, script: 'x'.repeat(65537)}));
  assert.throws(() => validateBootFiles({...basic, resources: [{path: 'a', contentBase64: 'YQ=='}, {path: 'a/b', contentBase64: 'YQ=='}]}));
  assert.throws(() => validateBootFiles({...basic, resources: [{path: 'big', contentBase64: Buffer.alloc(1048577).toString('base64')}]}));
});

test('separate read-only ISOs retain each host script and companion relative path', {skip: !fs.existsSync('/usr/bin/genisoimage') || !fs.existsSync('/usr/bin/isoinfo')}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-media-test-'));
  try {
    const first = path.join(dir, 'first.iso');
    const second = path.join(dir, 'second.iso');
    const files = name => ({script: `#!/bin/sh\necho ${name}\ncat config/message.txt\n`, resources: [{path: 'config/message.txt', contentBase64: Buffer.from(name).toString('base64')}]});
    createGuestIso({files: files('marie'), destination: first, genisoimage: '/usr/bin/genisoimage'});
    createGuestIso({files: files('anne'), destination: second, genisoimage: '/usr/bin/genisoimage'});
    for (const [iso, name] of [[first, 'marie'], [second, 'anne']]) {
      assert.match(execFileSync('/usr/bin/isoinfo', ['-d', '-i', iso], {encoding: 'utf8'}), new RegExp(`Volume id: ${LABEL}`));
      assert.match(execFileSync('/usr/bin/isoinfo', ['-R', '-f', '-i', iso], {encoding: 'utf8'}), /\/config\/message\.txt/);
      assert.equal(execFileSync('/usr/bin/isoinfo', ['-R', '-i', iso, '-x', '/config/message.txt'], {encoding: 'utf8'}), name);
      assert.match(execFileSync('/usr/bin/isoinfo', ['-R', '-i', iso, '-x', '/start.sh'], {encoding: 'utf8'}), new RegExp(`echo ${name}`));
      assert.equal(fs.statSync(iso).mode & 0o222, 0);
    }
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
