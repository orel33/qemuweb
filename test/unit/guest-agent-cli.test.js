'use strict';

// scripts/guest-agent.sh (scripts/guest-agent.js): the shell command that asks the guest agent of a running host,
// against a FAKE agent on a Unix socket in a temporary runtime directory. No QEMU, no VM, nothing outside the
// temporary directory. The replies are the ones of the GAG01 study (test/fixtures).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {run, parseArguments, socketPathProblem, COMMANDS} = require('../../scripts/guest-agent');
const {queryAgent, ALLOWED_COMMANDS} = require('../../runner/guest-agent');
const {parseGuestInterfaces, matchAddresses} = require('../../common/guest-addresses');
const fixtures = require('../fixtures/guest-agent-replies');
const {startFakeAgent} = require('../fixtures/fake-guest-agent');

const SESSION = '89abcdef';
const MAC = '52:54:00:aa:bb:01';
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

function makeRuntime(t) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-cli-'));
  t.after(() => fs.rmSync(runtime, {recursive: true, force: true}));
  return runtime;
}

// A host directory <runtime>/sessions/<session>/<id>/ with its host.json and, unless `mode` is null, a fake agent.
async function addHost(t, runtime, {id, name, mode = 'ok', value}) {
  const directory = path.join(runtime, 'sessions', SESSION, id);
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'host.json'), JSON.stringify({schemaVersion: 2, id, name, network: {interfaces: [{switchId: null, port: null, mac: MAC}]}}));
  return mode === null ? null : startFakeAgent(t, mode, value, {directory});
}

// Runs the command in this process with the real client and short deadlines.
async function cli(args, {query = queryAgent, timeoutMs = 1000, sleeps = []} = {}) {
  let out = '', err = '';
  const status = await run(args, {out: text => { out += text; }, err: text => { err += text; }, query, sleep: async ms => { sleeps.push(ms); }, timeoutMs});
  return {status, out, err};
}

test('ping prints ok and sends the handshake and guest-ping only', async t => {
  const runtime = makeRuntime(t);
  const agent = await addHost(t, runtime, {id: 'h-11111111', name: 'alice'});
  const result = await cli(['--runtime', runtime, 'ping']);
  assert.deepEqual(result, {status: 0, out: 'ok\n', err: ''});
  assert.deepEqual(agent.seen, ['guest-sync-delimited', 'guest-ping']);
});

test('interfaces prints the table and what the Graphic view shows, through the validation of the runner', async t => {
  const runtime = makeRuntime(t);
  await addHost(t, runtime, {id: 'h-11111111', name: 'alice'});
  const result = await cli(['--runtime', runtime, 'h-11111111', 'interfaces']);
  assert.equal(result.status, 0, result.err);
  const lines = result.out.split('\n');
  assert.match(lines[0], /^NIC +NAME +MAC +ADDRESS\/PREFIX$/);
  assert.ok(lines.some(line => /^-  +lo +00:00:00:00:00:00 +-$/.test(line)), result.out); // loopback and link-local are dropped
  assert.ok(lines.some(line => /^0  +eth0 +52:54:00:aa:bb:01 +10\.1\.2\.3\/24$/.test(line)), result.out);
  assert.ok(!result.out.includes('fe80'));
  assert.match(result.out, /The Graphic view shows:\n {2}NIC 0: 10\.1\.2\.3\/24\n$/);
  const json = JSON.parse((await cli(['--runtime', runtime, 'alice', 'interfaces', '--json'])).out);
  assert.deepEqual(json.shown, {0: ['10.1.2.3/24']});
  assert.deepEqual(json.interfaces[1], {nic: 0, name: 'eth0', mac: MAC, addresses: ['10.1.2.3/24']});
});

test('info lists what the agent reports as enabled and warns about a risky command', async t => {
  const runtime = makeRuntime(t);
  const commands = names => names.map(name => ({enabled: true, name, 'success-response': true}));
  await addHost(t, runtime, {id: 'h-11111111', name: 'alice', value: {version: '10.0.13', supported_commands: [...commands(['guest-ping', 'guest-info']), {enabled: false, name: 'guest-exec'}]}});
  const restricted = await cli(['--runtime', runtime, 'info']);
  assert.equal(restricted.out, 'guest agent version: 10.0.13\nenabled commands (2): guest-ping, guest-info\n');
  const open = makeRuntime(t);
  await addHost(t, open, {id: 'h-22222222', name: 'bob', value: {version: '10.0.13', supported_commands: commands(['guest-ping', 'guest-exec'])}});
  assert.match((await cli(['--runtime', open, 'info'])).out, /WARNING: this agent is NOT restricted, it allows guest-exec/);
});

test('a silent agent ends at the deadline with status 1 and no output', async t => {
  const runtime = makeRuntime(t);
  await addHost(t, runtime, {id: 'h-11111111', name: 'alice', mode: 'silent'});
  const result = await cli(['--runtime', runtime, 'ping'], {timeoutMs: 200});
  assert.equal(result.status, 1);
  assert.equal(result.out, '');
  assert.match(result.err, /did not answer/);
});

