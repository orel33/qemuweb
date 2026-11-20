'use strict';

// scripts/prepare/lib (common.sh, guest-scripts.sh): the proxy of the Alpine and OpenWrt build VMs, the
// check made before they start, and the failure patterns of their serial logs. The libraries are copied
// into a temporary project root, curl and getent are stubs in PATH: no network, no QEMU, no real image.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const PREPARE = path.join(__dirname, '..', '..', 'scripts', 'prepare');

// The tail of the serial log of a real Alpine build behind the CREMI proxy, without the proxy given to the VM.
const ALPINE_CREMI_FAILURE = [
  ' * Starting busybox crond ...',
  ' [ ok ]',
  '',
  ' Proxy',
  '-------',
  '',
  ' APK Mirror',
  '------------',
  "wget: can't connect to remote host (172.105.78.12): Connection refused",
  'Warning! No mirror found',
  '',
  ' User',
  '------',
  '',
  ' Disk & Install',
  '----------------',
  'ERROR: unable to select packages:',
  '  syslinux (no such package):',
  '    required by: world[syslinux]',
  'QEMUNET_ALPINE_STATUS_1',
  ''
].join('\r\n');

// A plausible successful Alpine build: the normal lines of the boot, setup-alpine, apk and the end marker.
const ALPINE_SUCCESS = [
  'OpenRC 0.55 is starting up Linux 6.12.0-lts (x86_64)',
  ' * Starting busybox crond ...',
  ' [ ok ]',
  'Welcome to Alpine Linux 3.24',
  'localhost login: root',
  'QEMUNET_ALPINE_PHASE_SETUP',
  ' Proxy',
  '-------',
  ' APK Mirror',
  '------------',
  'Added mirror dl-cdn.alpinelinux.org',
  'Updating repository indexes... done.',
  ' User',
  '------',
  ' Disk & Install',
  '----------------',
  'Installing system on /dev/vda3:',
  '(1/22) Installing alpine-baselayout-data (3.7.0-r0)',
  'QEMUNET_ALPINE_PHASE_TOOLS',
  '(1/20) Installing iproute2 (6.12.0-r0)',
  'OK: 105 MiB in 120 packages',
  'QEMUNET_ALPINE_PHASE_FINISH',
  'QEMUNET_ALPINE_PREPARED',
  'QEMUNET_ALPINE_STATUS_0',
  ''
].join('\r\n');

