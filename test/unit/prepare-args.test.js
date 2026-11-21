'use strict';

// Command line of scripts/prepare.sh: no argument lists, --system <id|all> builds, --all is the same as --system all, the build
// options need --system. The real script runs in a temporary project root whose per-system scripts are
// STUBS: they only log their calls (and create fake images), so nothing is downloaded or built. The reserved
// system name "all" is checked in the config validation (common/system-config.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {readCatalog} = require('../../common/system-config');

const REPO = path.join(__dirname, '..', '..');
const LIST_HELP = 'To build: bash scripts/prepare.sh --system <id|all> [--force]';

// A root with systems x and y; each stub script logs "<id> <mode>" into calls.log and makes fake images.
function withRoot(body, {images = {}} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-prepare-args-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts', 'prepare', 'lib'), {recursive: true});
    fs.mkdirSync(path.join(root, 'images'));
    fs.cpSync(path.join(REPO, 'common'), path.join(root, 'common'), {recursive: true});
    fs.copyFileSync(path.join(REPO, 'scripts', 'prepare.sh'), path.join(root, 'scripts', 'prepare.sh'));
    for (const file of ['common.sh', 'image-probe.js']) fs.copyFileSync(path.join(REPO, 'scripts', 'prepare', 'lib', file), path.join(root, 'scripts', 'prepare', 'lib', file));
    const {schemaVersion, systems: real} = JSON.parse(fs.readFileSync(path.join(REPO, 'config.json'), 'utf8'));
    const system = name => ({basedOn: 'default', label: name, 'image:qemu': `images/${name}.raw`, 'image:vbox': `images/${name}.vdi`});
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({schemaVersion, systems: {default: real.default, x: system('x'), y: system('y')}}));
    const log = path.join(root, 'calls.log');
    for (const id of ['x', 'y']) {
      const stub = path.join(root, 'scripts', 'prepare', `${id}.sh`);
      fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "${id} $*" >> '${log}'\nif [[ "$1" == --images ]]; then echo raw > '${root}/images/${id}.raw'; echo vdi > '${root}/images/${id}.vdi'; fi\n`, {mode: 0o755});
    }
    for (const [name, content] of Object.entries(images)) fs.writeFileSync(path.join(root, 'images', name), content);
    const run = (...args) => {
      const result = spawnSync('bash', [path.join(root, 'scripts', 'prepare.sh'), ...args], {encoding: 'utf8', env: {...process.env, http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: ''}});
      return {status: result.status, out: result.stdout, err: result.stderr};
    };
    const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    body({root, run, calls});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

test('no argument lists the systems and builds nothing', () => {
  withRoot(({run, calls}) => {
    const result = run();
    assert.equal(result.status, 0, result.err);
    assert.match(result.out, /^System +RAW GB/);
    assert.match(result.out, /^x +-/m);
    assert.equal(result.out.trimEnd().split('\n').at(-1), LIST_HELP);
    assert.deepEqual(calls(), []);
  });
});

test('--list ends with the help line and the table is unchanged', () => {
  withRoot(({run, calls}) => {
    const result = run('--list');
    assert.equal(result.status, 0, result.err);
    assert.equal(result.out, run().out);
    assert.deepEqual(calls(), []);
  });
});

test('--system all prepares every system, in config order', () => {
  withRoot(({run, calls}) => {
    const result = run('--system', 'all');
    assert.equal(result.status, 0, result.err);
    assert.deepEqual(calls(), ['x --sources', 'x --images', 'y --sources', 'y --images']);
    assert.match(result.out, /Prepared 2 system\(s\)\./);
  });
});

test('--system <id> prepares that system only', () => {
  withRoot(({run, calls}) => {
    const result = run('--system', 'y');
    assert.equal(result.status, 0, result.err);
    assert.deepEqual(calls(), ['y --sources', 'y --images']);
    assert.match(result.out, /Prepared 1 system\(s\)\./);
  });
});

test('--all is the same as --system all, and cannot be combined with --system', () => {
  withRoot(({run, calls}) => {
    const result = run('--all');
    assert.equal(result.status, 0, result.err);
    assert.deepEqual(calls(), ['x --sources', 'x --images', 'y --sources', 'y --images']);
    assert.match(result.out, /Prepared 2 system\(s\)\./);
  });
  withRoot(({run, calls}) => {
    for (const args of [['--all', '--system', 'x'], ['--system', 'x', '--all'], ['--all', '--all']]) {
      const result = run(...args);
      assert.equal(result.status, 2, args.join(' '));
      assert.match(result.err, /Choose only one of --system <id\|all> and --all\./);
    }
    assert.deepEqual(calls(), []);
  });
  withRoot(({run}) => {
    assert.equal(run('--all', '--list').status, 2);
    assert.equal(run('--hash', '--all').status, run('--hash', '--system', 'all').status);
  });
});

test('--force, --proxy, -6 and --follow without --system are errors, never a build', () => {
  withRoot(({run, calls}) => {
    for (const args of [['--force'], ['--proxy', 'http://proxy:3128/'], ['-6'], ['--follow'], ['--follow=5'], ['--force', '--follow']]) {
      const result = run(...args);
      assert.equal(result.status, 2, args.join(' '));
      assert.match(result.err, /choose --system <id\|all>/, args.join(' '));
      assert.equal(result.out, '');
    }
    assert.deepEqual(calls(), []);
  });
});

test('--list cannot be combined with preparation options, and --hash neither', () => {
  withRoot(({run, calls}) => {
    for (const option of [['--force'], ['--proxy', 'none'], ['-6'], ['--follow'], ['--system', 'x']]) {
      const result = run('--list', ...option);
      assert.equal(result.status, 2, option.join(' '));
      assert.match(result.err, /--list cannot be combined with preparation options/);
    }
    for (const option of [['--force'], ['--proxy', 'none'], ['-6'], ['--follow'], ['--list']]) {
      const result = run('--hash', ...option);
      assert.equal(result.status, 2, option.join(' '));
      assert.match(result.err, /--hash cannot be combined with/);
    }
    assert.deepEqual(calls(), []);
  });
});

test('--hash alone and --hash --system all hash every built system, without building', () => {
  withRoot(({root, run, calls}) => {
    for (const args of [['--hash'], ['--hash', '--system', 'all']]) {
      const result = run(...args);
      assert.equal(result.status, 0, result.err);
      assert.match(result.out, /x\.raw: hash (recorded|up to date)/);
      assert.match(result.out, /y: not built, skipped/);
    }
    assert.ok(fs.existsSync(path.join(root, 'images', 'x.raw.sha256')));
    assert.deepEqual(calls(), []);
  }, {images: {'x.raw': 'data'}});
});

test('--hash with nothing built tells how to build', () => {
  withRoot(({run}) => {
    const result = run('--hash');
    assert.equal(result.status, 2);
    assert.match(result.err, /Nothing to hash: no image built \(run: bash scripts\/prepare\.sh --system <id\|all>\)\./);
  });
});

test('an unknown system, a repeated --system and a missing id are errors, nothing is built', () => {
  withRoot(({run, calls}) => {
    let result = run('--system', 'nope');
    assert.equal(result.status, 2);
    assert.match(result.err, /Unknown system: nope \(see --list\)\./);
    for (const args of [['--system', 'all', '--system', 'x'], ['--system', 'x', '--system', 'all'], ['--system', 'x', '--system', 'y']]) {
      result = run(...args);
      assert.equal(result.status, 2, args.join(' '));
      assert.match(result.err, /Choose only one --system <id\|all>\./);
    }
    for (const args of [['--system'], ['--system', '--force'], ['--system', '']]) {
      result = run(...args);
      assert.equal(result.status, 2, args.join(' '));
      assert.match(result.err, /Expected a system ID, or all, after --system\./);
    }
    assert.deepEqual(calls(), []);
  });
});

test('--help describes the new rules, with --all as the same as --system all', () => {
  withRoot(({run}) => {
    const result = run('--help');
    assert.equal(result.status, 0);
    assert.match(result.out, /--system <id\|all>/);
    assert.match(result.out, /same as --list/);
    assert.match(result.out, /--all +Same as --system all\./);
  });
});

test('"all" is a reserved system name in config.json, and in prepare.sh', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(REPO, 'config.json'), 'utf8'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-reserved-'));
  try {
    const file = path.join(directory, 'config.json');
    const config = structuredClone(shipped);
    config.systems.all = {basedOn: 'alpine'};
    fs.writeFileSync(file, JSON.stringify(config));
    assert.throws(() => readCatalog(file), /"all" is reserved/);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
  withRoot(({root, run}) => {
    const file = path.join(root, 'config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.systems.all = config.systems.x;
    fs.writeFileSync(file, JSON.stringify(config));
    const result = run('--list');
    assert.notEqual(result.status, 0);
    assert.match(result.err, /"all" is reserved/);
  });
});
