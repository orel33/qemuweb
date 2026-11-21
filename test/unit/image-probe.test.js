'use strict';

// The ttyS1 login and guest agent notes of `prepare.sh --list` (scripts/prepare/lib/image-probe.js). A STUB
// `debugfs` placed first in PATH and a fake image file in a temporary directory stand in for the
// real tools and images: no real image is read, nothing outside the temporary directory is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {ttys1Login, guestAgent, describe, describeGuestAgent, partitionOffsets} = require('../../scripts/prepare/lib/image-probe');

const ENABLED = '/etc/systemd/system/getty.target.wants/serial-getty@ttyS1.service';
const MBR_EMPTY_TYPE = 0;

// MBR with up to four partitions given as [type, firstSector].
function mbr(partitions) {
  const buffer = Buffer.alloc(512);
  partitions.forEach(([type, sector], index) => { buffer[446 + 16 * index + 4] = type; buffer.writeUInt32LE(sector, 446 + 16 * index + 8); });
  buffer.writeUInt16LE(0xaa55, 510);
  return buffer;
}

// Stub debugfs. STUB_MODE: enabled (symlink present), disabled (absent, root filesystem),
// garbage (unexpected text), hang (never answers), fail (exit 1 without output). STUB_ROOT_OFFSET,
// STUB_AGENT (restricted, open, none) says what the root filesystem holds for the guest agent: the binary
// at STUB_AGENT_PATH (default /usr/sbin/qemu-ga) and, for restricted, a configuration with the allow-rpcs line.
// STUB_ROOT_OFFSET,
// when set, makes any other partition answer "Bad magic number" (it is not an ext filesystem).
const STUB = `#!/bin/bash
echo "$*" >> "$STUB_LOG"
if [[ "\${STUB_MODE}" == hang ]]; then sleep 30; fi
[[ "\${STUB_MODE}" == fail ]] && exit 1
[[ "\${STUB_MODE}" == garbage ]] && { echo "lorem ipsum"; exit 0; }
offset="\${@: -1}"; offset="\${offset##*offset=}"
echo "debugfs 1.47.0 (5-Feb-2023)"
if [[ -n "\${STUB_ROOT_OFFSET}" && "$offset" != "\${STUB_ROOT_OFFSET}" ]]; then echo "stat: Bad magic number in super-block while opening filesystem" >&2; exit 0; fi
case "$3" in
  "stat ${ENABLED}") if [[ "\${STUB_MODE}" == enabled ]]; then echo "Inode: 42120   Type: symlink    Mode:  0777"; else echo "${ENABLED}: File not found by ext2_lookup" >&2; fi ;;
  "stat /etc/os-release") echo "Inode: 17   Type: regular    Mode:  0644" ;;
  "stat \${STUB_AGENT_PATH:-/usr/sbin/qemu-ga}") if [[ -n "\${STUB_AGENT}" && "\${STUB_AGENT}" != none ]]; then echo "Inode: 99   Type: regular    Mode:  0755"; else echo "File not found by ext2_lookup" >&2; fi ;;
  "cat /etc/qemu/qemu-ga.conf") if [[ "\${STUB_AGENT}" == restricted ]]; then printf '[general]\\n# comment\\nallow-rpcs=guest-ping,guest-info\\n'; elif [[ "\${STUB_AGENT}" == commented ]]; then printf '[general]\\n#allow-rpcs=guest-ping\\nallow-rpcs=\\n'; else echo "cat: File not found by ext2_lookup" >&2; fi ;;
esac
`;

