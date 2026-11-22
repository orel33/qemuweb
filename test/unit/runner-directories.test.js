// One directory per process (RUN03d, docs/runner-model.md R1 and R2): the remote runner's default is named after its id, a
// runner never shares the server's directory, and the scripts (start.sh, demo.sh, stop.sh, killall.sh, cleanall.sh, status.js)
// use the same rules. No runner, no server, no QEMU: functions, and the text of the scripts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {execFileSync} = require('node:child_process');
const {load} = require('../../runner/remote-identity');
const {writeRunnerConfig} = require('../../runner/config-file');
const {runnerSpec, runSpec, parseRunnerArguments} = require('../../runner/options');
const cli = require('../../common/cli');
const {serverRuntime, localRunnerRuntime, remoteRunnerRuntime, runtimeBudget, MAX_LOGIN} = require('../../common/runtime-dir');
const {tokenFilePath} = require('../../common/local-token');

const root = path.join(__dirname, '..', '..');
const script = name => fs.readFileSync(path.join(root, 'scripts', name), 'utf8');

function runnerFile(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-dirs-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'runner.json');
  writeRunnerConfig(file, {url: 'https://qemuweb.example.org', runnerId: 'r-0a1b2c3d', authToken: 'x'.repeat(40), name: 'lab', ...extra});
  return file;
}

const options = (argv, file) => cli.parseArguments(runSpec(root), ['--runner-config', file, ...argv]).settings;

test('a remote runner without --runtime takes r-<6 hex of its id>; --runtime and the runner file win; no runner file: no directory', t => {
  const file = runnerFile(t);
  const settings = options([], file);
  load(settings);
  assert.equal(settings.runtime, remoteRunnerRuntime('r-0a1b2c3d'));
  assert.match(path.basename(settings.runtime), /^r-0a1b2c$/);
  assert.notEqual(settings.runtime, serverRuntime(3002));

  const given = options(['--runtime', '/var/lib/qemuweb/runner'], file);
  load(given);
  assert.equal(given.runtime, '/var/lib/qemuweb/runner', 'an explicit --runtime is used as given');

  const kept = options([], runnerFile(t, {runtime: '/srv/qw/runner'}));
  load(kept);
  assert.equal(kept.runtime, '/srv/qw/runner', 'the "runtime" of the runner file comes before the default');

  const other = options([], runnerFile(t, {runnerId: 'r-ffeeddcc'}));
  load(other);
  assert.notEqual(other.runtime, settings.runtime, 'two runners of one account get two directories');

  const missing = options([], path.join(os.tmpdir(), 'qw-no-such-runner-file.json'));
  const identity = load(missing);
  assert.equal(missing.runtime, null);
  assert.match(identity.fileError.message, /register this runner first/);
});

test('the defaults of the three kinds, for a 32 character login: the runner directories fit the budget, the server needs none', () => {
  const identity = {username: 'z'.repeat(MAX_LOGIN), uid: 1};
  const {maxRuntimeLength} = runtimeBudget();
  const local = localRunnerRuntime(65535, {tmpRoot: '/tmp', identity});
  const remote = remoteRunnerRuntime('r-ffffffff', {tmpRoot: '/tmp', identity});
  assert.ok(Buffer.byteLength(local) <= maxRuntimeLength && Buffer.byteLength(remote) <= maxRuntimeLength, `${Buffer.byteLength(local)} and ${Buffer.byteLength(remote)} <= ${maxRuntimeLength}`);
  assert.equal(path.basename(local).length, 7);
  assert.equal(path.basename(remote).length, 8);
  assert.ok(path.basename(local).length <= 8 && path.basename(remote).length <= 8);
});

test('the local runner defaults: its own directory l-<port>, the token file of the server directory', () => {
  const settings = parseRunnerArguments(['--port', '3123'], {root});
  assert.equal(settings.runtime, localRunnerRuntime(3123));
  assert.equal(settings.tokenFile, tokenFilePath(serverRuntime(3123)));
  assert.notEqual(path.dirname(settings.tokenFile), settings.runtime, 'the runner does not live in the server directory');
  const help = runnerSpec(root).options.find(option => option.flag === '--runtime');
  assert.match(help.description, /l-PORT/);
  assert.equal(help.fallback, '/tmp/qw-<login>/l-<port>');
  assert.equal(runSpec(root).options.find(option => option.flag === '--runtime').fallback, '/tmp/qw-<login>/r-<runner ID>');
});

