'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {validateBootFiles, readStartupFiles, writeStartupFiles, writeStartupScript, createGuestIso, LABEL} = require('../guest-media');

test('guest startup media rejects traversal, duplicate names, oversized files and path collisions', () => {
  const basic = {script: '#!/bin/sh\n', resources: []};
  assert.deepEqual(validateBootFiles(basic), basic);
  for (const filename of ['../secret', '/etc/passwd', 'foo//bar', 'foo/./bar', 'start.sh', 'start.sh/child']) {
    assert.throws(() => validateBootFiles({...basic, resources: [{path: filename, contentBase64: 'YQ=='}]}));
  }
  assert.throws(() => validateBootFiles({...basic, script: 'x'.repeat(65537)}));
  assert.throws(() => validateBootFiles({...basic, resources: [{path: 'a', contentBase64: 'YQ=='}, {path: 'a/b', contentBase64: 'YQ=='}]}));
  assert.throws(() => validateBootFiles({...basic, resources: [{path: 'big', contentBase64: Buffer.alloc(1048577).toString('base64')}]}));
});

test('filesystem startup source keeps companion files on script save and rejects unsafe entries', () => {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-startup-test-'));
  const startup = path.join(host, 'startup');
  try {
    writeStartupFiles(startup, {script: '#!/bin/sh\n', resources: [{path: 'config/message.txt', contentBase64: 'b2xk'}]});
    writeStartupScript(startup, '#!/bin/sh\necho updated\n');
    assert.equal(fs.readFileSync(path.join(startup, 'config/message.txt'), 'utf8'), 'old');
    fs.writeFileSync(path.join(startup, 'config', 'added.txt'), 'external');
    assert.deepEqual(readStartupFiles(startup).resources.map(entry => entry.path), ['config/added.txt', 'config/message.txt']);
    writeStartupScript(startup, '');
    assert.equal(fs.existsSync(path.join(startup, 'start.sh')), false);
    fs.symlinkSync('message.txt', path.join(startup, 'config', 'linked.txt'));
    assert.throws(() => readStartupFiles(startup), /Symlinks/);
    fs.unlinkSync(path.join(startup, 'config', 'linked.txt'));
    fs.writeFileSync(path.join(startup, 'config', 'big'), Buffer.alloc(1048577));
    assert.throws(() => readStartupFiles(startup), /exceeds 1 MiB/);
  } finally { fs.rmSync(host, {recursive: true, force: true}); }
});

test('separate read-only ISOs include external companion files under each host', {skip: !fs.existsSync('/usr/bin/genisoimage') || !fs.existsSync('/usr/bin/isoinfo')}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-media-test-'));
  try {
    for (const name of ['marie', 'anne']) {
      const host = path.join(root, name);
      fs.mkdirSync(host);
      const startup = path.join(host, 'startup');
      writeStartupFiles(startup, {script: `#!/bin/sh\necho ${name}\ncat config/message.txt\n`, resources: []});
      fs.mkdirSync(path.join(startup, 'config'));
      fs.writeFileSync(path.join(startup, 'config', 'message.txt'), name);
      const iso = path.join(host, 'startup-1.iso');
      createGuestIso({directory: startup, destination: iso, genisoimage: '/usr/bin/genisoimage'});
      assert.match(execFileSync('/usr/bin/isoinfo', ['-d', '-i', iso], {encoding: 'utf8'}), new RegExp(`Volume id: ${LABEL}`));
      assert.match(execFileSync('/usr/bin/isoinfo', ['-R', '-f', '-i', iso], {encoding: 'utf8'}), /\/config\/message\.txt/);
      assert.equal(execFileSync('/usr/bin/isoinfo', ['-R', '-i', iso, '-x', '/config/message.txt'], {encoding: 'utf8'}), name);
      assert.match(execFileSync('/usr/bin/isoinfo', ['-R', '-i', iso, '-x', '/start.sh'], {encoding: 'utf8'}), new RegExp(`echo ${name}`));
      assert.equal(fs.statSync(iso).mode & 0o222, 0);
    }
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