// Plausible, not recorded from a real OpenWrt failure: apk cannot fetch the package index.
const OPENWRT_APK_FAILURE = [
  'root@OpenWrt:~# sh /tmp/qemuweb-prepare.sh; status=$?; echo QEMUWEB_OPENWRT_STATUS_$status',
  'QEMUWEB_OPENWRT_PHASE_SYSTEM',
  'QEMUWEB_OPENWRT_PHASE_APK',
  'fetch https://downloads.openwrt.org/releases/25.12.6/packages/x86_64/base/packages.adb',
  'ERROR: https://downloads.openwrt.org/releases/25.12.6/packages/x86_64/base/packages.adb: Network error (check Internet connection and firewall)',
  'OpenWrt preparation: apk could not install tcpdump and nano from the package feeds (check the proxy)',
  'QEMUWEB_OPENWRT_STATUS_1',
  ''
].join('\r\n');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-prepare-network-'));
  fs.mkdirSync(path.join(root, 'scripts', 'prepare', 'resources'), {recursive: true});
  fs.cpSync(path.join(PREPARE, 'lib'), path.join(root, 'scripts', 'prepare', 'lib'), {recursive: true});
  fs.copyFileSync(path.join(PREPARE, 'resources', 'guest-start.sh'), path.join(root, 'scripts', 'prepare', 'resources', 'guest-start.sh'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // curl: records its arguments in curl.args; CURL_STUB_FAIL makes it print that text on stderr and fail.
  fs.writeFileSync(path.join(bin, 'curl'), [
    '#!/bin/sh',
    'echo "$*" >> "$STUB_DIR/curl.args"',
    'if [ -n "${CURL_STUB_FAIL:-}" ]; then echo "$CURL_STUB_FAIL" >&2; exit 22; fi',
    'exit 0',
    ''
  ].join('\n'), {mode: 0o755});
  // getent: the proxy name "proxy" has the IPv4 address 192.0.2.7 and the IPv6 address 2001:db8::42.
  fs.writeFileSync(path.join(bin, 'getent'), [
    '#!/bin/sh',
    'case "$1" in',
    '  ahostsv4) echo "192.0.2.7 STREAM proxy" ;;',
    '  ahostsv6) echo "2001:db8::42 STREAM proxy" ;;',
    'esac',
    ''
  ].join('\n'), {mode: 0o755});
  return root;
}

function withRoot(body) {
  const root = makeRoot();
  try { body(root); } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

// Run a bash snippet after sourcing the libraries, with the stubs first in PATH and no proxy variable.
function bash(root, snippet, env = {}) {
  const clean = {...process.env};
  for (const name of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) delete clean[name];
  const lib = path.join(root, 'scripts', 'prepare', 'lib');
  const result = spawnSync('bash', ['-c', `source ${lib}/common.sh; source ${lib}/guest-scripts.sh; ${snippet}`], {
    encoding: 'utf8',
    env: {...clean, ...env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, STUB_DIR: root, COLUMNS: '120'}
  });
  return {status: result.status, out: result.stdout, err: result.stderr};
}

// The text of a guest script for the given proxy (empty: none).
function guestScript(root, kind, proxy, env = {}) {
  const file = path.join(root, `${kind}.sh`);
  const result = bash(root, `PROXY_URL="$PROXY_IN"; ${kind}_guest_script ${file}`, {...env, PROXY_IN: proxy});
  assert.equal(result.status, 0, result.err);
  return fs.readFileSync(file, 'utf8');
}

function syntaxOk(root, text) {
  const file = path.join(root, 'syntax.sh');
  fs.writeFileSync(file, text);
  const result = spawnSync('sh', ['-n', file], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
}

function indexOfLine(text, needle) {
  const index = text.split('\n').findIndex(line => line.includes(needle));
  assert.notEqual(index, -1, `missing line: ${needle}`);
  return index;
}

// --- Alpine guest script ---------------------------------------------------------------------------------

test('Alpine script with a proxy: PROXYOPTS and exports with the address the VM sees, before setup-alpine and apk', () => {
  withRoot(root => {
    const script = guestScript(root, 'alpine', 'http://proxy:3128/');
    const url = 'http://192.0.2.7:3128/'; // the name is resolved on the host: the VM has no search domain
    assert.match(script, new RegExp(`^PROXYOPTS='${url}'$`, 'm'));
    assert.match(script, new RegExp(`^export http_proxy='${url}' https_proxy='${url}' ftp_proxy='${url}'$`, 'm'));
    assert.match(script, /^export no_proxy=localhost,127\.0\.0\.1$/m);
    assert.ok(indexOfLine(script, 'export http_proxy=') < indexOfLine(script, 'setup-alpine -e -f'));
    assert.ok(indexOfLine(script, 'export http_proxy=') < indexOfLine(script, 'apk --root'));
    assert.ok(indexOfLine(script, 'PROXYOPTS=') < indexOfLine(script, 'APKREPOSOPTS='), 'PROXYOPTS stays in the answers file');
    syntaxOk(root, script);
  });
});

test('Alpine script with an IPv6 proxy (-6): the address is in brackets', () => {
  withRoot(root => {
    const script = guestScript(root, 'alpine', 'http://proxy:3128/', {QEMUWEB_PREPARE_IPV6: '1'});
    assert.match(script, /^PROXYOPTS='http:\/\/\[2001:db8::42\]:3128\/'$/m);
    assert.match(script, /^export http_proxy='http:\/\/\[2001:db8::42\]:3128\/'/m);
  });
});

test('Alpine script with a proxy on the loopback of the host: 10.0.2.2', () => {
  withRoot(root => {
    const script = guestScript(root, 'alpine', 'http://localhost:3128');
    assert.match(script, /^PROXYOPTS='http:\/\/10\.0\.2\.2:3128'$/m);
    assert.match(script, /^export https_proxy='http:\/\/10\.0\.2\.2:3128'/m);
  });
});

test('Alpine script without a proxy: PROXYOPTS=none and no export', () => {
  withRoot(root => {
    const script = guestScript(root, 'alpine', '');
    assert.match(script, /^PROXYOPTS=none$/m);
    assert.doesNotMatch(script, /^export (http|https|ftp|no)_proxy/m);
    assert.doesNotMatch(script, /^QEMUNET_PROXY=/m);
    syntaxOk(root, script);
  });
});

test('Alpine script: a quote in the password cannot break the quoting', () => {
  withRoot(root => {
    const script = guestScript(root, 'alpine', "http://user:pa'ss@10.1.2.3:3128/");
    assert.match(script, /^PROXYOPTS='http:\/\/user:pa'\\''ss@10\.1\.2\.3:3128\/'$/m);
    syntaxOk(root, script);
  });
});

test('Alpine script: the proxy is removed from the finished image and absent from the text written there', () => {
  withRoot(root => {
    const proxy = 'http://user:secret@10.1.2.3:3128/';
    const script = guestScript(root, 'alpine', proxy);
    const lines = script.split('\n');
    const afterApk = lines.slice(indexOfLine(script, 'echo QEMUNET_ALPINE_PHASE_FINISH')).join('\n');
    assert.ok(!afterApk.includes('10.1.2.3') && !afterApk.includes('secret'), 'no proxy URL in the text meant for the image');
    const hook = fs.readFileSync(path.join(root, 'scripts', 'prepare', 'resources', 'guest-start.sh'), 'utf8');
    assert.ok(!hook.includes('10.1.2.3'));
    assert.match(script, /rm -f "\$target\/etc\/profile\.d\/proxy\.sh"/);
    assert.match(script, /grep -rIqF -- "\$QEMUNET_PROXY" "\$target\/etc"/);
    // the cleanup runs after apk and before the disk is unmounted
    assert.ok(indexOfLine(script, 'rm -f "$target/etc/profile.d/proxy.sh"') > indexOfLine(script, 'apk --root'));
    assert.ok(indexOfLine(script, 'rm -f "$target/etc/profile.d/proxy.sh"') < indexOfLine(script, 'umount "$target"'));
    // the other parts of the script keep their done marker
    assert.match(script, /^echo QEMUNET_ALPINE_PREPARED$/m);
  });
});

// --- OpenWrt guest script --------------------------------------------------------------------------------

test('OpenWrt script with a proxy: exports before apk, bounded apk and a clear failure message', () => {
  withRoot(root => {
    const script = guestScript(root, 'openwrt', 'http://proxy:3128/');
    const url = 'http://192.0.2.7:3128/';
    assert.match(script, new RegExp(`^export http_proxy='${url}' https_proxy='${url}' ftp_proxy='${url}'$`, 'm'));
    assert.ok(indexOfLine(script, 'export http_proxy=') < indexOfLine(script, '-U add tcpdump nano'));
    assert.match(script, /timeout 180 apk/);
    assert.match(script, /apk could not install tcpdump and nano from the package feeds \(check the proxy\)/);
    syntaxOk(root, script);
  });
});

test('OpenWrt script without a proxy: no export; the proxy is not in the text that follows apk', () => {
  withRoot(root => {
    const plain = guestScript(root, 'openwrt', '');
    assert.doesNotMatch(plain, /_proxy/);
    syntaxOk(root, plain);
    const script = guestScript(root, 'openwrt', 'http://user:secret@10.1.2.3:3128/');
    const after = script.split('\n').slice(indexOfLine(script, 'QEMUWEB_OPENWRT_PHASE_"CONFIG"')).join('\n');
    assert.ok(!after.includes('10.1.2.3') && !after.includes('secret') && !after.includes('_proxy'));
    assert.match(script, /^echo QEMUWEB_OPENWRT_PREPARED$/m);
  });
});

// --- Check before the VM starts --------------------------------------------------------------------------

test('check_build_urls: success through the proxy, over IPv4, with a small range', () => {
  withRoot(root => {
    const result = bash(root, "PROXY_URL=http://proxy:3128/; PROXY_SOURCE=--proxy; check_build_urls alpine 'the Alpine servers' https://a.example/x https://b.example/y");
    assert.equal(result.status, 0, result.err);
    assert.match(result.out, /Checking the Alpine servers \(proxy: http:\/\/proxy:3128\/ \(--proxy\), over IPv4\)/);
    const calls = fs.readFileSync(path.join(root, 'curl.args'), 'utf8').trim().split('\n');
    assert.equal(calls.length, 2);
    for (const call of calls) assert.match(call, /--proxy http:\/\/proxy:3128\/ -4 --range 0-1023 https:\/\/[ab]\.example/);
  });
});

test('check_build_urls: -6 checks over IPv6, no proxy means --noproxy', () => {
  withRoot(root => {
    bash(root, "PROXY_URL=http://proxy:3128/; PROXY_SOURCE=--proxy; check_build_urls alpine x https://a.example/x", {QEMUWEB_PREPARE_IPV6: '1'});
    bash(root, "PROXY_URL=''; check_build_urls alpine x https://b.example/y");
    const calls = fs.readFileSync(path.join(root, 'curl.args'), 'utf8').trim().split('\n');
    assert.match(calls[0], /-6 --range/);
    assert.match(calls[1], /--noproxy \* --range/);
    assert.doesNotMatch(calls[1], /--proxy /);
  });
});

test('check_build_urls: a failure names the URL and the curl error, hides the credentials and exits 1', () => {
  withRoot(root => {
    const result = bash(root, "PROXY_URL=http://user:secret@proxy:3128/; PROXY_SOURCE=--proxy; check_build_urls alpine 'the Alpine servers' https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/APKINDEX.tar.gz; echo not-reached",
      {CURL_STUB_FAIL: 'curl: (7) Failed to connect to proxy port 3128: Connection refused'});
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.out, /not-reached/);
    assert.match(result.err, /prepare\.sh: the Alpine servers is not reachable from this machine, so alpine cannot be built:/);
    assert.match(result.err, /^ {2}https:\/\/dl-cdn\.alpinelinux\.org\/alpine\/v3\.24\/main\/x86_64\/APKINDEX\.tar\.gz$/m);
    assert.match(result.err, /^ {2}curl: \(7\) Failed to connect to proxy port 3128: Connection refused$/m);
    assert.match(result.err, /Proxy in use: http:\/\/\*\*\*@proxy:3128\/ \(--proxy\)\./);
    assert.doesNotMatch(result.err + result.out, /secret/);
    assert.doesNotMatch(result.err, /403/);
  });
});

test('check_build_urls: a 403 of the proxy gets the IPv4/IPv6 hint', () => {
  withRoot(root => {
    const result = bash(root, "PROXY_URL=http://proxy:3128/; PROXY_SOURCE=--proxy; check_build_urls openwrt 'the OpenWrt package feeds' https://downloads.openwrt.org/x",
      {CURL_STUB_FAIL: 'curl: (56) CONNECT tunnel failed, response 403'});
    assert.equal(result.status, 1);
    assert.match(result.err, /The proxy answered 403 \(access denied\) over IPv4, the family the build VM uses/);
    assert.match(result.err, /retry with -6 if it accepts IPv6/);
  });
});

test('check_debian_mirrors keeps its own message', () => {
  withRoot(root => {
    const result = bash(root, 'PROXY_URL=http://proxy:3128/; PROXY_SOURCE=--proxy; check_debian_mirrors debian13-legacy', {CURL_STUB_FAIL: 'curl: (7) refused'});
    assert.equal(result.status, 1);
    assert.match(result.err, /prepare\.sh: the Debian mirror is not reachable from this machine, so debian13-legacy cannot be built:/);
    assert.match(result.err, /The build VM downloads Debian packages through the same network\./);
  });
});

// --- Failure patterns against serial logs ----------------------------------------------------------------

// watch_vm on a serial log that already holds LOG: the VM is a sleeping process (alive) or an exited one.
function watch(root, kind, log, {alive}) {
  const logFile = path.join(root, 'serial.log');
  fs.writeFileSync(logFile, log);
  const upper = kind.toUpperCase();
  const host = kind === 'alpine' ? 'dl-cdn.alpinelinux.org or mirrors.alpinelinux.org' : 'downloads.openwrt.org';
  const vm = alive ? 'sleep 30 & pid=$!' : 'true & pid=$!; wait $pid';
  return bash(root, `PROXY_URL=http://proxy:3128/; PROXY_SOURCE=--proxy; PREPARE_NETWORK_HOST='${host}'; ${vm}; ` +
    `rc=0; watch_vm '${kind} build' $pid ${logFile} "$${upper}_DONE" 1 300 ${upper}_FAILURES ${upper}_PHASES || rc=$?; ` +
    'kill $pid 2>/dev/null || true; echo "rc=$rc"');
}

test('the Alpine log of the CREMI failure is a failure, with the network hint', () => {
  withRoot(root => {
    const start = Date.now();
    const result = watch(root, 'alpine', ALPINE_CREMI_FAILURE, {alive: true});
    assert.ok(Date.now() - start < 10000, 'detected in the first pass of the loop');
    assert.match(result.out, /rc=1/);
    assert.match(result.err, /prepare\.sh: alpine build failed: the serial log shows an error: wget: can\.t connect to remote host/);
    assert.match(result.err, /unable to select packages/); // in the last lines shown
    assert.match(result.err, /the build VM cannot reach dl-cdn\.alpinelinux\.org or mirrors\.alpinelinux\.org: check the proxy \(--proxy URL, or -6 if the proxy only accepts IPv6\)/);
    assert.match(result.err, /Log directory: /);
  });
});

test('every Alpine failure string alone is detected', () => {
  withRoot(root => {
    for (const line of ["wget: can't connect to remote host (1.2.3.4): Connection refused", 'wget: download timed out', 'wget: bad address \'x\'',
      'wget: server returned error: HTTP/1.1 403 Forbidden', 'Warning! No mirror found', 'ERROR: unable to select packages:', 'QEMUNET_ALPINE_STATUS_12']) {
      const result = watch(root, 'alpine', `Booting\r\n${line}\r\n`, {alive: true});
      assert.match(result.out, /rc=1/, line);
    }
  });
});

test('a successful Alpine log is not a failure and ends the build', () => {
  withRoot(root => {
    const result = watch(root, 'alpine', ALPINE_SUCCESS, {alive: false});
    assert.match(result.out, /rc=0/);
    assert.match(result.out, /100%  Done/);
    assert.equal(result.err, '');
  });
});

test('the end marker is checked before the failures (a message after the marker is not a failure)', () => {
  withRoot(root => {
    const result = watch(root, 'alpine', ALPINE_SUCCESS + "wget: can't connect to remote host\r\n", {alive: false});
    assert.match(result.out, /rc=0/);
  });
});

test('an Alpine log without the end marker and without error is neither done nor failed while the VM runs', () => {
  withRoot(root => {
    const log = ALPINE_SUCCESS.replace('QEMUNET_ALPINE_PREPARED\r\n', '').replace('QEMUNET_ALPINE_STATUS_0\r\n', '');
    // the VM has exited without the marker: reported as a stop, not as a pattern
    const result = watch(root, 'alpine', log, {alive: false});
    assert.match(result.out, /rc=1/);
    assert.match(result.err, /the VM stopped before the end of the build/);
  });
});

test('an OpenWrt apk failure is detected, and so is the failure marker alone', () => {
  withRoot(root => {
    const result = watch(root, 'openwrt', OPENWRT_APK_FAILURE, {alive: true});
    assert.match(result.out, /rc=1/);
    assert.match(result.err, /the serial log shows an error: /);
    assert.match(result.err, /the build VM cannot reach downloads\.openwrt\.org: check the proxy/);
    const marker = watch(root, 'openwrt', 'boot\r\nQEMUWEB_OPENWRT_STATUS_1\r\n', {alive: true});
    assert.match(marker.out, /rc=1/);
    assert.match(marker.err, /QEMUWEB_OPENWRT_STATUS_\[1-9\]/);
  });
});

// Names of the failure patterns that match a serial log, as watch_vm normalises it (no escape sequence, no whitespace).
function matchingFailures(root, name, log) {
  const logFile = path.join(root, 'serial.log');
  fs.writeFileSync(logFile, log);
  const result = bash(root, `serial_strip < ${logFile} | tr -d ' \\t\\n' > ${root}/norm; ` +
    `for f in "\${${name}[@]}"; do if serial_has ${root}/norm "\${f// /}"; then echo "$f"; fi; done`);
  assert.equal(result.status, 0, result.err);
  return result.out.trim().split('\n').filter(Boolean);
}

test('OpenWrt: the script typed into the console (echoed in the log) matches no failure pattern', () => {
  withRoot(root => {
    for (const proxy of ['http://proxy:3128/', '']) {
      const script = guestScript(root, 'openwrt', proxy);
      // the console echoes every typed line, in the form the driver types it
      const echoed = script.split('\n').map(line => `printf '%s\\n' '${line}' >>/tmp/qemuweb-prepare.sh`).join('\r\n');
      const boot = 'Linux version 6.12\r\nPlease press Enter to activate this console.\r\nroot@OpenWrt:~# ';
      const run = '\r\nsh /tmp/qemuweb-prepare.sh; status=$?; echo QEMUWEB_OPENWRT_STATUS_$status\r\n';
      assert.deepEqual(matchingFailures(root, 'OPENWRT_FAILURES', boot + echoed + run), []);
    }
  });
});

test('OpenWrt: the apk error line alone is a failure, and a successful log ends the build', () => {
  withRoot(root => {
    const error = 'ERROR: https://downloads.openwrt.org/releases/25.12.6/packages/x86_64/base/packages.adb: Network error (check Internet connection and firewall)\r\n';
    assert.equal(matchingFailures(root, 'OPENWRT_FAILURES', 'fetch ...\r\n' + error).length, 1);
    const ok = 'QEMUWEB_OPENWRT_PHASE_SYSTEM\r\nQEMUWEB_OPENWRT_PHASE_APK\r\n(1/2) Installing tcpdump (4.99.5-r1)\r\n(2/2) Installing nano (8.3-r1)\r\nOK: 12 MiB in 80 packages\r\nQEMUWEB_OPENWRT_PHASE_CONFIG\r\nQEMUWEB_OPENWRT_PREPARED\r\nQEMUWEB_OPENWRT_STATUS_0\r\n';
    assert.deepEqual(matchingFailures(root, 'OPENWRT_FAILURES', ok), []);
    const result = watch(root, 'openwrt', ok, {alive: false});
    assert.match(result.out, /rc=0/);
    assert.match(result.out, /100%  Done/);
  });
});

test('Alpine: the successful log matches no failure pattern, the failing one matches several', () => {
  withRoot(root => {
    assert.deepEqual(matchingFailures(root, 'ALPINE_FAILURES', ALPINE_SUCCESS), []);
    assert.ok(matchingFailures(root, 'ALPINE_FAILURES', ALPINE_CREMI_FAILURE).length >= 4);
  });
});

test('failure patterns are valid, bounded and never use an open .*', () => {
  withRoot(root => {
    for (const name of ['ALPINE_FAILURES', 'OPENWRT_FAILURES', 'ALPINE_PHASES', 'OPENWRT_PHASES']) {
      const result = bash(root, `printf '%s\\n' "\${${name}[@]}"`);
      assert.equal(result.status, 0, result.err);
      for (const entry of result.out.trim().split('\n')) {
        const pattern = name.endsWith('PHASES') ? entry.split('@').slice(2).join('@') : entry.replace(/ /g, '');
        assert.doesNotMatch(pattern, /\.\*/, `${name}: ${entry}`);
        const grep = spawnSync('grep', ['-E', '-e', pattern], {input: '', encoding: 'utf8'});
        assert.notEqual(grep.status, 2, `${name}: invalid pattern ${entry}`);
      }
    }
    const done = bash(root, 'echo "$ALPINE_DONE $OPENWRT_DONE"');
    assert.equal(done.out.trim(), 'QEMUNET_ALPINE_PREPARED QEMUWEB_OPENWRT_STATUS_0');
  });
});

test('the Debian failure report keeps its hint when no network host is set', () => {
  withRoot(root => {
    const logFile = path.join(root, 'serial.log');
    fs.writeFileSync(logFile, 'Bad archive mirror\r\n');
    const result = bash(root, `PROXY_URL=''; sleep 30 & pid=$!; watch_vm 'Debian installer build' $pid ${logFile} "$DEBIAN_INSTALLER_DONE" 1 900 DEBIAN_INSTALLER_FAILURES DEBIAN_INSTALLER_PHASES || true; kill $pid 2>/dev/null || true`);
    assert.match(result.err, /The build VM needs the Debian mirror\. Proxy in use: none\./);
    assert.doesNotMatch(result.err, /cannot reach/);
  });
});
