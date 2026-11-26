// The default runtime directories (common/runtime-dir.js): /tmp/qw-<login>/<port> (server), l-<port> (local runner), r-<id6> (remote runner), private and short. Every
// test works in a temporary directory with an injected tmp root and identity, never in the real /tmp/qw-<login>.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {execFileSync, spawnSync} = require('node:child_process');
const {accountLabel, accountRoot, serverRuntime, localRunnerRuntime, remoteRunnerRuntime, isDefaultRuntime, prepareServerRuntime, prepareRunnerRuntime, runtimeBudget, runtimeTooLong, socketPathsBelowRuntime, storageWarning,
  SOCKET_LIMIT, MAX_LOGIN} = require('../../common/runtime-dir');
const {createSessionRuntime} = require('../../runner/session-runtime');

const uid = process.getuid();
const alice = {username: 'alice', uid};

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-rd-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}

const mode = file => fs.lstatSync(file).mode & 0o777;

test('the defaults are <tmp>/qw-<login>/<port> (server), l-<port> (local runner), r-<id6> (remote runner), per account', t => {
  const tmpRoot = scratch(t);
  const options = {tmpRoot, identity: alice};
  assert.equal(serverRuntime(3002, options), path.join(tmpRoot, 'qw-alice', '3002'));
  assert.equal(localRunnerRuntime(3002, options), path.join(tmpRoot, 'qw-alice', 'l-3002'));
  assert.equal(remoteRunnerRuntime('r-0123abcd', options), path.join(tmpRoot, 'qw-alice', 'r-0123ab'));
  assert.equal(accountRoot(options), path.join(tmpRoot, 'qw-alice'));
  assert.notEqual(serverRuntime(3002, options), serverRuntime(3003, options), 'two servers never share a directory');
  assert.notEqual(serverRuntime(3002, options), localRunnerRuntime(3002, options), 'a runner never shares the server directory');
  assert.notEqual(localRunnerRuntime(3002, options), localRunnerRuntime(3003, options));
  assert.notEqual(remoteRunnerRuntime('r-0123abcd', options), remoteRunnerRuntime('r-fedcba98', options), 'two remote runners of one account get two directories');
  assert.notEqual(remoteRunnerRuntime('r-0123abcd', options), localRunnerRuntime(3002, options));
  assert.notEqual(accountRoot(options), accountRoot({tmpRoot, identity: {username: 'bob', uid: uid + 1}}));
  assert.equal(accountRoot().startsWith('/tmp/qw-'), true, 'the real default is in /tmp');
  for (const runtime of [serverRuntime(3002, options), localRunnerRuntime(3002, options), remoteRunnerRuntime('r-0123abcd', options)]) assert.equal(isDefaultRuntime(runtime, options), true);
  assert.equal(isDefaultRuntime('/var/lib/qemuweb/runner', {tmpRoot, identity: alice}), false);
  assert.throws(() => remoteRunnerRuntime('local', options), /Invalid runner ID/);
  assert.throws(() => remoteRunnerRuntime('r-../x', options), /Invalid runner ID/);
});

test('the login is sanitised, and an empty or long one gives the numeric uid', () => {
  assert.equal(accountLabel({username: 'jean.dupont-2_x', uid: 1000}), 'jean.dupont-2_x');
  assert.equal(accountLabel({username: 'éa b/c', uid: 1000}), '_a_b_c');
  assert.equal(accountLabel({username: '', uid: 1234}), '1234');
  assert.equal(accountLabel({username: undefined, uid: 1234}), '1234');
  assert.equal(accountLabel({username: 'a'.repeat(MAX_LOGIN), uid: 1234}), 'a'.repeat(MAX_LOGIN));
  assert.equal(accountLabel({username: 'a'.repeat(MAX_LOGIN + 1), uid: 1234}), '1234');
  assert.equal(accountLabel({username: '../..', uid: 7}).includes('/'), false);
});

