// What a runner keeps in its own runtime directory (runner/runtime-tidy.js, docs/runner-model.md R8 and R9): the
// users/<login> aliases, the start-up pruning and the runner.pid lock. Temporary directories only; the pid check is
// injected, no runner and no server is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {spawnSync} = require('node:child_process');
const {createRunnerService} = require('../../runner');
const {userAliasName, linkUserAlias, unlinkUserAlias, pruneUserAliases, pruneRuntime, takeRunnerLock} = require('../../runner/runtime-tidy');
const {root, commands} = require('./runner-pair');

const ID = n => n.toString(16).padStart(8, '0');
const DEFINITION = JSON.stringify({schemaVersion: 1, engine: 'qemu', hosts: [], switches: []});

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-tidy-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function makeSession(runtime, id, files) {
  const dir = path.join(runtime, 'sessions', id);
  fs.mkdirSync(dir, {recursive: true});
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  return dir;
}

test('user aliases encode the login like hostname aliases', () => {
  assert.equal(userAliasName('jean@example.org'), 'jean%40example.org');
  assert.equal(userAliasName('a.b'), 'a.b');
  assert.equal(userAliasName('..'), '%2E%2E');
});

test('an alias is a relative link to the session, replaced for the same login, removed only if it still points to the session', t => {
  const runtime = scratch(t);
  makeSession(runtime, ID(1), {});
  makeSession(runtime, ID(2), {});
  assert.equal(linkUserAlias(runtime, 'toto', ID(1)), true);
  const alias = path.join(runtime, 'users', 'toto');
  assert.equal(fs.readlinkSync(alias), path.join('..', 'sessions', ID(1)));
  assert.equal(fs.realpathSync(alias), fs.realpathSync(path.join(runtime, 'sessions', ID(1))));
  linkUserAlias(runtime, 'toto', ID(2));
  assert.equal(fs.readlinkSync(alias), path.join('..', 'sessions', ID(2)), 'replaced atomically');
  assert.deepEqual(fs.readdirSync(path.join(runtime, 'users')), ['toto'], 'no temporary file is left');
  unlinkUserAlias(runtime, 'toto', ID(1));
  assert.equal(fs.existsSync(alias), true, 'the alias of another session is not removed');
  unlinkUserAlias(runtime, 'toto', ID(2));
  assert.equal(fs.existsSync(path.join(runtime, 'users')), false, 'the alias and the empty users/ directory are gone');
  assert.equal(fs.existsSync(path.join(runtime, 'sessions', ID(2))), true, 'the session itself is not touched');
});

test('dangling aliases are pruned, live ones and other entries kept', t => {
  const runtime = scratch(t);
  makeSession(runtime, ID(1), {'keep.txt': 'x'});
  linkUserAlias(runtime, 'alive', ID(1));
  linkUserAlias(runtime, 'gone', ID(9));
  fs.writeFileSync(path.join(runtime, 'users', 'regular-file'), 'x');
  assert.equal(pruneUserAliases(runtime), 1);
  assert.deepEqual(fs.readdirSync(path.join(runtime, 'users')).sort(), ['alive', 'regular-file']);
  fs.rmSync(path.join(runtime, 'users'), {recursive: true});
  linkUserAlias(runtime, 'gone', ID(9));
  assert.equal(pruneUserAliases(runtime), 1);
  assert.equal(fs.existsSync(path.join(runtime, 'users')), false, 'users/ goes with its last alias');
  assert.equal(pruneUserAliases(path.join(runtime, 'absent')), 0, 'no users/ directory: nothing to do');
});

