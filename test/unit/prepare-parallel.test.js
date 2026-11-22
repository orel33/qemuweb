'use strict';

// scripts/prepare.sh --parallel[=N]: several systems built at the same time. The real script runs in a
// temporary project root whose per-system scripts are STUBS (they log "+id" when the build starts and "-id"
// when it ends in events.log, print the same "where to follow" block as the real builds through
// build_log_info, and sleep), so nothing is downloaded or built and the overlap can be measured.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');

// A root with the systems `ids`; options.sleep (seconds) and options.fail (ids whose image build fails, after
// `failSleep` seconds) shape the stubs.
function makeRoot(ids, {sleep = 0, fail = [], failSleep = 0, sleeps = {}} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-prepare-parallel-'));
  fs.mkdirSync(path.join(root, 'scripts', 'prepare', 'lib'), {recursive: true});
  fs.mkdirSync(path.join(root, 'images'));
  fs.cpSync(path.join(REPO, 'common'), path.join(root, 'common'), {recursive: true});
  fs.copyFileSync(path.join(REPO, 'scripts', 'prepare.sh'), path.join(root, 'scripts', 'prepare.sh'));
  for (const file of ['common.sh', 'image-probe.js']) fs.copyFileSync(path.join(REPO, 'scripts', 'prepare', 'lib', file), path.join(root, 'scripts', 'prepare', 'lib', file));
  const {schemaVersion, systems: real} = JSON.parse(fs.readFileSync(path.join(REPO, 'config.json'), 'utf8'));
  const system = name => ({basedOn: 'default', label: name, 'image:qemu': `images/${name}.raw`, 'image:vbox': `images/${name}.vdi`});
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({schemaVersion, systems: {default: real.default, ...Object.fromEntries(ids.map(id => [id, system(id)]))}}));
  for (const id of ids) {
    const failing = fail.includes(id);
    const stub = `#!/usr/bin/env bash
source '${root}/scripts/prepare/lib/common.sh'
id=${id}; events='${root}/events.log'
if [[ "$1" == --sources ]]; then echo "sources of $id"; exit 0; fi
echo "+$id" >> "$events"
echo "$$" > '${root}/${id}.pid'
build_log_info "Installing $id in a VM" "$RUNTIME/$id-serial.log"
echo "[###-------]  30%  Fake phase of $id  00:01  log 1 KB"
sleep ${failing ? failSleep : (sleeps[id] ?? sleep)}
${failing ? `echo "-$id FAILED" >> "$events"; echo "boom $id" >&2; exit 1` : `echo "-$id" >> "$events"; echo raw > '${root}/images/'$id.raw; echo vdi > '${root}/images/'$id.vdi`}
`;
    fs.writeFileSync(path.join(root, 'scripts', 'prepare', `${id}.sh`), stub, {mode: 0o755});
  }
  const env = {...process.env, http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: ''};
  const script = path.join(root, 'scripts', 'prepare.sh');
  const run = (...args) => {
    const started = Date.now();
    const result = spawnSync('bash', [script, ...args], {encoding: 'utf8', env});
    return {status: result.status, out: result.stdout, err: result.stderr, seconds: (Date.now() - started) / 1000};
  };
  const events = () => fs.existsSync(path.join(root, 'events.log')) ? fs.readFileSync(path.join(root, 'events.log'), 'utf8').split('\n').filter(Boolean) : [];
  // The highest number of builds running at the same time, from the "+id" / "-id" events.
  const maxConcurrent = () => {
    let now = 0, max = 0;
    for (const event of events()) { now += event.startsWith('+') ? 1 : -1; max = Math.max(max, now); }
    return max;
  };
  return {root, env, script, run, events, maxConcurrent, cleanup: () => fs.rmSync(root, {recursive: true, force: true})};
}

function withRoot(ids, options, body) {
  const r = makeRoot(ids, options);
  try { body(r); } finally { r.cleanup(); }
}

