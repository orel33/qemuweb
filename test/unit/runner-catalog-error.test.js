// BUG06: an unreadable or invalid config.json is reported by the runner service (the startup check prints ✗ and aborts);
// a catalog that reads fine with no system is not an error. No runner process, no server: the real service with a temporary file.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createRunnerService} = require('../../runner');
const {root, commands} = require('./runner-pair');

const good = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));

function serviceFor(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-cat-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, content);
  return {file, service: createRunnerService({commands, root, runtimeRoot: path.join(dir, 'rt'), configPath: file})};
}

test('invalid JSON and a schema failure are returned as catalogError', t => {
  t.mock.method(console, 'error', () => {});
  for (const [content, pattern] of [['{not json', /Cannot read config.json/], [JSON.stringify({schemaVersion: 1, systems: {}}), /must contain schemaVersion/]]) {
    const {service} = serviceFor(t, content);
    assert.match(service.capabilities().catalogError, pattern);
  }
});

test('a missing file is an error; a catalog with only "default" is not', t => {
  t.mock.method(console, 'error', () => {});
  const {file, service} = serviceFor(t, JSON.stringify({schemaVersion: good.schemaVersion, systems: {default: good.systems.default}}));
  const empty = service.capabilities();
  assert.equal(empty.catalogError, null);
  assert.deepEqual(empty.images, {});
  fs.rmSync(file);
  assert.match(service.capabilities().catalogError, /Cannot read config.json/);
});

test('a running runner keeps the last good catalog, logs a repeated error once, and hello does not carry the error', t => {
  const logged = [];
  t.mock.method(console, 'error', message => logged.push(message));
  const {file, service} = serviceFor(t, JSON.stringify(good));
  const before = service.capabilities();
  assert.equal(before.catalogError, null);
  fs.writeFileSync(file, '{broken');
  service.capabilities();
  const after = service.capabilities();
  assert.ok(after.catalogError);
  assert.deepEqual(after.images, before.images);
  assert.equal(logged.length, 1);
  assert.equal('catalogError' in service.hello(), false);
});
