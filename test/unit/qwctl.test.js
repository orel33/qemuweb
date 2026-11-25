// scripts/qwctl.js (scripts/qwctl.sh): the systemd services of a server and its runners. Everything happens in a temporary
// root, with fake sudo, systemctl, journalctl, getent and pgrep in PATH: the real ones are never called.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {run, createHost, helpText, OPTIONS, COMMANDS} = require('../../scripts/qwctl');
const units = require('../../scripts/lib/service-units');

const root = '/srv/qemuweb';
const uid = process.getuid() || 1000;
const RUNNER_JSON = {url: 'https://qw.example.org', runnerId: 'r-1a2b3c4d', authToken: 'a-secret-token', name: 'salle'};

const FAKES = {
  // Runs the command as the test's own account; install gets no owner (logged), and a directory of deny.txt cannot be entered by another account.
  sudo: `echo "sudo $*" >> "$LOG"
if [[ $1 == -u ]]; then shift 2; if [[ $1 == test && $2 == -x ]] && grep -qxF -- "$3" "$STATE/deny.txt" 2>/dev/null; then exit 1; fi; fi
if [[ $1 == install ]]; then
  words=(); while (( $# )); do case "$1" in -o|-g) shift 2 ;; *) words+=("$1"); shift ;; esac; done
  set -- "\${words[@]}"
fi
exec "$@"`,
  systemctl: `echo "systemctl $*" >> "$LOG"
case "$1" in
  is-active) cat "$STATE/$2.active" 2>/dev/null || echo inactive ;;
  is-enabled) echo enabled ;;
  show) [[ $4 == DropInPaths ]] && cat "$STATE/$2.dropins" 2>/dev/null; true ;;
esac`,
  journalctl: 'echo "journalctl $*" >> "$LOG"',
  getent: `case "$1 $2" in
  "passwd qemuweb") echo "qemuweb:x:${uid}:${uid}::/home/qemuweb:/bin/bash" ;;
  "passwd other") echo "other:x:54321:54321::/home/other:/bin/bash" ;;
  "passwd toor") echo "toor:x:0:0::/root:/bin/bash" ;;
  "group kvm") echo "kvm:x:993:" ;;
  *) exit 2 ;;
esac`,
  pgrep: 'echo 0'
};

function machine(t, {hostOptions = {}, overrides = {}} = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-ctl-'));
  t.after(() => fs.rmSync(scratch, {recursive: true, force: true}));
  const [prefix, bin, state, log] = ['root', 'bin', 'state', 'log'].map(name => path.join(scratch, name));
  for (const directory of [bin, state, ...['etc/systemd/system', 'var/lib', 'var/log', 'home/qemuweb'].map(item => path.join(prefix, item))]) fs.mkdirSync(directory, {recursive: true});
  for (const [name, body] of Object.entries(FAKES)) fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, {mode: 0o755});
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(bin, 'node'), '');
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, LOG: log, STATE: state};
  const at = file => prefix + file;
  const host = {...createHost({prefix, uid, username: 'qemuweb', sudoUser: null, env, nodeDirectories: [bin], ...hostOptions}), ...overrides};
  const self = {
    prefix, state, at,
    asked: [],
    answer: false,
    qwctl(line, extra = []) {
      const out = [];
      const err = [];
      const argv = [...line.split(' ').filter(Boolean), ...extra];
      const status = run(argv, {root, host, out: text => out.push(text), err: text => err.push(text), ask: question => { self.asked.push(question); return self.answer; }});
      return {status, out: out.join('\n'), err: err.join('\n')};
    },
    ok(line, extra) { const result = self.qwctl(line, extra); assert.equal(result.status, 0, `${line}: ${result.err}`); return result; },
    refused(line, pattern, {status, extra} = {}) {
      const before = self.snapshot();
      const result = self.qwctl(line, extra);
      assert.notEqual(result.status, 0, line);
      if (status) assert.equal(result.status, status, result.err);
      assert.match(result.err, pattern);
      assert.equal(self.snapshot(), before, `${line}: nothing is written`);
    },
    read: file => fs.readFileSync(at(file), 'utf8'),
    write(file, text) { fs.mkdirSync(path.dirname(at(file)), {recursive: true}); fs.writeFileSync(at(file), text); },
    exists: file => fs.existsSync(at(file)),
    log: () => fs.readFileSync(log, 'utf8'),
    clearLog: () => fs.writeFileSync(log, ''),
    active(unit, value = 'active') { fs.writeFileSync(path.join(state, `${unit}.active`), `${value}\n`); },
    // Every file of the temporary root with its content.
    snapshot: () => fs.readdirSync(prefix, {recursive: true}).sort().map(name => {
      const file = path.join(prefix, name);
      const stat = fs.lstatSync(file);
      return `${name} ${stat.isDirectory() ? (stat.mode & 0o777).toString(8) : fs.readFileSync(file, 'utf8')}`;
    }).join('\n')
  };
  return self;
}

