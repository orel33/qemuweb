'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {readArchive} = require('../../runner/archive-zip');

const examplesDir = path.join(__dirname, '../../examples');
const archives = fs.readdirSync(examplesDir).filter(name => name.endsWith('.zip')).sort();

test('the examples directory holds session archives', () => {
  assert.ok(archives.length > 0);
});

for (const name of archives) {
  test(`examples/${name} is read by the session archive reader and holds a version 1 session and version 2 hosts`, async t => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-demo-test-'));
    t.after(() => fs.rmSync(stage, {recursive: true, force: true}));
    const names = await readArchive(path.join(examplesDir, name), stage);
    assert.ok(names.includes('session.json'));
    const session = JSON.parse(fs.readFileSync(path.join(stage, 'session.json'), 'utf8'));
    assert.equal(session.schemaVersion, 1);
    for (const id of [...session.hosts, ...session.switches]) {
      const kind = id.startsWith('h-') ? 'host' : 'switch';
      const node = JSON.parse(fs.readFileSync(path.join(stage, id, `${kind}.json`), 'utf8'));
      assert.equal(node.schemaVersion, kind === 'host' ? 2 : 1);
      if (kind === 'host') assert.ok(!('engine' in node));
      assert.equal(node.id, id);
    }
  });
}