test('start-up pruning removes the empty session directories and keeps every other one', t => {
  const runtime = scratch(t);
  const empty = makeSession(runtime, ID(1), {'session.json': DEFINITION, 'meta.json': '{}'});
  const noMeta = makeSession(runtime, ID(2), {'session.json': DEFINITION});
  const vacant = makeSession(runtime, ID(3), {});
  const emptySubdirs = makeSession(runtime, ID(4), {'session.json': DEFINITION, 'meta.json': '{}'});
  fs.mkdirSync(path.join(emptySubdirs, 'hosts'));
  fs.mkdirSync(path.join(emptySubdirs, 'switches'));
  const withNodes = makeSession(runtime, ID(5), {'session.json': JSON.stringify({schemaVersion: 1, engine: 'qemu', hosts: ['h-89abcdef'], switches: []}), 'meta.json': '{}'});
  const unexpected = makeSession(runtime, ID(6), {'session.json': DEFINITION, 'meta.json': '{}', 'keep.txt': 'x'});
  const badDefinition = makeSession(runtime, ID(7), {'session.json': 'not json'});
  const otherSchema = makeSession(runtime, ID(8), {'session.json': JSON.stringify({schemaVersion: 99, engine: 'qemu', hosts: [], switches: []})});
  fs.mkdirSync(path.join(runtime, 'sessions', 'not-a-session'));
  makeSession(runtime, ID(10), {'session.json': DEFINITION, 'meta.json': '{}'});
  linkUserAlias(runtime, 'dangling', ID(1));
  linkUserAlias(runtime, 'kept', ID(5));
  const lines = [];
  const result = pruneRuntime(runtime, {log: line => lines.push(line)});
  for (const dir of [empty, noMeta, vacant, emptySubdirs, path.join(runtime, 'sessions', ID(10))]) assert.equal(fs.existsSync(dir), false, dir);
  for (const dir of [withNodes, unexpected, badDefinition, otherSchema]) assert.equal(fs.existsSync(dir), true, dir);
  assert.ok(fs.existsSync(path.join(runtime, 'sessions', 'not-a-session')), 'a name that is not a session ID is not ours');
  assert.equal(result.removed, 5);
  assert.deepEqual(result.kept.sort(), [ID(5), ID(6), ID(7), ID(8)]);
  assert.equal(result.aliases, 1);
  assert.deepEqual(fs.readdirSync(path.join(runtime, 'users')), ['kept'], 'the alias of a removed session is pruned, the other kept');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Removed 5 empty runtime sessions/);
  assert.match(lines[1], /Kept 4 non-empty session directories/);
});

test('start-up pruning on a directory with no sessions/ does nothing', t => {
  const runtime = scratch(t);
  const lines = [];
  assert.deepEqual(pruneRuntime(runtime, {log: line => lines.push(line)}), {removed: 0, kept: [], aliases: 0});
  assert.deepEqual(lines, []);
});

test('the runner service creates the alias at session.create and removes it with the session', async t => {
  const runtime = scratch(t);
  const service = createRunnerService({commands, root, runtimeRoot: runtime, configPath: path.join(root, 'config.json')});
  await service.handle('session.create', ID(1), {owner: 'toto'});
  await service.handle('session.create', ID(2), {owner: 'jean@example.org'});
  await service.handle('session.create', ID(3), {});
  assert.equal(fs.readlinkSync(path.join(runtime, 'users', 'toto')), path.join('..', 'sessions', ID(1)));
  assert.equal(fs.readlinkSync(path.join(runtime, 'users', 'jean%40example.org')), path.join('..', 'sessions', ID(2)));
  assert.deepEqual(fs.readdirSync(path.join(runtime, 'users')).sort(), ['jean%40example.org', 'toto'], 'a session without owner has no alias');
  await service.handle('session.delete', ID(1));
  assert.equal(fs.existsSync(path.join(runtime, 'sessions', ID(1))), false);
  assert.equal(fs.existsSync(path.join(runtime, 'users', 'toto')), false);
  assert.equal(fs.existsSync(path.join(runtime, 'users', 'jean%40example.org')), true, 'another user\'s alias stays');
  await service.shutdown();
  assert.equal(fs.existsSync(path.join(runtime, 'users')), false, 'at shutdown the empty sessions and their aliases go');
  assert.equal(fs.existsSync(path.join(runtime, 'sessions', ID(2))), false);
});