test('--parallel builds two systems at the same time: they overlap, in about the time of one', () => {
  withRoot(['x', 'y'], {sleep: 3}, ({root, run, events}) => {
    const result = run('--system', 'all', '--parallel');
    assert.equal(result.status, 0, result.err);
    // both builds started before either ended
    assert.deepEqual(events().slice(0, 2).sort(), ['+x', '+y']);
    assert.deepEqual(events().slice(2).sort(), ['-x', '-y']);
    assert.ok(result.seconds < 5.5, `two 3 s builds took ${result.seconds} s: they ran one after the other`);
    assert.match(result.out, /Parallel build: 2 systems, up to 2 at once \(x y\)\. Logs: .*\/sources\/\.prepare\/\.parallel\.[^/]+\/<id>\.log/);
    // without a terminal: plain lines
    assert.match(result.out, /^x: started, log .*\/x\.log$/m);
    assert.match(result.out, /^y: started, log .*\/y\.log$/m);
    assert.match(result.out, /^x: build VM started, serial log .*\/x-serial\.log$/m);
    assert.match(result.out, /^x: done in 00:00:0\d$/m);
    assert.match(result.out, /^y: done in 00:00:0\d$/m);
    assert.match(result.out, /^ {2}x +done +00:00:0\d +log .*\/x\.log$/m);
    assert.match(result.out, /Prepared 2 system\(s\)\./);
    assert.ok(fs.existsSync(path.join(root, 'images', 'x.raw.sha256')) && fs.existsSync(path.join(root, 'images', 'y.vdi.sha256')), 'hashes recorded by each job');
    // a successful run removes its logs
    assert.deepEqual(fs.readdirSync(path.join(root, 'sources', '.prepare')).filter(name => name.startsWith('.parallel.')), []);
  });
});

test('--parallel selects as many builds as systems, at most 4; --parallel=N is at most N (and not more than the systems)', () => {
  withRoot(['a', 'b', 'c', 'd', 'e'], {sleep: 0.3}, ({run, maxConcurrent}) => {
    const result = run('--all', '--parallel');
    assert.equal(result.status, 0, result.err);
    assert.match(result.out, /5 systems, up to 4 at once/);
    assert.equal(maxConcurrent(), 4);
  });
  withRoot(['a', 'b', 'c', 'd', 'e'], {sleep: 0.3}, ({run, maxConcurrent}) => {
    const result = run('--all', '--parallel=2');
    assert.equal(result.status, 0, result.err);
    assert.match(result.out, /up to 2 at once/);
    assert.equal(maxConcurrent(), 2);
    assert.match(result.out, /Prepared 5 system\(s\)\./);
  });
  withRoot(['a', 'b', 'c', 'd', 'e'], {sleep: 0.3}, ({run, maxConcurrent}) => {
    const result = run('--all', '--parallel=8');
    assert.equal(result.status, 0, result.err);
    assert.match(result.out, /up to 5 at once/);
    assert.equal(maxConcurrent(), 5);
  });
  withRoot(['a', 'b', 'c'], {sleep: 0.3}, ({run}) => {
    assert.match(run('--all', '--parallel').out, /3 systems, up to 3 at once/);
  });
});

test('--parallel=1 and a single system are the sequential build, with the output of today', () => {
  let reference;
  withRoot(['x', 'y'], {}, ({run}) => { reference = run('--all'); });
  assert.equal(reference.status, 0, reference.err);
  assert.doesNotMatch(reference.out, /Parallel build/);
  assert.match(reference.out, /== x · ready in 00:00:00/);
  withRoot(['x', 'y'], {}, ({run, events}) => {
    const result = run('--all', '--parallel=1');
    assert.equal(result.status, 0, result.err);
    assert.deepEqual(events(), ['+x', '-x', '+y', '-y']);
    assert.doesNotMatch(result.out, /Parallel build|: started/);
    assert.equal(result.out.split('\n').length, reference.out.split('\n').length);
    assert.match(result.out, /Prepared 2 system\(s\)\./);
  });
  // one system: --parallel is accepted and ignored, silently
  withRoot(['x', 'y'], {}, ({run, events}) => {
    const result = run('--system', 'y', '--parallel');
    assert.equal(result.status, 0, result.err);
    assert.doesNotMatch(result.out, /Parallel build|: started/);
    assert.deepEqual(events(), ['+y', '-y']);
    assert.match(result.out, /Prepared 1 system\(s\)\./);
  });
});

test('the sequential build shows where to follow it: serial log and the tail -f command, no socket', () => {
  withRoot(['x'], {}, ({run}) => {
    const result = run('--system', 'x');
    assert.equal(result.status, 0, result.err);
    assert.match(result.out, /^ {2}Installing x in a VM$/m);
    assert.match(result.out, /^ {4}log: (\S+\/sources\/\.prepare\/x-serial\.log) {2}\(follow: tail -f \1\)$/m);
    assert.doesNotMatch(result.out, /socket/);
  });
});

