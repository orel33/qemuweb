// LST01: the address the server listens on (--bind) and the one the local runner dials (--host): the literal rule
// (common/bind.js), the refusals and the warning at startup (server/options.js, server/listen.js), the runner's URL,
// the scripts that derive the runner host from --bind, and the plain-http registration command of /admin.
// No server, no runner, no network: functions, and the text of the scripts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {execFileSync, spawnSync} = require('node:child_process');
const cli = require('../../common/cli');
const {parseAddress, isLoopback, isWildcard, isLoopbackHostname, urlHost, runnerHost} = require('../../common/bind');
const {parseServerArguments, serverSpec} = require('../../server/options');
const {listenLine, listenWarning, bannerLines} = require('../../server/listen');
const {parseRunnerArguments} = require('../../runner/options');
const {load} = require('../../runner/local-identity');
const {serverUrls} = require('../../runner/remote-url');
const {connectHint, registerCommand} = require('../../server/routes/admin-runners');

const root = path.join(__dirname, '..', '..');
const script = name => fs.readFileSync(path.join(root, 'scripts', name), 'utf8');
const code = text => text.replace(/^\s*#.*$/gm, '');
const bash = command => execFileSync('bash', ['-c', `source ${root}/scripts/lib/runtime.sh; ${command}`], {encoding: 'utf8'}).trim();

test('an address is a literal: IPv4 or IPv6; a host name, nothing, a port, a mask or a zone id are refused', () => {
  for (const good of ['127.0.0.1', '::1', '0.0.0.0', '::', '192.168.0.101', 'fe80::1']) assert.equal(parseAddress(good), good, good);
  for (const bad of ['localhost', 'example.org', '', ' ', '192.168.0.101:3003', '[::1]', '192.168.0.0/24', '256.1.1.1', 'fe80::1%eth0', '1.2.3']) {
    assert.throws(() => parseAddress(bad), Error, JSON.stringify(bad));
  }
  assert.throws(() => parseAddress(undefined));
});

test('loopback, wildcard, URL host and the address the local runner dials', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopback(address), address);
  for (const address of ['0.0.0.0', '::', '192.168.0.101', 'fe80::1', '10.0.0.1']) assert.ok(!isLoopback(address), address);
  for (const address of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0']) assert.ok(isWildcard(address), address);
  for (const address of ['127.0.0.1', '::1', '192.168.0.101']) assert.ok(!isWildcard(address), address);
  assert.deepEqual(['127.0.0.1', '::1', '192.168.0.101'].map(urlHost), ['127.0.0.1', '[::1]', '192.168.0.101']);
  // A wildcard is reached on loopback, a specific address on itself.
  assert.deepEqual(['127.0.0.1', '0.0.0.0', '::', '192.168.0.101', '::1', 'fe80::1'].map(runnerHost), ['127.0.0.1', '127.0.0.1', '127.0.0.1', '192.168.0.101', '::1', 'fe80::1']);
  for (const name of ['localhost', '127.0.0.1', '127.9.9.9', '[::1]']) assert.ok(isLoopbackHostname(name), name);
  for (const name of ['192.168.0.101', 'example.org', '[fe80::1]', '127.0.0.1.example.org']) assert.ok(!isLoopbackHostname(name), name);
});

test('--bind: the default is loopback; every literal is accepted; the others are refused with a usage error', () => {
  const defaults = parseServerArguments([], {root});
  assert.equal(defaults.bind, '127.0.0.1');
  assert.ok(!defaults.given.has('--bind'));
  assert.equal(serverSpec(root).options.find(option => option.flag === '--bind').fallback, '127.0.0.1');
  for (const good of ['127.0.0.1', '::1', '0.0.0.0', '::', '192.168.0.101']) assert.equal(parseServerArguments(['--bind', good], {root}).bind, good, good);
  for (const bad of [['--bind'], ['--bind', ''], ['--bind', 'localhost'], ['--bind', 'prout'], ['--bind', '192.168.0.101:3003'], ['--bind', '192.168.0.0/24'], ['--bind', '::1%lo']]) {
    assert.throws(() => parseServerArguments(bad, {root}), cli.UsageError, bad.join(' '));
  }
});