const runnerFile = (m, file = '/home/qemuweb/.config/qemuweb-runner/runner.json', extra = {}) => m.write(file, JSON.stringify({...RUNNER_JSON, ...extra}));
const args = (m, name) => m.read(`/etc/qemuweb/${name}.args`).split('\n').find(line => line.startsWith('ARGS=')).slice(5);
const unit = (m, name) => m.read(`/etc/systemd/system/${name}.service`);
const SERVER_DEFAULTS = '--listen 3002 --local-runner --runtime /var/lib/qemuweb/server --users /etc/qemuweb/users.json --runners /etc/qemuweb/runners.json --logs /var/log/qemuweb';

test('install server: defaults, directories, options file, unit, enabled but not started', t => {
  const m = machine(t);
  const {out} = m.ok('install server --trust-proxy loopback');
  assert.equal(args(m, 'server'), `${SERVER_DEFAULTS} --trust-proxy loopback`);
  const text = unit(m, 'qemuweb-server');
  assert.ok(text.startsWith(`${units.MARKER}\n`));
  for (const line of ['User=qemuweb', 'WorkingDirectory=/srv/qemuweb', 'EnvironmentFile=/etc/qemuweb/server.args', 'ExecStart=/srv/qemuweb/scripts/server.sh $ARGS',
    'After=network.target', 'TimeoutStopSec=30', 'Restart=on-failure', 'WantedBy=multi-user.target']) assert.ok(text.split('\n').includes(line), line);
  assert.doesNotMatch(text, /@/);
  assert.equal(fs.statSync(m.at('/var/lib/qemuweb/server')).mode & 0o777, 0o700);
  for (const directory of ['/etc/qemuweb', '/var/log/qemuweb']) assert.equal(fs.statSync(m.at(directory)).mode & 0o777, 0o750, directory);
  const log = m.log();
  assert.match(log, /sudo systemctl daemon-reload[^]*sudo systemctl enable qemuweb-server/);
  assert.doesNotMatch(log, /systemctl start/);
  assert.match(out, /Start it with \.\/scripts\/qwctl\.sh start server/);
  m.clearLog();
  m.ok('install server --now');
  assert.match(m.log(), /sudo systemctl start qemuweb-server/);
});

test('the given options replace the defaults, paths are made absolute, flags and dashed values are kept', t => {
  const m = machine(t);
  m.ok('install server --listen 4000 --runtime /data/qw --users users/u.json --session-hours 6 --logout-url https://h/.openid?logout=https%3A%2F%2Fh%2Fbye');
  assert.equal(args(m, 'server'), `--listen 4000 --local-runner --runtime /data/qw --users ${path.resolve('users/u.json')} --runners /etc/qemuweb/runners.json --logs /var/log/qemuweb --session-hours 6 --logout-url https://h/.openid?logout=https%3A%2F%2Fh%2Fbye`);
});

