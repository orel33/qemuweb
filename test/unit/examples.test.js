// The server's examples (server/examples.js): which files of the --examples directory are listed, the
// checks on a name, the refusal of links, directories and devices, the description of a topology and
// the kind of a file confirmed by its content. Real files in a temporary directory, nothing started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {kindOfName, isExampleName, topologyDescription, contentError, listExamples, openExample, LIMITS} = require('../../server/examples');
const {parseServerArguments, serverSpec} = require('../../server/options');

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('rest of the archive')]);
const TOPO = '### Small LAN\n\nSWITCH sw\nHOST debian13-legacy a sw\n';

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-examples-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

test('--examples is an option of the server: default examples/ of the repository, a path, not empty', () => {
  const root = path.join(path.sep, 'srv', 'qemuweb');
  assert.equal(parseServerArguments([], {root}).examplesDir, path.join(root, 'examples'));
  assert.equal(parseServerArguments(['--examples', '/srv/ex'], {root}).examplesDir, '/srv/ex');
  assert.ok(serverSpec(root).options.some(option => option.flag === '--examples'));
  assert.throws(() => parseServerArguments(['--examples'], {root}), /Missing value/);
  assert.throws(() => parseServerArguments(['--examples', ''], {root}), /Invalid value for --examples/);
});

test('the listing keeps regular .topo and .zip files, sorted by name, with kind, size and description only', async t => {
  const dir = directory(t);
  fs.writeFileSync(path.join(dir, 'b.zip'), ZIP);
  fs.writeFileSync(path.join(dir, 'a.topo'), TOPO);
  fs.writeFileSync(path.join(dir, 'C.TOPO'), '# upper case extension\nSWITCH s\n');
  fs.writeFileSync(path.join(dir, 'D.Zip'), ZIP);
  for (const other of ['notes.txt', 'archive.tar', 'zip', 'a.topo.bak', 'a.zip.txt']) fs.writeFileSync(path.join(dir, other), 'x');
  fs.writeFileSync(path.join(dir, '.hidden.topo'), TOPO);
  fs.writeFileSync(path.join(dir, '.hidden.zip'), ZIP);
  const list = await listExamples(dir);
  assert.deepEqual(list, [
    {name: 'C.TOPO', kind: 'topology', size: 'SWITCH s\n'.length + '# upper case extension\n'.length, description: 'upper case extension'},
    {name: 'D.Zip', kind: 'session', size: ZIP.length, description: ''},
    {name: 'a.topo', kind: 'topology', size: TOPO.length, description: 'Small LAN'},
    {name: 'b.zip', kind: 'session', size: ZIP.length, description: ''}
  ]);
  for (const entry of list) assert.deepEqual(Object.keys(entry).sort(), ['description', 'kind', 'name', 'size']);
});

test('a symbolic link, a directory, a device and a pipe are never listed or opened', async t => {
  const dir = directory(t);
  const outside = directory(t);
  fs.writeFileSync(path.join(outside, 'secret.zip'), ZIP);
  fs.symlinkSync(path.join(outside, 'secret.zip'), path.join(dir, 'link.zip'));
  fs.symlinkSync(outside, path.join(dir, 'linkdir.zip'));
  fs.symlinkSync(path.join(dir, 'missing'), path.join(dir, 'dangling.topo'));
  fs.mkdirSync(path.join(dir, 'folder.zip'));
  fs.mkdirSync(path.join(dir, 'folder.topo'));
  fs.writeFileSync(path.join(dir, 'real.zip'), ZIP);
  assert.deepEqual((await listExamples(dir)).map(entry => entry.name), ['real.zip']);
  for (const name of ['link.zip', 'linkdir.zip', 'dangling.topo', 'folder.zip', 'folder.topo']) {
    await assert.rejects(openExample(dir, name), {status: 404}, name);
  }
  // A link swapped in after the listing is still refused by the open itself (O_NOFOLLOW).
  const link = path.join(dir, 'swap.zip');
  fs.writeFileSync(link, ZIP);
  assert.ok((await listExamples(dir)).some(entry => entry.name === 'swap.zip'));
  fs.rmSync(link);
  fs.symlinkSync(path.join(outside, 'secret.zip'), link);
  await assert.rejects(openExample(dir, 'swap.zip'), {status: 404});
  // A device or a named pipe whose name looks like an example.
  try { require('node:child_process').execFileSync('mkfifo', [path.join(dir, 'pipe.zip')]); } catch (_) { /* No mkfifo: skipped. */ }
  fs.symlinkSync('/dev/null', path.join(dir, 'null.topo'));
  assert.deepEqual((await listExamples(dir)).map(entry => entry.name), ['real.zip']);
  for (const name of ['pipe.zip', 'null.topo']) await assert.rejects(openExample(dir, name), {status: 404}, name);
});