test('a failing build does not stop the others: summary of every system, end of the failed log, non-zero status', () => {
  withRoot(['x', 'y', 'z'], {sleeps: {x: 1, z: 3}, fail: ['y'], failSleep: 1}, ({root, run, events}) => {
    const result = run('--all', '--parallel');
    assert.equal(result.status, 1, result.err);
    // z, the slowest, ended after y had failed, and finished its image
    assert.ok(events().indexOf('-y FAILED') < events().indexOf('-z'), events().join(' '));
    assert.ok(fs.existsSync(path.join(root, 'images', 'z.raw')) && fs.existsSync(path.join(root, 'images', 'x.raw')));
    assert.ok(!fs.existsSync(path.join(root, 'images', 'y.raw')));
    assert.match(result.out, /^y: FAILED after 00:00:0\d \(log .*\/y\.log\)$/m);
    assert.match(result.out, /^ {2}x +done +/m);
    assert.match(result.out, /^ {2}y +FAILED +/m);
    assert.match(result.out, /^ {2}z +done +/m);
    assert.match(result.err, /prepare\.sh: y failed \(exit status 1\)\. Last 20 lines of its log:/);
    assert.match(result.err, /\| boom y/);
    assert.match(result.err, /\| prepare\.sh: Image preparation failed for y after /);
    assert.match(result.err, /Full log: \S+\/y\.log/);
    assert.match(result.err, /1 of 3 system\(s\) failed\. Logs kept in /);
    assert.doesNotMatch(result.out, /Prepared 3 system/);
    // the logs are kept, one per system
    const kept = fs.readdirSync(path.join(root, 'sources', '.prepare')).filter(name => name.startsWith('.parallel.'));
    assert.equal(kept.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(root, 'sources', '.prepare', kept[0])).sort(), ['x.log', 'y.log', 'z.log']);
  });
});

test('with --force, each job saves its images in the backup directory of the run and puts them back on failure', () => {
  withRoot(['x', 'y'], {fail: ['y'], failSleep: 0.2, sleep: 0.2}, ({root, run}) => {
    for (const id of ['x', 'y']) { fs.writeFileSync(path.join(root, 'images', `${id}.raw`), `old ${id}`); fs.writeFileSync(path.join(root, 'images', `${id}.vdi`), `old ${id}`); }
    const result = run('--all', '--force', '--parallel');
    assert.equal(result.status, 1, result.err);
    assert.match(result.err, /WARNING: --force replaces/);
    assert.equal((result.err.match(/WARNING: --force replaces/g) || []).length, 1);
    assert.equal(fs.readFileSync(path.join(root, 'images', 'y.raw'), 'utf8'), 'old y');   // restored
    assert.equal(fs.readFileSync(path.join(root, 'images', 'x.raw'), 'utf8'), 'raw\n');   // rebuilt
    const backups = fs.readdirSync(path.join(root, 'images', 'backups'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(root, 'images', 'backups', backups[0], 'x', 'x.raw'), 'utf8'), 'old x');
    assert.match(result.err, /Previous images: /);
  });
});

test('--parallel is refused with --list and --hash, and its number is checked', () => {
  withRoot(['x', 'y'], {}, ({run, events}) => {
    let result = run('--list', '--parallel');
    assert.equal(result.status, 2);
    assert.match(result.err, /--list cannot be combined with preparation options/);
    result = run('--hash', '--parallel');
    assert.equal(result.status, 2);
    assert.match(result.err, /--hash cannot be combined with .*--parallel/);
    result = run('--hash', '--parallel=2', '--system', 'all');
    assert.equal(result.status, 2);
    for (const value of ['0', '9', 'x', '', '2.5']) {
      result = run('--all', `--parallel=${value}`);
      assert.equal(result.status, 2, value);
      assert.match(result.err, /--parallel=N needs a number of builds from 1 to 8\./);
    }
    // a build option: without a system it is an error, like --force
    result = run('--parallel');
    assert.equal(result.status, 2);
    assert.match(result.err, /--parallel needs a system: choose --system <id\|all>\./);
    assert.deepEqual(events(), []);
  });
});

test('SIGTERM stops every running build, and the exit status says so', async () => {
  const r = makeRoot(['x', 'y'], {sleep: 30});
  try {
    const child = spawn('bash', [r.script, '--all', '--parallel'], {env: r.env, stdio: ['ignore', 'pipe', 'pipe']});
    let err = '';
    child.stderr.on('data', chunk => { err += chunk; });
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({code, signal})));
    const pidFiles = ['x', 'y'].map(id => path.join(r.root, `${id}.pid`));
    for (let i = 0; i < 100 && !pidFiles.every(file => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()); i++) await new Promise(resolve => setTimeout(resolve, 100));
    const pids = pidFiles.map(file => Number(fs.readFileSync(file, 'utf8')));
    assert.equal(pids.length, 2);
    for (const pid of pids) process.kill(pid, 0);   // both stubs run
    child.kill('SIGTERM');
    const {code} = await exited;
    assert.equal(code, 143);
    assert.match(err, /interrupted/);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
  } finally { r.cleanup(); }
});