test('options are validated with the table of the program before anything is written', t => {
  const m = machine(t);
  m.refused('install server --bogus', /Unknown option: --bogus/, {status: 2});
  m.refused('install server extra', /Unknown option: extra/, {status: 2});
  m.refused('install server -- --listen 3002', /Unknown option: --/, {status: 2});
  m.refused('install server --listen 0', /Invalid value for --listen/, {status: 2});
  m.refused('install server --listen', /Missing value for --listen/, {status: 2});
  m.refused('install server --auth proxy', /--auth proxy requires --proxy-key-file/, {status: 2});
  m.refused('install server --no-auth', /--no-auth is not accepted here/, {status: 2});
  m.refused('install server --ephemeral', /--ephemeral is not accepted here/, {status: 2});
  m.refused('install runner --exit-on-disconnect', /--exit-on-disconnect is not accepted here/, {status: 2});
  for (const option of ['--port 3003', '--host 127.0.0.1', '--token-file /x']) m.refused(`install runner ${option}`, /it comes from .* in server\.args/, {status: 2});
  m.refused('install runner --remote --url https://x', /stays in the runner file/, {status: 2});
  m.refused('install runner --remote --ca /x.pem', /stays in the runner file/, {status: 2});
  m.refused('install', /needs a target/, {status: 2});
  m.refused('frobnicate', /Unknown command/, {status: 2});
  m.refused('status all', /Unknown argument: all/, {status: 2});
  m.refused('start --force', /--force is not an option of start/, {status: 2});
  m.refused('install server --name x', /--name needs the target runner/, {status: 2});
  m.refused('install server --remote', /--remote needs the target runner/, {status: 2});
  for (const name of ['A', 'a_b', '-a', 'a'.repeat(17), '../x']) m.refused('install runner', /Invalid value for --name/, {status: 2, extra: ['--name', name]});
});

test('a value that systemd would split, unquote or expand is refused; % is kept as it is', t => {
  const m = machine(t);
  for (const value of ['/a b', '/a"b', "/a'b", '/a$b', '/a\\b', '/a`b', '/a\tb']) m.refused('install server', /systemd would split or change it/, {status: 2, extra: ['--logs', value]});
  assert.throws(() => units.renderUnit(units.service('server'), {root: '/srv/my qemuweb', sysuser: 'qemuweb'}), /The directory of QemuWeb/);
  assert.match(units.renderUnit(units.service('server'), {root: '/srv/100%', sysuser: 'qemuweb'}), /^ExecStart=\/srv\/100%%\/scripts\/server\.sh \$ARGS$/m);
});

test('the options file is never overwritten: other options are refused with the differences, the same ones accepted, an edited file is checked and kept', t => {
  const m = machine(t);
  m.ok('install server');
  m.refused('install server --listen 4000 --auth proxy --trust-proxy loopback --proxy-key-file /k',
    /server\.args exists and is never overwritten[^]*--listen 4000 +\(in the file: --listen 3002\)[^]*--auth proxy +\(in the file: absent\)[^]*Edit it/, {status: 1});
  const written = m.read('/etc/qemuweb/server.args');
  m.ok('install server --listen 3002 --local-runner --logs /var/log/qemuweb');
  assert.equal(m.read('/etc/qemuweb/server.args'), written);
  m.refused('install server', /contains a line break/, {status: 2, extra: ['--logout-url', 'https://a.example/x-\ny']});
  const edited = '; mine\n# a comment\nARGS=--listen 4001 --runtime /var/lib/qemuweb/server\n';
  m.write('/etc/qemuweb/server.args', edited);
  m.ok('install server');
  assert.equal(m.read('/etc/qemuweb/server.args'), edited);
  for (const [text, pattern] of [['ARGS=--listen nope\n', /server\.args: Invalid value for --listen/], ['ARGS=--no-auth\n', /server\.args: --no-auth is not accepted/],
    ['ARGS="--listen 3002"\n', /server\.args: .* contains/], ['ARGS=--listen $PORT\n', /contains/], ['ARGS=--listen 3002 \\\n--ephemeral\n', /exactly one line/],
    ['FOO=bar\nARGS=--listen 3002\n', /exactly one line/], ['', /exactly one line/], ['ARGS=--logs logs\n', /--logs must be an absolute path/]]) {
    m.write('/etc/qemuweb/server.args', text);
    m.refused('install server', pattern, {status: 1});
  }
});