test('an endless reply is cut at the 64 KB cap', async t => {
  const runtime = makeRuntime(t);
  await addHost(t, runtime, {id: 'h-11111111', name: 'alice', mode: 'huge'});
  const result = await cli(['--runtime', runtime, 'interfaces']);
  assert.equal(result.status, 1);
  assert.equal(result.out, '');
  assert.match(result.err, /too long/);
});

test('malformed and refused replies are reported, never printed', async t => {
  for (const mode of ['malformed', 'error', 'wrong-sync']) {
    const runtime = makeRuntime(t);
    await addHost(t, runtime, {id: 'h-11111111', name: 'alice', mode});
    const result = await cli(['--runtime', runtime, 'ping']);
    assert.equal(result.status, 1, mode);
    assert.equal(result.out, '');
    assert.doesNotMatch(result.err, /this is not json|Command has been disabled/);
  }
});

test('hostile replies: only validated strings reach the terminal, no control character', async t => {
  const runtime = makeRuntime(t);
  await addHost(t, runtime, {id: 'h-11111111', name: 'alice', value: fixtures.hostile});
  const result = await cli(['--runtime', runtime, 'interfaces']);
  assert.equal(result.status, 0, result.err);
  assert.doesNotMatch(result.out, /[<>]|script|onerror|rm -rf|99999|999\.1|%eth0/);
  assert.doesNotMatch(result.out, CONTROL);
  const faces = parseGuestInterfaces(fixtures.hostile);
  for (const address of faces.flatMap(face => face.addresses)) assert.ok(result.out.includes(address), address);
  const shown = matchAddresses(faces, [{mac: MAC}]);
  assert.deepEqual(JSON.parse((await cli(['--runtime', runtime, '--json', 'interfaces'])).out).shown, shown);
  // A reply that is not a list, or a description with control characters in its fields.
  const text = makeRuntime(t);
  await addHost(t, text, {id: 'h-22222222', name: 'bob', value: '\u001b[31mred\u0007'});
  const bad = await cli(['--runtime', text, 'interfaces']);
  assert.equal(bad.status, 1);
  assert.doesNotMatch(bad.err + bad.out, CONTROL);
  const info = makeRuntime(t);
  await addHost(t, info, {id: 'h-33333333', name: 'eve', value: {version: '\u001b[2J1.0', supported_commands: [{enabled: true, name: 'guest-ping\u001b[0m'}, {enabled: true, name: 'guest-info'}]}});
  const described = await cli(['--runtime', info, 'info']);
  assert.equal(described.out, 'guest agent version: unknown\nenabled commands (1): guest-info\n');
});

test('host choice: name, id, unique prefix; several matches are listed and refused (status 2)', async t => {
  const runtime = makeRuntime(t);
  const first = await addHost(t, runtime, {id: 'h-aaaa1111', name: 'alice'});
  const second = await addHost(t, runtime, {id: 'h-aaaa2222', name: 'alina\u001b[31m'});
  await addHost(t, runtime, {id: 'h-bbbb3333', name: 'stopped', mode: null});
  const ambiguous = await cli(['--runtime', runtime, 'ping']);
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.err, /Several hosts.*\n {2}h-aaaa1111 {2}alice .*\n {2}h-aaaa2222 {2}alina\[31m /);
  assert.doesNotMatch(ambiguous.err, CONTROL);
  assert.equal((await cli(['--runtime', runtime, 'h-aaaa', 'ping'])).status, 2); // two ids with this prefix
  assert.equal((await cli(['--runtime', runtime, 'ali', 'ping'])).status, 2); // two names with this prefix
  assert.deepEqual([first.seen.length, second.seen.length], [0, 0]); // nothing was sent while ambiguous
  assert.equal((await cli(['--runtime', runtime, 'alice', 'ping'])).out, 'ok\n'); // exact name
  assert.equal((await cli(['--runtime', runtime, 'alic', 'ping'])).out, 'ok\n'); // unique prefix of a name
  assert.equal((await cli(['--runtime', runtime, 'h-aaaa2', 'ping'])).out, 'ok\n'); // unique prefix of an ID
  assert.equal((await cli(['--runtime', runtime, 'h-aaaa2222', 'ping'])).out, 'ok\n');
  assert.deepEqual([first.seen.length, second.seen.length], [4, 4]); // two pings each (handshake + command)
  const missing = await cli(['--runtime', runtime, 'zed', 'ping']);
  assert.equal(missing.status, 1);
  assert.match(missing.err, /No host "zed"/);
  const stopped = await cli(['--runtime', runtime, 'stopped', 'ping']);
  assert.equal(stopped.status, 1);
  assert.match(stopped.err, /has no qga\.sock/);
});