function withEnvironment(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-ttys1-'));
  try { body(dir); } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

function setup(dir, partitions, mode, {stub = true, rootOffset = ''} = {}) {
  const image = path.join(dir, 'debian.raw');
  fs.writeFileSync(image, mbr(partitions));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  if (stub) fs.writeFileSync(path.join(bin, 'debugfs'), STUB, {mode: 0o755});
  const log = path.join(dir, 'debugfs.log');
  Object.assign(process.env, {STUB_MODE: mode, STUB_LOG: log, STUB_ROOT_OFFSET: rootOffset});
  return {image, bin, log};
}

// Runs body with PATH reduced to the stub directory and the standard tools (bash, sleep).
function withPath(bin, body) {
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  try { return body(); } finally { process.env.PATH = saved; }
}

test('a linked serial-getty@ttyS1 service is "yes"; debugfs reads the first partition read-only', () => {
  withEnvironment(dir => {
    const {image, bin, log} = setup(dir, [[0x83, 2048]], 'enabled');
    assert.equal(withPath(bin, () => ttys1Login(image)), 'yes');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(calls, [`-c -R stat ${ENABLED} ${image}?offset=1048576`]);
    assert.equal(describe('yes', 'debian13-legacy'), 'ttyS1 login: yes');
  });
});

test('a missing link on a root filesystem is "no", with the rebuild command', () => {
  withEnvironment(dir => {
    const {image, bin} = setup(dir, [[0x83, 2048]], 'disabled');
    const result = withPath(bin, () => ttys1Login(image));
    assert.equal(result, 'no');
    assert.equal(describe(result, 'debian13-cloud'), 'ttyS1 login: no (rebuild: bash scripts/prepare.sh --system debian13-cloud --force)');
  });
});

test('a first partition that is not the root filesystem is skipped for the next one', () => {
  withEnvironment(dir => {
    const {image, bin, log} = setup(dir, [[0xef, 2048], [0x83, 4096]], 'enabled', {rootOffset: String(4096 * 512)});
    assert.equal(withPath(bin, () => ttys1Login(image)), 'yes');
    assert.match(fs.readFileSync(log, 'utf8'), /offset=1048576\n.*offset=2097152\n/);
  });
});

test('every other situation is "unknown" and never throws', () => {
  withEnvironment(dir => {
    for (const mode of ['garbage', 'fail']) {
      const {image, bin} = setup(dir, [[0x83, 2048]], mode);
      assert.equal(withPath(bin, () => ttys1Login(image)), 'unknown', mode);
      fs.rmSync(bin, {recursive: true}); // setup recreates it
    }
    // A debugfs that never answers is stopped by the time limit.
    let {image, bin} = setup(dir, [[0x83, 2048]], 'hang');
    const started = Date.now();
    assert.equal(withPath(bin, () => ttys1Login(image, {timeoutMs: 300})), 'unknown');
    assert.ok(Date.now() - started < 5000);
    fs.rmSync(bin, {recursive: true});
    // debugfs absent from PATH.
    ({image, bin} = setup(dir, [[0x83, 2048]], 'enabled', {stub: false}));
    assert.equal(withPath(bin, () => ttys1Login(image)), 'unknown');
    // Unreadable image, no partition table, empty partition table, GPT header missing.
    assert.equal(ttys1Login(path.join(dir, 'missing.raw')), 'unknown');
    fs.writeFileSync(image, Buffer.alloc(512));
    assert.equal(ttys1Login(image), 'unknown');
    fs.writeFileSync(image, mbr([[MBR_EMPTY_TYPE, 0]]));
    assert.equal(ttys1Login(image), 'unknown');
    fs.writeFileSync(image, mbr([[0xee, 1]]));
    assert.equal(ttys1Login(image), 'unknown');
    assert.equal(describe('unknown', 'x'), 'ttyS1 login: unknown');
  });
});

test('partitionOffsets reads an MBR and a GPT', () => {
  withEnvironment(dir => {
    const file = path.join(dir, 'disk.raw');
    fs.writeFileSync(file, mbr([[0x83, 2048], [0x82, 9000]]));
    let fd = fs.openSync(file, 'r');
    assert.deepEqual(partitionOffsets(fd), [2048 * 512, 9000 * 512]);
    fs.closeSync(fd);
    const disk = Buffer.alloc(512 * 4);
    mbr([[0xee, 1]]).copy(disk);
    disk.write('EFI PART', 512, 'latin1');
    disk.writeBigUInt64LE(2n, 512 + 72);
    disk.writeUInt32LE(128, 512 + 84);
    disk.write('x', 1024); // partition type GUID (non-zero: a used entry)
    disk.writeBigUInt64LE(2048n, 1024 + 32);
    fs.writeFileSync(file, disk);
    fd = fs.openSync(file, 'r');
    assert.deepEqual(partitionOffsets(fd), [2048 * 512]);
    fs.closeSync(fd);
  });
});

test('--list prints one ttyS1 line per Debian raw image and one guest agent line per raw image, and keeps the table', () => {
  withEnvironment(dir => {
    const root = path.join(dir, 'root');
    const repo = path.join(__dirname, '..', '..');
    fs.mkdirSync(path.join(root, 'scripts', 'prepare', 'lib'), {recursive: true});
    fs.mkdirSync(path.join(root, 'images'));
    fs.cpSync(path.join(repo, 'common'), path.join(root, 'common'), {recursive: true});
    fs.copyFileSync(path.join(repo, 'scripts', 'prepare.sh'), path.join(root, 'scripts', 'prepare.sh'));
    fs.copyFileSync(path.join(repo, 'scripts', 'prepare', 'lib', 'image-probe.js'), path.join(root, 'scripts', 'prepare', 'lib', 'image-probe.js'));
    const {schemaVersion, systems: realSystems} = JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8'));
    const system = (name, extra) => ({basedOn: 'default', label: name, 'image:qemu': `images/${name}.raw`, 'image:vbox': `images/${name}.vdi`, ...extra});
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({schemaVersion, systems: {default: realSystems.default, 'debian13-legacy': system('debian13-legacy'), alpine: system('alpine'), 'debian13-cloud': system('debian13-cloud')}}));
    const {image, bin} = setup(dir, [[0x83, 2048]], 'disabled');
    process.env.STUB_AGENT = 'restricted';
    for (const name of ['debian13-legacy', 'alpine']) fs.copyFileSync(image, path.join(root, 'images', `${name}.raw`));
    const run = () => spawnSync('bash', [path.join(root, 'scripts', 'prepare.sh'), '--list'], {encoding: 'utf8', env: {...process.env, PATH: `${bin}:${process.env.PATH}`}});
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split('\n').filter(Boolean);
    assert.match(lines[0], /^System +RAW GB +VDI GB +Total GB +Built \(local time\) +SHA-256 raw\/vdi$/);
    assert.equal(lines.filter(line => /ttyS1 login/.test(line)).length, 1); // debian13-cloud has no image
    const legacy = lines.filter(line => /^debian13-legacy +(ttyS1|guest)/.test(line));
    assert.match(legacy[0], /^debian13-legacy +ttyS1 login: no \(rebuild: bash scripts\/prepare\.sh --system debian13-legacy --force\)$/);
    assert.match(legacy[1], /^debian13-legacy +guest agent: yes \(restricted\)$/);
    assert.match(lines.at(-1), /^alpine +guest agent: yes \(restricted\)$/);
    assert.ok(!lines.some(line => /^alpine +ttyS1/.test(line)));
    assert.equal(lines.filter(line => /guest agent/.test(line)).length, 2); // debian13-cloud has no image
    // Without debugfs the listing still succeeds with "unknown".
    fs.rmSync(path.join(bin, 'debugfs'));
    const withoutDebugfs = spawnSync('bash', [path.join(root, 'scripts', 'prepare.sh'), '--list'], {encoding: 'utf8', env: {...process.env, PATH: `${bin}:/usr/bin:/bin`}});
    assert.equal(withoutDebugfs.status, 0);
    assert.match(withoutDebugfs.stdout, /debian13-legacy +ttyS1 login: unknown\ndebian13-legacy +guest agent: unknown\nalpine +guest agent: unknown\n$/);
  });
});

