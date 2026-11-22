// The runner side of the local runner: runner/remote.js with a token that is read again at every attempt (the file of
// runner/local-identity.js), against the real gateway of the server (server/remote-gateway.js) on a loopback port. A
// missing file or a server that is not there is a retry; only a 401 is fatal (the runner then exits with status 78,
// runner/main.js, which the integration test check-runner-manual covers). No runner process and no QEMU.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {once} = require('node:events');
const {createRemoteGateway} = require('../../server/remote-gateway');
const {startLocalRunner} = require('../../server/local-runner-token');
const {RunnerRegistry} = require('../../server/runner-registry');
const {createRunnerStore} = require('../../server/runner-store');
const {startRemote} = require('../../runner/remote');
const {load} = require('../../runner/local-identity');
const {runnerSpec, parseRunnerArguments} = require('../../runner/options');
const {tokenFilePath} = require('../../common/local-token');
const {serverRuntime, localRunnerRuntime} = require('../../common/runtime-dir');

const root = path.join(__dirname, '..', '..');

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-link-'));
  const registry = new RunnerRegistry();
  const store = createRunnerStore(path.join(dir, 'runners.json'));
  const server = http.createServer((_req, res) => res.end('web'));
  const serverDir = path.join(dir, 'server');
  const localRunner = startLocalRunner({runtime: serverDir, store, audit: {record() {}}, log: {log() {}, warn() {}}});
  const gateway = createRemoteGateway({server, registry, store, localRunner});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const links = [];
  t.after(() => {
    for (const link of links) link.stop();
    gateway.close();
    server.close();
    server.closeAllConnections();
    fs.rmSync(dir, {recursive: true, force: true});
  });
  const port = server.address().port;
  const tokenFile = localRunner.file;
  const options = {port, tokenFile};
  const identity = load(options);
  // The runner's side, with retries shortened.
  const dial = (extra = {}) => {
    const events = {reports: [], fatal: [], connections: [], lost: 0};
    const link = startRemote({url: identity.urls.connectUrl, runnerId: identity.runnerId, authToken: identity.readToken, delayFor: () => 30,
      report: (state, message) => events.reports.push([state, message]), fatal: message => events.fatal.push(message),
      onConnection: connection => events.connections.push(connection), onLost: () => { events.lost++; }, ...extra});
    links.push(link);
    return {link, events};
  };
  const waitFor = async (label, condition, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error(`Timed out waiting for ${label}`);
  };
  return {dir, registry, store, tokenFile, dial, waitFor, serverDir, identity, port, server, gateway};
}

test('the local runner connects as "local" with the token of the file', async t => {
  const {dial, registry, waitFor} = await setup(t);
  const {events} = dial();
  await waitFor('connected', () => events.connections.length === 1);
  assert.equal(registry.get('local').state, 'starting');
  assert.deepEqual(events.reports.at(-1), ['connected', 'Connected to the server.']);
});

test('a missing token file is a wait (reported, no fatal error); once it exists the runner connects', async t => {
  const {dial, tokenFile, waitFor} = await setup(t);
  const token = fs.readFileSync(tokenFile, 'utf8');
  fs.rmSync(tokenFile);
  const {events} = dial();
  await waitFor('the waiting report', () => events.reports.some(([state, message]) => state === 'token' && /does not exist/.test(message)));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(events.fatal, [], 'never fatal');
  assert.equal(events.connections.length, 0);
  fs.writeFileSync(tokenFile, token, {mode: 0o600});
  await waitFor('connected', () => events.connections.length === 1);
});

test('the file is read again at every attempt: a rotation needs no restart of the runner', async t => {
  const {identity, tokenFile} = await setup(t);
  const first = identity.readToken();
  fs.writeFileSync(tokenFile, `${'n'.repeat(43)}\n`, {mode: 0o600});
  assert.equal(identity.readToken(), 'n'.repeat(43));
  assert.notEqual(identity.readToken(), first);
  fs.rmSync(tokenFile);
  assert.throws(() => identity.readToken(), /does not exist/);
});