test('without HOST the only host with a socket is used; none is an error (1)', async t => {
  const runtime = makeRuntime(t);
  const none = await cli(['--runtime', runtime, 'ping']);
  assert.equal(none.status, 1);
  assert.match(none.err, /No running host/);
  await addHost(t, runtime, {id: 'h-11111111', name: 'alice'});
  await addHost(t, runtime, {id: 'h-22222222', name: 'stopped', mode: null});
  assert.equal((await cli(['--runtime', runtime, 'ping'])).out, 'ok\n');
});

test('no other command can be sent: unknown words, raw JSON and extra arguments are usage errors (2) and nothing is sent', async t => {
  const runtime = makeRuntime(t);
  const agent = await addHost(t, runtime, {id: 'h-11111111', name: 'alice'});
  assert.deepEqual(COMMANDS, {ping: 'guest-ping', info: 'guest-info', interfaces: 'guest-network-get-interfaces'});
  for (const name of Object.values(COMMANDS)) assert.ok(ALLOWED_COMMANDS.has(name));
  assert.equal(Object.keys(COMMANDS).length, ALLOWED_COMMANDS.size);
  const refused = [['exec'], ['guest-exec'], ['guest-ping'], ['shutdown'], ['ping;exec'], ['{"execute":"guest-exec"}'], ['PING'], ['constructor'], ['__proto__'], ['--execute', 'guest-exec', 'ping'], ['alice', 'bob', 'ping'], [], ['--port'], ['--port', '0', 'ping'], ['--port', '70000', 'ping'], ['--runtime']];
  for (const args of refused) {
    const result = await cli(['--runtime', runtime, ...args]);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.out, '');
    assert.match(result.err, /Usage:/);
  }
  assert.throws(() => parseArguments(['alice', 'guest-exec']), /only ping, info and interfaces/);
  assert.deepEqual(agent.seen, []);
});

test('a refused or closed connection is retried three times, one second apart, and said so', async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-cli-'));
  try {
    const directory = path.join(runtime, 'sessions', SESSION, 'h-11111111');
    fs.mkdirSync(directory, {recursive: true});
    // A socket file for discovery without a server: connections are refused by the fake query below.
    const server = require('node:net').createServer().listen(path.join(directory, 'qga.sock'));
    await new Promise(resolve => server.once('listening', resolve));
    try {
      let calls = 0;
      const flaky = failures => async () => { calls += 1; if (calls <= failures) throw Object.assign(new Error('connect ECONNREFUSED'), {code: 'ECONNREFUSED'}); return {}; };
      const sleeps = [];
      const ok = await cli(['--runtime', runtime, 'ping'], {query: flaky(2), sleeps});
      assert.equal(ok.status, 0);
      assert.deepEqual(sleeps, [1000, 1000]);
      assert.equal((ok.err.match(/retrying in 1 s/g) || []).length, 2);
      calls = 0;
      const failed = await cli(['--runtime', runtime, 'ping'], {query: flaky(5), sleeps: []});
      assert.equal(failed.status, 1);
      assert.equal(calls, 3);
      assert.match(failed.err, /nothing listens on the socket/);
      calls = 0;
      const timeout = await cli(['--runtime', runtime, 'ping'], {query: async () => { calls += 1; throw new Error('The guest agent did not answer.'); }});
      assert.equal(calls, 1); // a silent agent is not retried
      assert.equal(timeout.status, 1);
    } finally { server.close(); }
  } finally { fs.rmSync(runtime, {recursive: true, force: true}) }
});

test('a socket path that is too long gets the friendly runtime message', () => {
  assert.equal(socketPathProblem('/tmp/qw-x/3002', '/tmp/qw-x/3002/sessions/89abcdef/h-89abcdef/qga.sock'), null);
  const runtime = `/tmp/${'d'.repeat(76)}`; // 81 bytes: over the 65-byte budget, its qga.sock over 107
  const message = socketPathProblem(runtime, `${runtime}/sessions/${SESSION}/h-${SESSION}/qga.sock`);
  assert.match(message, /too long/);
  assert.match(message, /107/);
});

test('the shell wrapper runs it end to end: ping, usage error and exit codes', async t => {
  const runtime = makeRuntime(t);
  await addHost(t, runtime, {id: 'h-11111111', name: 'alice'});
  const script = path.join(__dirname, '..', '..', 'scripts', 'guest-agent.sh');
  const exec = args => new Promise(resolve => execFile('bash', [script, ...args], {encoding: 'utf8', timeout: 10000}, (error, stdout, stderr) => resolve({status: error ? error.code : 0, stdout, stderr})));
  assert.deepEqual(await exec(['--runtime', runtime, 'alice', 'ping']), {status: 0, stdout: 'ok\n', stderr: ''});
  const table = await exec(['--runtime', runtime, 'interfaces']);
  assert.equal(table.status, 0);
  assert.match(table.stdout, /NIC 0: 10\.1\.2\.3\/24/);
  assert.equal((await exec(['--runtime', runtime, 'exec'])).status, 2);
});