test('--sysuser: the calling account, $SUDO_USER under sudo, mandatory for root, never root', t => {
  const m = machine(t, {hostOptions: {username: 'other', uid: 54321}});
  assert.match(m.ok('install server --dry-run').out, /account other/);
  m.refused('install server --sysuser root', /--sysuser root is refused/, {status: 2});
  m.refused('install server --sysuser toor', /user ID of root/, {status: 2});
  m.refused('install server --sysuser nobody-there', /does not exist on this machine/, {status: 1});
  m.refused('install server', /Invalid value for --sysuser/, {status: 2, extra: ['--sysuser', 'a b']});
  const direct = machine(t, {hostOptions: {username: 'root', uid: 0, sudoUser: null}});
  direct.refused('install server --dry-run', /--sysuser ACCOUNT is needed/, {status: 2});
  const asRoot = machine(t, {hostOptions: {username: 'root', uid: 0, sudoUser: 'root'}});
  asRoot.refused('install server --dry-run', /--sysuser ACCOUNT is needed/, {status: 2});
  const sudo = machine(t, {hostOptions: {username: 'root', uid: 0, sudoUser: 'other'}, overrides: {canEnter: () => true}});
  assert.match(sudo.ok('install server --dry-run').out, /account other/);
});

test('reinstalling under another account is refused, naming the account to give; --force changes it', t => {
  const m = machine(t);
  m.ok('install server');
  m.refused('install server --sysuser other', /give --sysuser qemuweb/, {status: 1});
  m.refused('install server --sysuser other --force', /sudo chown other \/etc\/qemuweb/, {status: 1});
  runnerFile(m);
  m.ok('install runner --remote');
  runnerFile(m, '/home/other/.config/qemuweb-runner/runner.json');
  m.write('/etc/qemuweb/runner.args', 'ARGS=--runner-config /home/other/.config/qemuweb-runner/runner.json --runtime /var/lib/qemuweb/runner\n');
  m.refused('install runner --remote --sysuser other', /give --sysuser qemuweb/, {status: 1});
  m.ok('install runner --remote --sysuser other --force');
  assert.match(unit(m, 'qemuweb-runner'), /^User=other$/m);
});

test('local runner: port, token file and host come from server.args, written in the unit', t => {
  const m = machine(t);
  m.refused('install runner', /The server is not installed/, {status: 1});
  m.ok('install server --listen 4000 --runtime /data/qw/server');
  m.ok('install runner --config /etc/qemuweb/config.json');
  assert.equal(args(m, 'runner'), '--runtime /var/lib/qemuweb/runner --config /etc/qemuweb/config.json');
  const text = unit(m, 'qemuweb-runner');
  for (const line of ['ExecStart=/srv/qemuweb/scripts/runner.sh --port 4000 --token-file /data/qw/server/local-runner.token $ARGS', 'After=qemuweb-server.service', 'Wants=qemuweb-server.service',
    'SupplementaryGroups=kvm', 'KillMode=mixed', 'TimeoutStopSec=60', 'Restart=on-failure', 'RestartPreventExitStatus=78', 'EnvironmentFile=/etc/qemuweb/runner.args']) assert.ok(text.split('\n').includes(line), line);
  // The server changes: the installed unit is flagged, and the next install follows.
  for (const [bind, host] of [['192.168.0.101', ' --host 192.168.0.101'], ['0.0.0.0', ''], ['::', '']]) {
    m.write('/etc/qemuweb/server.args', `ARGS=--listen 4001 --bind ${bind} --local-runner --runtime /data/qw/server\n`);
    assert.match(m.ok('status runner').out, /the unit differs from what this repository would generate/);
    m.ok('install runner');
    assert.match(unit(m, 'qemuweb-runner'), new RegExp(`runner\\.sh --port 4001${host} --token-file /data`));
    assert.doesNotMatch(m.ok('status runner').out, /Warning/);
    m.write('/etc/qemuweb/server.args', 'ARGS=--listen 5000 --local-runner --runtime /data/qw/server\n');
    m.ok('install runner');
  }
  m.write('/etc/qemuweb/server.args', 'ARGS=--listen 4001 --runtime /data/qw/server\n');
  m.refused('install runner', /has no --local-runner/, {status: 1});
});