test('a 401 with a token that changed since the attempt (a server restart wrote a new file) is retried, not fatal', async t => {
  const {dial, waitFor, tokenFile} = await setup(t);
  const good = fs.readFileSync(tokenFile, 'utf8').trim();
  let calls = 0;
  const {events} = dial({authToken: () => (++calls === 1 ? 'b'.repeat(43) : good)});
  await waitFor('connected with the new token', () => events.connections.length === 1);
  assert.deepEqual(events.fatal, []);
  assert.ok(events.reports.some(([state, message]) => state === 'refused' && /token changed/.test(message)));
});

test('a refusal (401: wrong token, revoked, forgotten) is fatal, with the given message; nothing is retried afterwards', async t => {
  const {dial, store, waitFor, tokenFile} = await setup(t);
  store.change('local', {revoked: true});
  const revoked = dial({refusal: 'revoked!'});
  await waitFor('revoked', () => revoked.events.fatal.length === 1);
  assert.deepEqual(revoked.events.fatal, ['revoked!']);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(revoked.events.fatal.length, 1, 'no retry after a refusal');
  store.change('local', {revoked: false});
  const wrong = dial({authToken: () => 'w'.repeat(43), refusal: 'wrong!'});
  await waitFor('wrong token', () => wrong.events.fatal.length === 1);
  assert.deepEqual(wrong.events.fatal, ['wrong!']);
  store.remove('local');
  const forgotten = dial({refusal: 'forgotten!'});
  await waitFor('forgotten', () => forgotten.events.fatal.length === 1);
  assert.ok(fs.existsSync(tokenFile));
});

test('a server that is not there (yet) is a retry, not a fatal error', async t => {
  const {dial, waitFor, server, gateway} = await setup(t);
  gateway.close();
  server.close();
  server.closeAllConnections();
  const {events} = dial();
  await waitFor('a waiting report', () => events.reports.some(([state, message]) => state === 'waiting' && /Cannot reach the server/.test(message)));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(events.fatal, []);
});

test('the connection is lost: onLost runs before the retry (--exit-on-disconnect stops there)', async t => {
  const {dial, waitFor, registry} = await setup(t);
  let link;
  const {events, link: started} = dial({onLost: () => { link.stop(); }});
  link = started;
  await waitFor('connected', () => events.connections.length === 1);
  const lost = once(registry, 'lost');
  registry.get('local').client.close();
  await lost;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(events.connections.length, 1, 'stopped by onLost: no new connection');
  assert.equal(registry.get('local').state, 'lost');
});

test('the local form of the command line: --port, --token-file, no --connect, no token option; the defaults are those of the port', () => {
  const settings = parseRunnerArguments(['--port', '3011'], {root});
  assert.equal(settings.port, 3011);
  assert.equal(settings.tokenFile, tokenFilePath(serverRuntime(3011)));
  assert.equal(settings.runtime, localRunnerRuntime(3011));
  assert.equal(parseRunnerArguments(['--port', '3011', '--token-file', '/x/t'], {root}).tokenFile, '/x/t');
  for (const bad of [['--connect', '/x/runner-3011.sock'], ['--token', 'abc'], ['--auth-token', 'abc']]) assert.throws(() => parseRunnerArguments(bad, {root}), /unknown option|Unknown option/i, bad.join(' '));
  assert.ok(!runnerSpec(root).options.some(option => /token$/.test(option.flag) && option.flag !== '--token-file'), 'no option takes a token value');
  const identity = load({port: 3011, tokenFile: '/x/t'});
  assert.equal(identity.urls.connectUrl, 'ws://127.0.0.1:3011/runner/connect');
  assert.deepEqual(identity.derivedRows(), [['Runner', 'local'], ['Server WebSocket', 'ws://127.0.0.1:3011/runner/connect']]);
});

test('start.sh passes the path of the token file, never its content, and waits for the port', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'start.sh'), 'utf8');
  assert.match(script, /--token-file "\$token_file"/);
  assert.match(script, /\/dev\/tcp\/127\.0\.0\.1\/\$port/, 'it waits for the port to listen');
  assert.ok(!/\b(cat|head|<)\b[^\n]*token_file/.test(script.replace(/#[^\n]*/g, '')), 'start.sh never reads the token');
  assert.match(script, /--local-runner/);
  assert.ok(!/runner-[^ ]*\.sock/.test(script));
});