test('--no-auth with an address that is not loopback is refused, whatever else is given', () => {
  for (const bind of ['0.0.0.0', '::', '192.168.0.101']) {
    for (const extra of [[], ['--trust-proxy', 'loopback'], ['--ephemeral'], ['--local-runner']]) {
      assert.throws(() => parseServerArguments(['--no-auth', '--bind', bind, ...extra], {root}), error => error instanceof cli.UsageError && /--no-auth cannot be used with --bind/.test(error.message), `${bind} ${extra.join(' ')}`);
    }
  }
  for (const bind of ['127.0.0.1', '127.0.0.2', '::1']) assert.equal(parseServerArguments(['--no-auth', '--bind', bind], {root}).authMode, 'off', bind);
  assert.equal(parseServerArguments(['--no-auth'], {root}).authMode, 'off', 'the default address is loopback');
});

test('--auth proxy with an address that is not loopback needs --trust-proxy; loopback and the password mode do not', () => {
  const proxy = ['--auth', 'proxy', '--proxy-key-file', '/etc/qemuweb/proxy-key'];
  assert.throws(() => parseServerArguments([...proxy, '--bind', '192.168.0.101'], {root}), error => error instanceof cli.UsageError && /--trust-proxy/.test(error.message));
  assert.throws(() => parseServerArguments([...proxy, '--bind', '0.0.0.0'], {root}), cli.UsageError);
  assert.equal(parseServerArguments([...proxy, '--bind', '192.168.0.101', '--trust-proxy', 'loopback'], {root}).bind, '192.168.0.101');
  assert.equal(parseServerArguments([...proxy, '--trust-proxy', 'true', '--bind', '::'], {root}).trustProxy, true);
  // The CREMI setup: loopback and Apache, unchanged.
  assert.equal(parseServerArguments([...proxy, '--trust-proxy', 'loopback'], {root}).bind, '127.0.0.1');
  assert.equal(parseServerArguments([...proxy], {root}).authMode, 'proxy');
  assert.equal(parseServerArguments(['--bind', '192.168.0.101'], {root}).authMode, 'password', 'the password mode is allowed on a LAN (with the warning)');
  assert.throws(() => parseServerArguments(['--auth', 'proxy', '--bind', '192.168.0.101'], {root}), /--proxy-key-file|--trust-proxy/);
});

test('the startup report: a line for the address, the warning of a non-loopback address, the real URLs in the banner', () => {
  const at = (bind, port = 3003) => ({bind, port});
  assert.equal(listenLine(at('127.0.0.1')), 'listen address  127.0.0.1:3003  (loopback)');
  assert.equal(listenLine(at('192.168.0.101')), 'listen address  192.168.0.101:3003  (network address)');
  assert.equal(listenLine(at('::')), 'listen address  [::]:3003  (all interfaces)');
  assert.deepEqual(listenWarning(at('127.0.0.1')), [], 'no warning for loopback');
  assert.deepEqual(listenWarning(at('::1')), []);
  for (const bind of ['192.168.0.101', '0.0.0.0', '::']) {
    const text = listenWarning(at(bind)).join(' ');
    assert.match(text, /clear text \(HTTP\)/, bind);
    assert.match(text, /passwords, the session cookie and the runner token travel unencrypted/, bind);
    assert.match(text, /trusted LAN/, bind);
    assert.match(text, /nginx or Apache that terminate TLS \(docs\/deployment\.md\)/, bind);
    assert.match(text, /HTTPS/, bind);
  }
  assert.match(listenWarning(at('0.0.0.0')).join(' '), /every network interface/);
  assert.deepEqual(bannerLines(at('127.0.0.1', 3002)), ['  Web interface      http://127.0.0.1:3002'], 'byte for byte the line of before');
  assert.deepEqual(bannerLines(at('192.168.0.101')), ['  Web interface      http://192.168.0.101:3003']);
  assert.deepEqual(bannerLines(at('::1')), ['  Web interface      http://[::1]:3003']);
  const wildcard = bannerLines(at('0.0.0.0'));
  assert.equal(wildcard[0], '  Web interface      http://127.0.0.1:3003', 'a wildcard shows the loopback URL');
  assert.match(wildcard[1], /on all interfaces .*http:\/\/<address of this machine>:3003/);
  // The Options block shows the row, with its source.
  const block = cli.formatOptions(cli.startupRows(serverSpec(root), parseServerArguments(['--bind', '192.168.0.101'], {root}), [])).join('\n');
  assert.match(block, /--bind +192\.168\.0\.101 +\(option\)/);
  assert.match(cli.formatOptions(cli.startupRows(serverSpec(root), defaultsOf(), [])).join('\n'), /--bind +127\.0\.0\.1 +\(default\)/);
  function defaultsOf() { return parseServerArguments([], {root}); }
});