test('local runner: the account of the server, its own runtime directory, only one', t => {
  const m = machine(t);
  m.ok('install server');
  m.refused('install runner --sysuser other', /must run under the account of the server.*--sysuser qemuweb/, {status: 1});
  m.refused('install runner --runtime /var/lib/qemuweb/server', /is the one of the server/, {status: 1});
  m.refused(`install runner --runtime /${'x'.repeat(60)}`, /is too long/, {status: 1});
  m.ok('install runner');
  m.refused('install runner --name second', /qemuweb-runner is already the local runner/, {status: 1});
});

test('remote runner: the runner file first, its name, its runtime wins, the limits reminder', t => {
  const m = machine(t);
  m.refused('install runner --remote --name salle', /runner\.sh register --url URL --token TOKEN --name salle --runner-config \/home\/qemuweb\/\.config\/qemuweb-runner\/salle\.json/, {status: 1});
  m.refused('install runner --remote --sysuser other', /sudo -u other \/srv\/qemuweb\/scripts\/runner\.sh register/, {status: 1});
  runnerFile(m);
  assert.doesNotMatch(m.ok('install runner --remote').out, /maxSessions|a-secret-token/);
  assert.equal(args(m, 'runner'), '--runner-config /home/qemuweb/.config/qemuweb-runner/runner.json --runtime /var/lib/qemuweb/runner');
  const text = unit(m, 'qemuweb-runner');
  for (const line of ['ExecStart=/srv/qemuweb/scripts/runner.sh run $ARGS', 'After=network-online.target', 'Wants=network-online.target', 'RestartPreventExitStatus=78']) assert.ok(text.split('\n').includes(line), line);

  const named = '/home/qemuweb/.config/qemuweb-runner/salle.json';
  runnerFile(m, named, {runtime: '/srv/runtime/salle'});
  m.refused('install runner --remote --name salle --runtime /elsewhere', /--runtime \/elsewhere contradicts the runtime of .*salle\.json \(\/srv\/runtime\/salle\)/, {status: 1});
  assert.match(m.ok('install runner --remote --name salle').out, /2 runners.*maxSessions/);
  assert.equal(args(m, 'runner-salle'), `--runner-config ${named}`);
  assert.equal(fs.statSync(m.at('/srv/runtime/salle')).mode & 0o777, 0o700);
  assert.ok(m.exists('/etc/systemd/system/qemuweb-runner-salle.service'));
  // A local one beside them.
  m.ok('install server');
  m.ok('install runner --name here');
  assert.equal(args(m, 'runner-here'), '--runtime /var/lib/qemuweb/runner-here');
});

test('a runner file or a runtime directory of another runner unit is refused, also one of a unit written by hand', t => {
  const m = machine(t);
  runnerFile(m);
  m.ok('install runner --remote');
  m.refused('install runner --remote --name two --runner-config /home/qemuweb/.config/qemuweb-runner/runner.json', /The runner file .* is already used by qemuweb-runner\./, {status: 1});
  runnerFile(m, '/home/qemuweb/.config/qemuweb-runner/two.json');
  m.refused('install runner --remote --name two --runtime /var/lib/qemuweb/runner', /runtime directory \/var\/lib\/qemuweb\/runner is already used by qemuweb-runner\./, {status: 1});
  m.write('/etc/systemd/system/qemuweb-runner-hand.service', '[Service]\nUser=qemuweb\nExecStart=/srv/qemuweb/scripts/runner.sh run --runtime /data/hand --runner-config /data/hand.json\n');
  m.refused('install runner --remote --name two --runtime /data/hand', /already used by qemuweb-runner-hand/, {status: 1});
});

test('an invalid runner file is refused without printing the token', t => {
  const m = machine(t);
  const file = '/home/qemuweb/.config/qemuweb-runner/runner.json';
  m.write(file, '{"authToken": a-secret-token}');
  assert.doesNotMatch(m.qwctl('install runner --remote').err, /secret/);
  m.refused('install runner --remote', /runner\.json is not valid JSON/, {status: 1});
  m.write(file, '{}');
  m.refused('install runner --remote', /"url" is missing/, {status: 1});
});