test('session.create refuses an owner that is not a login', async t => {
  const runtime = scratch(t);
  const service = createRunnerService({commands, root, runtimeRoot: runtime, configPath: path.join(root, 'config.json')});
  for (const owner of ['../evil', 'a/b', '', 'x'.repeat(65), 5, {}, ['a']]) {
    await assert.rejects(service.handle('session.create', ID(1), {owner}), /Invalid session owner/, JSON.stringify(owner));
  }
  assert.equal(fs.existsSync(path.join(runtime, 'users')), false);
  assert.equal(fs.existsSync(path.join(runtime, 'sessions')), false, 'nothing was created');
});

test('a non-empty session left by an earlier runner survives the start-up pruning, with its alias', async t => {
  const runtime = scratch(t);
  makeSession(runtime, ID(1), {'session.json': JSON.stringify({schemaVersion: 1, engine: 'qemu', hosts: ['h-89abcdef'], switches: []}), 'meta.json': '{}'});
  linkUserAlias(runtime, 'toto', ID(1));
  pruneRuntime(runtime, {log() {}});
  assert.equal(fs.existsSync(path.join(runtime, 'sessions', ID(1))), true);
  assert.equal(fs.existsSync(path.join(runtime, 'users', 'toto')), true, 'the alias still resolves: not dangling');
});

test('runner.pid: taken, refused while a live runner holds it, released only by its owner', t => {
  const runtime = scratch(t);
  const first = takeRunnerLock(runtime, {pid: 4242, alive: () => true, isRunner: () => true});
  assert.equal(fs.readFileSync(path.join(runtime, 'runner.pid'), 'utf8'), '4242\n');
  assert.equal(fs.statSync(path.join(runtime, 'runner.pid')).mode & 0o777, 0o600);
  assert.throws(() => takeRunnerLock(runtime, {pid: 4343, alive: pid => pid === 4242, isRunner: () => true}),
    error => /Another runner \(PID 4242\) already uses the runtime directory/.test(error.message) && error.message.includes(runtime));
  assert.equal(fs.readFileSync(path.join(runtime, 'runner.pid'), 'utf8'), '4242\n', 'the holder keeps its file');
  first.release();
  assert.equal(fs.existsSync(path.join(runtime, 'runner.pid')), false);
  const second = takeRunnerLock(runtime, {pid: 4343, alive: () => false, isRunner: () => true});
  fs.writeFileSync(path.join(runtime, 'runner.pid'), '5555\n');
  second.release();
  assert.equal(fs.readFileSync(path.join(runtime, 'runner.pid'), 'utf8'), '5555\n', 'a file of another process is left alone');
});

test('runner.pid: a stale file (dead process, pid reused by another program, garbage) is replaced', t => {
  const runtime = scratch(t);
  const file = path.join(runtime, 'runner.pid');
  fs.writeFileSync(file, '4242\n');
  takeRunnerLock(runtime, {pid: 1, alive: () => false, isRunner: () => true});
  assert.equal(fs.readFileSync(file, 'utf8'), '1\n', 'dead process');
  fs.writeFileSync(file, '4242\n');
  takeRunnerLock(runtime, {pid: 2, alive: () => true, isRunner: () => false});
  assert.equal(fs.readFileSync(file, 'utf8'), '2\n', 'a live process that is not a runner');
  for (const garbage of ['', 'abc\n', '-5\n', '0\n']) {
    fs.writeFileSync(file, garbage);
    takeRunnerLock(runtime, {pid: 3, alive: () => true, isRunner: () => true});
    assert.equal(fs.readFileSync(file, 'utf8'), '3\n', JSON.stringify(garbage));
  }
});

test('runner.pid with the real checks: this process counts as alive but is not a runner; a dead process is stale', t => {
  const runtime = scratch(t);
  const file = path.join(runtime, 'runner.pid');
  fs.writeFileSync(file, `${process.pid}\n`);
  // The test process is no runner/main.js (on Linux, where /proc tells): the file is stale.
  if (fs.existsSync(`/proc/${process.pid}/cmdline`)) takeRunnerLock(runtime, {pid: 1234567});
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  fs.writeFileSync(file, `${dead}\n`);
  const lock = takeRunnerLock(runtime, {pid: process.pid});
  assert.equal(fs.readFileSync(file, 'utf8').trim(), String(process.pid));
  lock.release();
});