test('an explicit --runtime wins: it is used as given and the default directory is never created', t => {
  const tmpRoot = scratch(t);
  const explicit = path.join(tmpRoot, 'chosen');
  const result = prepareRunnerRuntime(explicit, {tmpRoot, identity: alice});
  assert.equal(result.created, true);
  assert.ok(fs.statSync(path.join(explicit, 'sessions')).isDirectory());
  assert.deepEqual(fs.readdirSync(tmpRoot), ['chosen'], 'no qw-<login> directory');
  // An existing directory of another mode (the CREMI /var/lib/qemuweb) is accepted untouched.
  fs.chmodSync(explicit, 0o755);
  assert.equal(prepareRunnerRuntime(explicit, {tmpRoot, identity: alice}).created, false);
  assert.equal(prepareServerRuntime(explicit, {tmpRoot, identity: alice}).created, false, 'the same for a server directory');
  assert.equal(mode(explicit), 0o755);
});

test('every default directory is created with mode 0700 (account and name), and used again as is', t => {
  const tmpRoot = scratch(t);
  const options = {tmpRoot, identity: alice};
  const runtime = localRunnerRuntime(3002, options);
  assert.equal(prepareRunnerRuntime(runtime, options).created, true);
  assert.equal(mode(accountRoot(options)), 0o700);
  assert.equal(mode(runtime), 0o700);
  assert.ok(fs.statSync(path.join(runtime, 'sessions')).isDirectory());
  fs.writeFileSync(path.join(runtime, 'sessions', 'keep'), 'x');
  assert.equal(prepareRunnerRuntime(runtime, options).created, false, 'idempotent');
  assert.equal(fs.readFileSync(path.join(runtime, 'sessions', 'keep'), 'utf8'), 'x', 'nothing removed');
  assert.equal(mode(runtime), 0o700);
  const server = serverRuntime(3002, options);
  const remote = remoteRunnerRuntime('r-0123abcd', options);
  assert.equal(prepareServerRuntime(server, options).created, true);
  assert.equal(prepareRunnerRuntime(remote, options).created, true);
  assert.equal(mode(server), 0o700);
  assert.equal(mode(remote), 0o700);
});

test('the server directory has no sessions/ and no length limit', t => {
  const tmpRoot = scratch(t);
  const options = {tmpRoot, identity: alice};
  const server = serverRuntime(3002, options);
  prepareServerRuntime(server, options);
  assert.deepEqual(fs.readdirSync(server), [], 'nothing of a runner: no sessions/');
  // A server directory as long as one likes (it holds no socket); the same name is refused for a runner.
  const {maxRuntimeLength} = runtimeBudget();
  const long = path.join(tmpRoot, 'd'.repeat(maxRuntimeLength + 20));
  assert.equal(prepareServerRuntime(long, options).created, true);
  assert.deepEqual(fs.readdirSync(long), []);
  assert.throws(() => prepareRunnerRuntime(path.join(tmpRoot, 'e'.repeat(maxRuntimeLength + 1)), options), /Use a shorter --runtime/);
});