test('a unit of the other mode, or not generated by QemuWeb, is refused', t => {
  const m = machine(t);
  m.ok('install server');
  m.ok('install runner');
  runnerFile(m);
  m.refused('install runner --remote', /installed as a local runner: uninstall it first/, {status: 1});
  m.refused('install runner --remote --force', /installed as a local runner: uninstall it first/, {status: 1});
  // The units the CREMI copied by hand.
  const old = '[Service]\nUser=qemuweb\nExecStart=/usr/bin/node server/main.js --listen 3002 --local-runner --runtime /var/lib/qemuweb/server\n';
  m.write('/etc/systemd/system/qemuweb-server.service', old);
  m.refused('install server', /was not generated by QemuWeb: --force replaces it/, {status: 1});
  m.refused('install runner', /qemuweb-server was not generated by QemuWeb/, {status: 1});
  m.refused('uninstall server', /was not generated by QemuWeb: --force removes it/, {status: 1});
  assert.match(m.ok('status server').out, /not generated by QemuWeb/);
  assert.match(m.ok('install server --force').out, /-ExecStart=\/usr\/bin\/node[^]*\+ExecStart=\/srv\/qemuweb\/scripts\/server\.sh \$ARGS/);
  assert.ok(unit(m, 'qemuweb-server').startsWith(units.MARKER));
});

test('--dry-run changes nothing and calls no changing command', t => {
  const m = machine(t);
  const before = m.snapshot();
  const {out} = m.ok('install server --dry-run --now');
  assert.match(out, /ARGS=--listen 3002[^]*ExecStart=[^]*Dry run: nothing was changed/);
  assert.equal(m.snapshot(), before);
  m.ok('install server');
  const installed = m.snapshot();
  m.clearLog();
  m.ok('uninstall server --dry-run');
  assert.equal(m.snapshot(), installed);
  assert.doesNotMatch(m.log(), /systemctl (daemon-reload|enable|disable|start|stop)|sudo (install|rm)/);
});

test('reinstalling shows the difference, replaces the unit, and does not restart a running service', t => {
  const m = machine(t);
  m.ok('install server');
  assert.match(m.ok('install server').out, /\(unchanged\)/);
  m.write('/etc/systemd/system/qemuweb-server.service', unit(m, 'qemuweb-server').replace('TimeoutStopSec=30', 'TimeoutStopSec=5'));
  assert.match(m.ok('status').out, /differs from what this repository would generate/);
  m.active('qemuweb-server');
  m.clearLog();
  assert.match(m.ok('install server --now').out, /-TimeoutStopSec=5\n\+TimeoutStopSec=30[^]*is running.*restart server/);
  assert.doesNotMatch(m.log(), /systemctl (start|restart)/);
  assert.match(m.log(), /daemon-reload/);
  assert.doesNotMatch(m.ok('status').out, /Warning/);
});

test('status: the modes, a drop-in that overrides ExecStart, a bad options file', t => {
  const m = machine(t);
  m.ok('install server');
  m.ok('install runner');
  runnerFile(m, '/home/qemuweb/.config/qemuweb-runner/b.json');
  m.ok('install runner --remote --name b');
  const {out} = m.ok('status');
  assert.match(out, /^qemuweb-server +server[^]*^qemuweb-runner +local runner[^]*^qemuweb-runner-b +remote runner/m);
  assert.doesNotMatch(out, /Warning/);
  const dropIn = '/etc/systemd/system/qemuweb-server.service.d/override.conf';
  fs.writeFileSync(path.join(m.state, 'qemuweb-server.dropins'), `${dropIn}\n`);
  m.write(dropIn, '[Service]\nEnvironment=A=b\n');
  assert.doesNotMatch(m.ok('status').out, /Warning/);
  m.write(dropIn, '[Service]\nExecStart=\nExecStart=/usr/bin/node server/main.js\n');
  assert.match(m.ok('status server').out, /the drop-in .*override\.conf overrides ExecStart/);
  assert.match(m.ok('install runner').out, /Warning: .*override\.conf overrides ExecStart of qemuweb-server/);
  m.write('/etc/qemuweb/runner-b.args', 'ARGS=--bogus\n');
  assert.match(m.ok('status runner --name b').out, /runner-b\.args: Unknown option: --bogus/);
});