test('the server code listens on --bind and prints the report; the startup check runs it', () => {
  const serve = code(fs.readFileSync(path.join(root, 'server', 'serve.js'), 'utf8'));
  assert.match(serve, /server\.listen\(port, bind, onListening\)/);
  assert.doesNotMatch(serve, /listen\([^)]*'127\.0\.0\.1'/);
  assert.match(serve, /bannerLines\(\{bind, port\}\)/);
  const checks = fs.readFileSync(path.join(root, 'server', 'startup-checks.js'), 'utf8');
  assert.match(checks, /cli\.pass\(listenLine\(settings\)\)/);
  assert.match(checks, /cli\.warning\(line\)/);
});

test('the cookie is Secure only when the request is HTTPS: over plain HTTP on a LAN it is not, and X-Forwarded-Proto is ignored without --trust-proxy', () => {
  const {sessionCookie} = require('../../server/auth/cookie');
  assert.doesNotMatch(sessionCookie('v', {maxAgeMs: 1000, secure: false}), /Secure/);
  assert.match(sessionCookie('v', {maxAgeMs: 1000, secure: true}), /; Secure/);
  const serve = code(fs.readFileSync(path.join(root, 'server', 'serve.js'), 'utf8'));
  assert.match(serve, /if \(settings\.trustProxy !== null\) app\.set\('trust proxy', settings\.trustProxy\)/, 'Express reads X-Forwarded-* only with --trust-proxy');
});

test('the local runner: --host defaults to loopback, takes a literal only, and is the host of the URL it dials', () => {
  assert.equal(parseRunnerArguments([], {root}).host, '127.0.0.1');
  assert.equal(parseRunnerArguments(['--host', '192.168.0.101'], {root}).host, '192.168.0.101');
  for (const bad of [['--host'], ['--host', ''], ['--host', 'prout'], ['--host', '192.168.0.101:3003'], ['--host', '10.0.0.0/8']]) {
    assert.throws(() => parseRunnerArguments(bad, {root}), cli.UsageError, bad.join(' '));
  }
  const dialed = argv => load(parseRunnerArguments(argv, {root})).urls;
  assert.equal(dialed(['--port', '3003']).connectUrl, 'ws://127.0.0.1:3003/runner/connect', 'unchanged by default');
  assert.equal(dialed(['--port', '3003', '--host', '192.168.0.101']).connectUrl, 'ws://192.168.0.101:3003/runner/connect');
  assert.equal(dialed(['--port', '3003', '--host', '::1']).connectUrl, 'ws://[::1]:3003/runner/connect');
  assert.equal(dialed(['--host', 'fe80::1']).connectUrl, 'ws://[fe80::1]:3002/runner/connect');
  assert.equal(load(parseRunnerArguments(['--host', '192.168.0.101'], {root})).derivedRows()[1][1], 'ws://192.168.0.101:3002/runner/connect');
  // Only the local form has --host: the remote runner uses --url.
  const {runSpec, registerSpec} = require('../../runner/options');
  for (const spec of [runSpec(root), registerSpec(root)]) assert.throws(() => cli.parseArguments(spec, ['--host', '192.168.0.101']), cli.UsageError);
});

test('a remote runner is unchanged: a plain http URL to another machine is refused without --insecure, loopback is not', () => {
  assert.throws(() => serverUrls('http://192.168.0.101:3003'), /Refusing the unencrypted URL/);
  const allowed = serverUrls('http://192.168.0.101:3003', {insecure: true});
  assert.deepEqual([allowed.plain, allowed.connectUrl, allowed.registerUrl], [true, 'ws://192.168.0.101:3003/runner/connect', 'http://192.168.0.101:3003/api/runner/register']);
  assert.equal(serverUrls('http://127.0.0.1:3003').plain, false);
});

test('/admin: the local runner hint names --host for a specific address; the registration command of a plain remote origin adds --insecure', () => {
  const hint = host => connectHint({runners: [], port: 3003, host, localRunner: true});
  assert.equal(hint('127.0.0.1'), './scripts/runner.sh --port 3003');
  assert.equal(hint(undefined), './scripts/runner.sh --port 3003');
  assert.equal(hint('192.168.0.101'), './scripts/runner.sh --port 3003 --host 192.168.0.101');
  assert.equal(registerCommand('http://192.168.0.101:3003', 'T'), './scripts/runner.sh register --url http://192.168.0.101:3003 --token T --insecure');
  assert.equal(registerCommand('http://127.0.0.1:3003', 'T'), './scripts/runner.sh register --url http://127.0.0.1:3003 --token T');
  assert.equal(registerCommand('https://qw.example.org', 'T'), './scripts/runner.sh register --url https://qw.example.org --token T');
});