test('a pre-created symbolic link is refused, at the account level and at the port level', t => {
  const tmpRoot = scratch(t);
  const options = {tmpRoot, identity: alice};
  const elsewhere = fs.mkdtempSync(path.join(tmpRoot, 'elsewhere-'));
  fs.chmodSync(elsewhere, 0o700);
  fs.symlinkSync(elsewhere, accountRoot(options));
  assert.throws(() => prepareRunnerRuntime(serverRuntime(3002, options), options), /symbolic link.*--runtime DIR/);
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was created through the link');
  fs.unlinkSync(accountRoot(options));
  fs.mkdirSync(accountRoot(options), {mode: 0o700});
  fs.symlinkSync(elsewhere, serverRuntime(3002, options));
  assert.throws(() => prepareRunnerRuntime(serverRuntime(3002, options), options), /symbolic link/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('a directory of another owner is refused and left alone', t => {
  const tmpRoot = scratch(t);
  prepareRunnerRuntime(localRunnerRuntime(3002, {tmpRoot, identity: alice}), {tmpRoot, identity: alice});
  const mallory = {username: 'alice', uid: uid + 1};
  assert.throws(() => prepareRunnerRuntime(localRunnerRuntime(3002, {tmpRoot, identity: mallory}), {tmpRoot, identity: mallory}), /belongs to another user/);
  assert.equal(mode(accountRoot({tmpRoot, identity: alice})), 0o700, 'no chmod of a directory that is not ours');
});

test('a directory open to group or others is refused, not repaired', t => {
  const tmpRoot = scratch(t);
  const options = {tmpRoot, identity: alice};
  const runtime = localRunnerRuntime(3002, options);
  prepareRunnerRuntime(runtime, options);
  for (const unsafe of [0o770, 0o750, 0o755, 0o707, 0o777]) {
    fs.chmodSync(accountRoot(options), unsafe);
    assert.throws(() => prepareRunnerRuntime(runtime, options), /accessible by group or others/, unsafe.toString(8));
    assert.equal(mode(accountRoot(options)), unsafe, 'left as it is');
  }
  fs.chmodSync(accountRoot(options), 0o700);
  fs.chmodSync(runtime, 0o775);
  assert.throws(() => prepareRunnerRuntime(runtime, options), /accessible by group or others/, 'the port directory too');
});

test('something that is not a directory is refused', t => {
  const tmpRoot = scratch(t);
  const options = {tmpRoot, identity: alice};
  fs.writeFileSync(accountRoot(options), 'x');
  assert.throws(() => prepareRunnerRuntime(serverRuntime(3002, options), options), /is not a directory/);
});

test('worst case: a 32 character login, the longest runner name and the longest identifiers fit in 107 bytes', () => {
  const tmpRoot = '/tmp';
  const login = 'l'.repeat(MAX_LOGIN);
  const identity = {username: login, uid: 1};
  const {maxRuntimeLength} = runtimeBudget();
  assert.equal(maxRuntimeLength, 65, 'the budget of a runner directory: 107 - 1 - 41 (sessions/<8 hex>/s-<8 hex>/serial1.sock)');
  const local = localRunnerRuntime(65535, {tmpRoot, identity});
  const remote = remoteRunnerRuntime('r-ffffffff', {tmpRoot, identity});
  assert.equal(local, `/tmp/qw-${login}/l-65535`);
  assert.equal(remote, `/tmp/qw-${login}/r-ffffff`);
  assert.equal(Buffer.byteLength(local), 48, 'l- and 5 digits: 40 + 1 + 7');
  assert.equal(Buffer.byteLength(remote), 49, 'r- and 6 hex digits: 40 + 1 + 8, 16 bytes below the budget');
  assert.equal(runtimeTooLong(local), null);
  assert.equal(runtimeTooLong(remote), null);
  // The server directory has no socket and no limit: a 5 digit port is not even checked.
  assert.equal(Buffer.byteLength(serverRuntime(65535, {tmpRoot, identity})), 46);
  // The paths the runner really builds (not the list of the helper), for a host and a switch.
  for (const runtime of [local, remote]) {
    const session = 'f'.repeat(8);
    const ctx = {runtimeRoot: runtime, session: {id: session, runtimeDir: path.join(runtime, 'sessions', session)}};
    const {sessionPaths} = createSessionRuntime(ctx);
    const built = [];
    for (const id of [`h-${'f'.repeat(8)}`, `s-${'f'.repeat(8)}`]) {
      const paths = sessionPaths(id, id.startsWith('s-') ? 'switch' : 'host');
      built.push(paths.socketPath, paths.socketPath1, paths.monitorPath, ...(paths.mgmtPath ? [paths.mgmtPath, path.join(paths.socketDir, 'ctl')] : []));
    }
    for (const file of built) assert.ok(Buffer.byteLength(file) <= SOCKET_LIMIT, `${file} is ${Buffer.byteLength(file)} bytes`);
    const longest = Math.max(...built.map(file => Buffer.byteLength(file)));
    assert.equal(longest, runtime === remote ? 91 : 90, 'the longest path: 91 bytes for the remote name, 90 for the local one (the limit is 107)');
    // The length of the helper's list is the one of the real builder.
    assert.equal(Math.max(...socketPathsBelowRuntime().map(file => Buffer.byteLength(path.join(runtime, file)))), longest);
  }
  assert.equal(accountRoot({tmpRoot, identity: {username: 'x'.repeat(40), uid: 4294967295}}).length <= '/tmp/qw-'.length + 10, true, 'a long login gives a short uid');
});

test('the length limit is derived from the longest path, and the message names it', t => {
  const {longest, maxRuntimeLength} = runtimeBudget();
  assert.match(longest, /^sessions\/[0-9a-f]{8}\/[hs]-[0-9a-f]{8}\//);
  const exact = '/' + 'a'.repeat(maxRuntimeLength - 1);
  assert.equal(Buffer.byteLength(exact), maxRuntimeLength);
  assert.equal(runtimeTooLong(exact), null);
  assert.equal(Buffer.byteLength(path.join(exact, longest)), SOCKET_LIMIT, 'the maximum runtime directory gives exactly 107 bytes');
  const message = runtimeTooLong(exact + 'b');
  assert.match(message, new RegExp(`too long \\(${maxRuntimeLength + 1} bytes\\)`));
  assert.match(message, new RegExp(`at most ${maxRuntimeLength} bytes`));
  assert.ok(message.includes(path.join(exact + 'b', longest)), 'it names the longest path');
  assert.match(message, /Use a shorter --runtime\.$/);
  assert.doesNotMatch(message, /move the project/);
  // A too long explicit directory is refused before anything is created.
  const tmpRoot = scratch(t);
  const long = path.join(tmpRoot, 'd'.repeat(maxRuntimeLength));
  assert.throws(() => prepareRunnerRuntime(long), /Use a shorter --runtime/);
  assert.equal(fs.existsSync(long), false);
  assert.doesNotThrow(() => prepareServerRuntime(long), 'a server directory of that length is fine');
});

test('the warning: tmpfs or little free space, one line naming the directory, never an error', () => {
  const GB = 1024 ** 3;
  const stat = (type, freeBytes) => () => ({type, bsize: 4096, bavail: freeBytes / 4096});
  assert.equal(storageWarning('/tmp/qw-a/3002', {statfs: stat(0xef53, 100 * GB)}), null);
  const tmpfs = storageWarning('/tmp/qw-a/3002', {statfs: stat(0x01021994, 100 * GB)});
  assert.match(tmpfs, /^runtime directory \/tmp\/qw-a\/3002 is on a tmpfs, in memory.*--runtime DIR/);
  assert.equal(tmpfs.includes('\n'), false);
  assert.match(storageWarning('/x', {statfs: stat(0xef53, 2 * GB)}), /has only 2\.0 GB free/);
  assert.match(storageWarning('/x', {statfs: stat(0x01021994, 1 * GB)}), /tmpfs, in memory and has only 1\.0 GB free/);
  assert.equal(storageWarning('/x', {statfs: stat(0xef53, 5 * GB)}), null, 'exactly 5 GB is enough');
  assert.equal(storageWarning('/x', {statfs: () => { throw new Error('no statfs'); }}), null);
  assert.doesNotThrow(() => storageWarning(os.tmpdir()), 'the real call never throws');
});

test('the scripts ask the same module: every CLI form prints the default, a bad argument exits 2', () => {
  const file = path.join(__dirname, '..', '..', 'common', 'runtime-dir.js');
  const run = (...args) => execFileSync(process.execPath, [file, ...args], {encoding: 'utf8'}).trim();
  assert.equal(run('path', 'server', '3010'), serverRuntime(3010));
  assert.equal(run('path', 'local', '3010'), localRunnerRuntime(3010));
  assert.equal(run('path', 'remote', 'r-0123abcd'), remoteRunnerRuntime('r-0123abcd'));
  assert.equal(run('root'), accountRoot());
  for (const args of [['path'], ['path', '3010'], ['path', 'runner'], ['path', 'server'], ['path', 'server', '../x'], ['path', 'server', '0'], ['path', 'server', '70000'], ['path', 'local', 'runner'],
    ['path', 'remote', 'r-123'], ['path', 'remote', 'local'], ['root', 'x'], ['frob', 'server', '3010'], []]) {
    const bad = spawnSync(process.execPath, [file, ...args], {encoding: 'utf8'});
    assert.equal(bad.status, 2, args.join(' '));
    assert.match(bad.stderr, /Usage: node common\/runtime-dir\.js/);
    assert.equal(bad.stdout, '');
  }
});