test('start, stop, restart, logs: every installed unit without a target, a confirmation before stopping a running runner', t => {
  const m = machine(t);
  m.refused('start', /No QemuWeb unit is installed/, {status: 1});
  m.ok('install server');
  m.ok('install runner');
  m.refused('start runner --name x', /qemuweb-runner-x is not installed/, {status: 1});
  m.clearLog();
  m.ok('start');
  assert.match(m.log(), /sudo systemctl start qemuweb-server qemuweb-runner\n/);
  m.ok('stop');
  assert.deepEqual(m.asked, [], 'the runner does not run');
  m.active('qemuweb-runner');
  m.clearLog();
  m.refused('stop', /Cancelled/, {status: 1});
  m.refused('restart runner', /Cancelled/, {status: 1});
  m.refused('uninstall runner', /Cancelled/, {status: 1});
  assert.equal(m.asked.length, 3);
  assert.doesNotMatch(m.log(), /sudo systemctl/);
  m.ok('restart server');
  m.ok('stop -y');
  assert.equal(m.asked.length, 3, 'neither the server alone nor -y asks');
  assert.match(m.log(), /sudo systemctl restart qemuweb-server\n[^]*sudo systemctl stop qemuweb-server qemuweb-runner\n/);
  m.answer = true;
  m.ok('restart runner');
  m.clearLog();
  m.ok('logs 5');
  m.ok('logs runner');
  assert.match(m.log(), /journalctl -u qemuweb-server -n 5 [^]*journalctl -u qemuweb-runner -n 5 [^]*journalctl -u qemuweb-runner -n 20 /);
});

test('start, restart and install --now reset a unit in the failed state first, and only that one', t => {
  const m = machine(t);
  m.ok('install server');
  m.ok('install runner');
  m.active('qemuweb-runner', 'failed');
  for (const command of ['start', 'restart']) {
    m.clearLog();
    m.ok(command);
    assert.match(m.log(), new RegExp(`sudo systemctl reset-failed qemuweb-runner\\n[^]*sudo systemctl ${command} `));
  }
  m.clearLog();
  m.ok('install runner --now');
  assert.match(m.log(), /reset-failed qemuweb-runner\n[^]*sudo systemctl start qemuweb-runner/);
  m.clearLog();
  m.ok('start server');
  m.ok('stop');
  assert.doesNotMatch(m.log(), /reset-failed/);
});

test('uninstall stops, disables and removes the unit only', t => {
  const m = machine(t);
  m.ok('install server');
  m.write('/var/lib/qemuweb/server/bindings.json', '{}');
  m.write('/etc/qemuweb/users.json', '{}');
  m.clearLog();
  m.ok('uninstall server');
  assert.equal(m.exists('/etc/systemd/system/qemuweb-server.service'), false);
  assert.match(m.log(), /systemctl disable --now qemuweb-server[^]*daemon-reload/);
  for (const file of ['/etc/qemuweb/server.args', '/var/lib/qemuweb/server/bindings.json', '/etc/qemuweb/users.json']) assert.ok(m.exists(file), file);
  m.refused('uninstall server', /qemuweb-server is not installed/, {status: 1});
  m.refused('uninstall', /needs a target/, {status: 2});
});