test('the one rule of the runner host in shell: scripts/lib/runtime.sh asks common/bind.js', () => {
  assert.deepEqual(['127.0.0.1', '0.0.0.0', '::', '192.168.0.101', '::1'].map(address => bash(`local_runner_host ${address}`)), ['127.0.0.1', '127.0.0.1', '127.0.0.1', '192.168.0.101', '::1']);
  for (const bad of ['localhost', '', '192.168.0.101:3003']) {
    const result = spawnSync('bash', ['-c', `source ${root}/scripts/lib/runtime.sh; local_runner_host "$1"`, 'x', bad], {encoding: 'utf8'});
    assert.equal(result.status, 2, JSON.stringify(bad));
  }
  assert.equal(spawnSync('bash', ['-c', `source ${root}/scripts/lib/runtime.sh; is_loopback_address 127.0.0.1`]).status, 0);
  assert.equal(spawnSync('bash', ['-c', `source ${root}/scripts/lib/runtime.sh; is_loopback_address 192.168.0.101`]).status, 1);
  assert.equal(spawnSync('bash', ['-c', `source ${root}/scripts/lib/runtime.sh; is_loopback_address 0.0.0.0`]).status, 1);
  assert.equal(execFileSync('node', [path.join(root, 'common', 'bind.js'), 'runner-host', '10.1.2.3'], {encoding: 'utf8'}).trim(), '10.1.2.3');
});

test('start.sh passes --bind to the server and the derived host to the runner (only when it is not loopback); it probes that address', () => {
  const text = script('start.sh');
  assert.match(text, /--listen\|--bind\|--runtime/);
  assert.match(text, /--bind\) bind="\$1" ;;/);
  assert.match(text, /runner_host="\$\(local_runner_host "\$bind" 2>\/dev\/null\)" \|\| runner_host=127\.0\.0\.1/);
  assert.match(text, /\[\[ "\$runner_host" == 127\.0\.0\.1 \]\] \|\| host_args=\(--host "\$runner_host"\)/, 'by default the runner command line is the one of before');
  assert.match(text, /\/dev\/tcp\/\$runner_host\/\$port/);
  assert.match(text, /scripts\/runner\.sh --port "\$port" "\$\{host_args\[@\]\}" --token-file/);
  // The rule is not repeated here: no wildcard test in the script.
  assert.doesNotMatch(code(text), /0\.0\.0\.0|isWildcard/);
});

test('demo.sh: --listen and --bind in any order, the address validated by the one rule, the warning and the remote runner commands for a non-loopback address', () => {
  const text = script('demo.sh');
  assert.match(text, /Usage: \$0 \[--listen PORT\] \[--bind ADDRESS\]/);
  assert.match(text, /host="\$\(local_runner_host "\$bind"\)"/);
  assert.match(text, /if is_loopback_address "\$bind"; then loopback=1; fi/);
  assert.match(text, /--listen "\$port" --bind "\$bind" --runtime/);
  assert.match(text, /node scripts\/demo\.js load "http:\/\/\$url_host:\$port"/);
  assert.match(text, /WARNING: the demo listens on \$bind, in clear text \(HTTP\), with passwords equal to logins/);
  assert.match(text, /runner\.sh register --url http:\/\/\$remote:\$port --token TOKEN --insecure/);
  assert.match(text, /runner\.sh run --url http:\/\/\$remote:\$port --insecure/);
  const result = spawnSync('bash', [path.join(root, 'scripts', 'demo.sh'), '--bind', 'prout'], {encoding: 'utf8'});
  assert.equal(result.status, 2, 'a host name is refused before anything starts');
  assert.match(result.stderr, /Invalid address for --bind/);
});

test('status.sh, stop.sh and status.js pair a server and its runner by port, whatever the address', () => {
  for (const name of ['stop.sh', 'status.js']) assert.doesNotMatch(code(script(name)), /127\.0\.0\.1/, name);
  assert.match(script('status.js'), / --port \(\\d\+\)\( \|\$\)/);
});