test('a missing, unreadable or non-directory examples path is an empty list, not an error', async t => {
  const dir = directory(t);
  assert.deepEqual(await listExamples(path.join(dir, 'absent')), []);
  fs.writeFileSync(path.join(dir, 'plain-file'), 'x');
  assert.deepEqual(await listExamples(path.join(dir, 'plain-file')), []);
  assert.deepEqual(await listExamples(null), []);
  assert.deepEqual(await listExamples(undefined), []);
});

test('the listing is read afresh at every call', async t => {
  const dir = directory(t);
  assert.deepEqual(await listExamples(dir), []);
  fs.writeFileSync(path.join(dir, 'new.zip'), ZIP);
  assert.deepEqual((await listExamples(dir)).map(entry => entry.name), ['new.zip']);
  fs.rmSync(path.join(dir, 'new.zip'));
  assert.deepEqual(await listExamples(dir), []);
});

test('a file over the limit of an upload of its kind is not listed', async t => {
  const dir = directory(t);
  fs.writeFileSync(path.join(dir, 'ok.topo'), 'SWITCH s\n');
  fs.writeFileSync(path.join(dir, 'huge.topo'), Buffer.alloc(LIMITS.topology + 1, 0x23));
  fs.writeFileSync(path.join(dir, 'limit.topo'), Buffer.alloc(LIMITS.topology, 0x23));
  assert.deepEqual((await listExamples(dir)).map(entry => entry.name), ['limit.topo', 'ok.topo']);
  assert.equal(LIMITS.session, 0xffffffff, 'the session limit is the one of the archive upload');
});

test('names: only bare names with an example extension, at most 128 characters', () => {
  const good = ['lan.zip', 'lan.topo', 'LAN.ZIP', 'a b.topo', 'é.zip', `${'a'.repeat(123)}.topo`, 'one.two.zip'];
  for (const name of good) assert.equal(isExampleName(name), true, name);
  const bad = ['', '.zip.zip', '.hidden.zip', '../lan.zip', 'a/b.zip', '/etc/passwd.zip', 'a\\b.zip', 'a..b.zip', '..zip', 'a\0.zip', 'a\n.zip', 'a\r.topo', 'a\u0007.zip', 'a\u0085.zip',
    'a .zip', `${'a'.repeat(124)}.topo`, 'lan', 'lan.txt', 'lan.zip ', 'lan.zip\0', null, undefined, 3, {}, ['lan.zip'], '.'];
  for (const name of bad) assert.equal(isExampleName(name), false, JSON.stringify(name));
  assert.equal(kindOfName('x.ZIP'), 'session');
  assert.equal(kindOfName('x.Topo'), 'topology');
  assert.equal(kindOfName('x.txt'), null);
  assert.equal(kindOfName(undefined), null);
});

test('the description is the first comment line of a topology: printable, at most 120 characters', () => {
  assert.equal(topologyDescription('### LAN\n\n#\n# drawing\nSWITCH s\n'), 'LAN');
  assert.equal(topologyDescription('\n#\n#   \n#  second\n'), 'second');
  assert.equal(topologyDescription('SWITCH s\n# after a directive\n'), 'after a directive');
  assert.equal(topologyDescription('SWITCH s\nHOST a b # trailing comment only\n'), '');
  assert.equal(topologyDescription('SWITCH s\n'), '');
  assert.equal(topologyDescription(''), '');
  assert.equal(topologyDescription('# a\u0000b\u001b[31m\u0007c\td\n'), 'ab[31mc d');
  assert.equal(topologyDescription(`# ${'x'.repeat(500)}\n`).length, 120);
  assert.equal(topologyDescription(`# ${'é'.repeat(500)}\n`).length, 120);
  assert.equal(topologyDescription('# first\r\n# second\r\n'), 'first');
});