test('two accounts on one machine: shared parents are root 0755, a directory closed to the account is refused', t => {
  // The directories of the test belong to this process: the owner of those made for root is faked.
  const rootOwned = new Set(['/var/lib', '/var/lib/qemuweb', '/etc', '/var', '/var/log', '/', '/etc/qemuweb']);
  const made = [];
  const m = machine(t);
  const host = createHost({prefix: m.prefix, uid, username: 'qemuweb', env: {...process.env, PATH: `${path.join(m.prefix, '..', 'bin')}:${process.env.PATH}`, LOG: path.join(m.prefix, '..', 'log'), STATE: m.state}, nodeDirectories: []});
  const faked = {...host, owner: file => (rootOwned.has(file) ? 0 : host.owner(file)), makeDirectory(directory, mode, owner) { made.push([directory, mode, owner.name]); host.makeDirectory(directory, mode, owner); }};
  const call = line => {
    const err = [];
    const status = run(line.split(' '), {root, host: faked, out: () => {}, err: text => err.push(text), ask: () => false});
    return {status, err: err.join('\n')};
  };
  // A runner first: /etc/qemuweb and /var/lib/qemuweb stay root's.
  runnerFile(m, '/home/other/.config/qemuweb-runner/test.json');
  assert.deepEqual(call('install runner --remote --name test --sysuser other'), {status: 0, err: ''});
  assert.deepEqual(made, [['/var/lib/qemuweb', '0755', 'root'], ['/var/lib/qemuweb/runner-test', '0700', 'other'], ['/etc/qemuweb', '0755', 'root']]);
  // Then the server takes /etc/qemuweb over from root.
  made.length = 0;
  assert.deepEqual(call('install server'), {status: 0, err: ''});
  assert.deepEqual(made.sort(), [['/etc/qemuweb', '0750', 'qemuweb'], ['/var/lib/qemuweb/server', '0700', 'qemuweb'], ['/var/log/qemuweb', '0750', 'qemuweb']], 'in any order');
  // An /etc/qemuweb of a third account is refused for the server.
  rootOwned.delete('/etc/qemuweb');
  const third = {...faked, owner: file => (file === '/etc/qemuweb' ? 777 : faked.owner(file))};
  const err = [];
  assert.equal(run(['install', 'server'], {root, host: third, out: () => {}, err: text => err.push(text)}), 1);
  assert.match(err.join('\n'), /sudo chown qemuweb \/etc\/qemuweb/);
  // A closed ancestor (0750 of another account) is refused before anything is written.
  runnerFile(m, '/home/other/.config/qemuweb-runner/closed.json');
  fs.writeFileSync(path.join(m.state, 'deny.txt'), `${m.at('/var/lib/qemuweb')}\n`);
  const before = m.snapshot();
  const refused = call('install runner --remote --name closed --sysuser other');
  assert.equal(refused.status, 1);
  assert.match(refused.err, /other cannot enter \/var\/lib\/qemuweb, which is above its files: sudo chmod o\+x \/var\/lib\/qemuweb/);
  assert.equal(m.snapshot(), before);
});

test('an installation with existing directories of its own account (the CREMI, 0750) leaves them as they are', t => {
  const m = machine(t);
  for (const directory of ['/var/lib/qemuweb', '/etc/qemuweb', '/var/log/qemuweb']) fs.mkdirSync(m.at(directory), {mode: 0o750});
  for (const directory of ['/var/lib/qemuweb/server', '/var/lib/qemuweb/runner']) fs.mkdirSync(m.at(directory), {mode: 0o700});
  m.write('/var/lib/qemuweb/server/bindings.json', 'kept');
  m.ok('install server');
  m.ok('install runner');
  assert.doesNotMatch(m.log(), /sudo install -d/);
  assert.equal(m.read('/var/lib/qemuweb/server/bindings.json'), 'kept');
  assert.equal(fs.statSync(m.at('/var/lib/qemuweb')).mode & 0o777, 0o750);
});

test('a parent inside a directory of the account belongs to the account', t => {
  const m = machine(t);
  m.ok('install server --runtime /home/qemuweb/a/b');
  assert.match(m.log(), new RegExp(`install -d -m 0750 -o ${uid} -g ${uid} .*/home/qemuweb/a\n`));
  assert.match(m.log(), new RegExp(`install -d -m 0700 -o ${uid} -g ${uid} .*/home/qemuweb/a/b\n`));
});

test('--help lists every command and option; docs/reference.md repeats the options word for word', () => {
  const text = helpText();
  for (const command of COMMANDS) assert.ok(text.includes(command), command);
  const reference = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'reference.md'), 'utf8').replace(/`/g, '');
  for (const {flag, metavar, commands, description} of OPTIONS) {
    assert.ok(text.includes(description), flag);
    const row = `| ${metavar ? `${flag} ${metavar}` : flag} | ${commands.length === COMMANDS.length ? 'every command' : commands.join(', ')} | ${description} |`;
    assert.ok(reference.includes(row), row);
  }
  for (const argv of [['--help'], ['-h'], [], ['install', 'server', '--bogus', '--help']]) assert.equal(run(argv, {host: null, out: () => {}}), 0);
});

test('without the test prefix a host uses the real paths', () => {
  assert.equal(createHost().at('/etc/qemuweb'), '/etc/qemuweb');
});