test('the scripts ask the one rule: no hand-made /tmp/qw- path, the same names as the processes', () => {
  const sh = execFileSync('bash', ['-c', `source ${root}/scripts/lib/runtime.sh; default_runtime 3055; default_runner_runtime 3055; default_account_root; local_runner_token_file /x/s`], {encoding: 'utf8'}).trim().split('\n');
  assert.deepEqual(sh, [serverRuntime(3055), localRunnerRuntime(3055), path.dirname(serverRuntime(3055)), '/x/s/local-runner.token']);
  for (const name of ['start.sh', 'stop.sh', 'killall.sh', 'cleanall.sh', 'demo.sh', 'runner.sh', 'server.sh', 'status.sh']) {
    assert.doesNotMatch(script(name).replace(/^\s*#.*$/gm, ''), /\/tmp\/qw-|default_runtime runner|path runner/, name);
  }
  assert.match(script('killall.sh'), /default_account_root/, 'killall covers the whole account root');
  assert.match(script('cleanall.sh'), /default_account_root/, 'so does cleanall');
});

test('start.sh: --runtime is the server directory, --runner-runtime the runner one; both are printed; the token file is in the server directory', () => {
  const text = script('start.sh');
  assert.match(text, /--runner-runtime\)/);
  assert.match(text, /runner_runtime="\$\(default_runner_runtime "\$port"\)"/, 'the runner default is its own l-<port>');
  assert.match(text, /\[\[ -n "\$runtime" \]\] \|\| runtime="\$\(default_runtime "\$port"\)"/);
  assert.match(text, /token_file="\$\(local_runner_token_file "\$runtime"\)"/, 'the token file comes from the SERVER directory');
  assert.match(text, /echo "Server directory: \$runtime"/);
  assert.match(text, /echo "Runner directory: \$\{runner_runtime\}"/);
  assert.match(text, /The runner keeps its sessions in \$runner_runtime; add --runner-runtime DIR to move them\./);
  assert.match(text, /runtime_args=\(--runtime "\$runner_runtime"\)/);
  // --runner-runtime is consumed by the script: the server never gets it.
  assert.doesNotMatch(text, /server_args\+=\("--runner-runtime"/);
  const serverBranch = /--runner-runtime\)\n([\s\S]*?)shift ;;/.exec(text)[1];
  assert.doesNotMatch(serverBranch, /server_args/);
  assert.match(text, /scripts\/runner\.sh --port "\$port" "\$\{host_args\[@\]\}" --token-file "\$token_file" "\$\{runtime_args\[@\]\}" --exit-on-disconnect/);
});

test('demo.sh: one temporary directory with two subdirectories, the server\'s and the runner\'s', () => {
  const text = script('demo.sh');
  assert.match(text, /mkdir -p "\$demo_dir\/server" "\$demo_dir\/runner"/);
  assert.match(text, /--runtime "\$demo_dir\/server" --runner-runtime "\$demo_dir\/runner"/);
  assert.match(text, /rm -rf -- "\$demo_dir"/, 'the cleanup removes both');
  assert.doesNotMatch(text, /demo_dir\/runtime/);
});

test('stop.sh and status.js: the server pid file is in the server directory; the runner of a port is found by --port; status reads the runner\'s own directory', () => {
  const stop = script('stop.sh');
  assert.match(stop, /runtime="\$\(default_runtime "\$port"\)"/);
  assert.match(stop, /pid_file="\$runtime\/server-\$port\.pid"/);
  assert.match(stop, /\*" --port \$port "\*/);
  const status = script('status.js');
  assert.match(status, /servers\.some\(server => server\.port === port\)/, 'pairing by port');
  assert.match(status, /runnerSessionsDir\(entry\.args\)/, 'the runner directory comes from the runner command line');
  assert.doesNotMatch(status, /runner-\d+\.sock|dialledRuntime|runtime === /);
  assert.match(status, /path\.dirname\(sessionsDir\), 'users'/, 'aliases are read beside the runner\'s sessions/');
  assert.match(status, /'meta\.json'/);
});