test('a binary .topo has no description and a topology listed with a NUL byte is not described', async t => {
  const dir = directory(t);
  fs.writeFileSync(path.join(dir, 'bin.topo'), Buffer.from('# looks fine\0\0SWITCH s\n'));
  const [entry] = await listExamples(dir);
  assert.equal(entry.description, '');
});

test('the kind announced by the extension is confirmed by the content', () => {
  assert.equal(contentError('session', ZIP), null);
  assert.match(contentError('session', Buffer.from('SWITCH sw\n')), /not a ZIP archive/);
  assert.match(contentError('session', Buffer.from('PK')), /not a ZIP archive/);
  assert.match(contentError('session', Buffer.alloc(0)), /not a ZIP archive/);
  assert.equal(contentError('topology', Buffer.from(TOPO)), null);
  assert.equal(contentError('topology', Buffer.from('# é accents ✓\nSWITCH s\n')), null);
  assert.match(contentError('topology', ZIP), /not a topology/);
  assert.match(contentError('topology', Buffer.from('SWITCH s\0')), /binary/);
  assert.match(contentError('topology', Buffer.from([0xff, 0xfe, 0x41])), /UTF-8/);
});

test('opening an example: a malformed name is a 400, an unlisted name a 404, a wrong content a 400', async t => {
  const dir = directory(t);
  fs.writeFileSync(path.join(dir, 'lan.zip'), ZIP);
  fs.writeFileSync(path.join(dir, 'lan.topo'), TOPO);
  fs.writeFileSync(path.join(dir, 'fake.zip'), 'SWITCH s\n');
  fs.writeFileSync(path.join(dir, 'fake.topo'), ZIP);
  for (const name of ['../x.zip', '/etc/passwd', 'a/lan.zip', '.hidden.zip', 'lan.txt', '', undefined, 42, 'lan.zip\0', `${'a'.repeat(200)}.zip`]) {
    await assert.rejects(openExample(dir, name), {status: 400}, JSON.stringify(name));
  }
  for (const name of ['other.zip', 'other.topo', 'LAN.ZIP']) await assert.rejects(openExample(dir, name), {status: 404, message: 'No such example.'}, name);
  await assert.rejects(openExample(dir, 'fake.zip'), {status: 400, message: /fake\.zip: This file is not a ZIP archive/});
  await assert.rejects(openExample(dir, 'fake.topo'), {status: 400, message: /fake\.topo: This file is not a topology/});
  const zip = await openExample(dir, 'lan.zip');
  assert.deepEqual([zip.name, zip.kind, zip.size, zip.text], ['lan.zip', 'session', ZIP.length, null]);
  await zip.handle.close();
  const topo = await openExample(dir, 'lan.topo');
  assert.deepEqual([topo.kind, topo.text], ['topology', TOPO]);
  await topo.handle.close();
});

test('the real examples of the repository are listed with their kinds and descriptions', async () => {
  const list = await listExamples(path.join(__dirname, '..', '..', 'examples'));
  assert.deepEqual(list.map(entry => entry.name), ['dmz.topo', 'dmz0.zip', 'dmz1.zip', 'gw.topo', 'gw0.zip', 'gw1.zip', 'lan.topo', 'lan.zip']);
  assert.deepEqual(list.filter(entry => entry.kind === 'topology').map(entry => entry.description), ['DMZ', 'GW', 'LAN']);
});

test('server/examples.js never writes: no write, delete or rename call', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'examples.js'), 'utf8');
  assert.doesNotMatch(source, /writeFile|appendFile|unlink|rmSync|\brm\(|rename|mkdir|truncate|chmod|copyFile|symlink\(/);
  const routes = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'routes', 'examples.js'), 'utf8');
  assert.doesNotMatch(routes, /writeFile|appendFile|unlink|rmSync|rename|mkdir|truncate|copyFile/);
});