test('the guest agent: restricted, open (no configuration), none, and the Alpine/OpenWrt binary place', () => {
  withEnvironment(dir => {
    const {image, bin, log} = setup(dir, [[0x83, 2048]], 'disabled');
    const probe = (agent, binary) => { Object.assign(process.env, {STUB_AGENT: agent, STUB_AGENT_PATH: binary || ''}); return withPath(bin, () => guestAgent(image)); };
    assert.equal(probe('restricted'), 'restricted');
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [`-c -R stat /etc/os-release ${image}?offset=1048576`, `-c -R stat /usr/sbin/qemu-ga ${image}?offset=1048576`, `-c -R cat /etc/qemu/qemu-ga.conf ${image}?offset=1048576`]);
    assert.equal(probe('restricted', '/usr/bin/qemu-ga'), 'restricted');
    assert.equal(probe('open'), 'open');
    assert.equal(probe('commented'), 'open'); // a commented or empty allow-rpcs is no allowlist
    assert.equal(probe('none'), 'none');
    assert.equal(describeGuestAgent('restricted', 'x'), 'guest agent: yes (restricted)');
    assert.equal(describeGuestAgent('open', 'x'), 'guest agent: yes (NOT restricted)');
    assert.equal(describeGuestAgent('none', 'alpine'), 'guest agent: no (rebuild: bash scripts/prepare.sh --system alpine --force)');
    assert.equal(describeGuestAgent('unknown', 'x'), 'guest agent: unknown');
  });
});

test('the guest agent is read on the root filesystem only, and everything else is "unknown"', () => {
  withEnvironment(dir => {
    const {image, bin} = setup(dir, [[0xef, 2048], [0x83, 4096]], 'disabled', {rootOffset: String(4096 * 512)});
    process.env.STUB_AGENT = 'restricted';
    assert.equal(withPath(bin, () => guestAgent(image)), 'restricted');
    for (const mode of ['garbage', 'fail']) {
      const other = setup(dir, [[0x83, 2048]], mode);
      assert.equal(withPath(other.bin, () => guestAgent(other.image)), 'unknown', mode);
      fs.rmSync(other.bin, {recursive: true});
    }
    const hung = setup(dir, [[0x83, 2048]], 'hang');
    assert.equal(withPath(hung.bin, () => guestAgent(hung.image, {timeoutMs: 300})), 'unknown');
    fs.rmSync(hung.bin, {recursive: true});
    const absent = setup(dir, [[0x83, 2048]], 'disabled', {stub: false});
    assert.equal(withPath(absent.bin, () => guestAgent(absent.image)), 'unknown');
    assert.equal(guestAgent(path.join(dir, 'missing.raw')), 'unknown');
  });
});
