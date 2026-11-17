// Remote runner credentials: the runners store (hash only, mode 0600, revoke), the one-time
// registration tokens, the runner file (mode 0600/0700), the server URL rules and the reconnect backoff.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createRunnerStore, parseRunners, hashToken} = require('../../server/runner-store');
const {createRegistrationTokens} = require('../../server/runner-registration');
const {readRunnerConfig, writeRunnerConfig} = require('../../runner/config-file');
const {serverUrls} = require('../../runner/remote-url');
const {retryDelay} = require('../../runner/remote');

const tmp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-store-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
};

test('the store keeps only the hash of the token, in a 0600 file, and survives a restart', t => {
  const file = path.join(tmp(t), 'runners.json');
  const store = createRunnerStore(file);
  const {record, authToken} = store.add({name: ' salle-12\u0007 '});
  assert.match(record.id, /^r-[0-9a-f]{8}$/);
  assert.equal(record.name, 'salle-12');
  assert.ok(authToken.length >= 43);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(authToken), 'the token is never written');
  assert.ok(text.includes(hashToken(authToken)));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const reloaded = createRunnerStore(file);
  assert.equal(reloaded.count(), 1);
  assert.equal(reloaded.verify(record.id, authToken).id, record.id);
});

test('verify refuses an unknown runner, a wrong or oversized token and a revoked runner', t => {
  const store = createRunnerStore(path.join(tmp(t), 'runners.json'));
  const {record, authToken} = store.add({name: 'a'});
  assert.equal(store.verify('r-00000000', authToken), null);
  assert.equal(store.verify(record.id, `${authToken}x`), null);
  assert.equal(store.verify(record.id, 'x'.repeat(300)), null);
  assert.equal(store.verify(record.id, undefined), null);
  assert.equal(store.verify(undefined, authToken), null);
  store.change(record.id, {revoked: true});
  assert.equal(store.verify(record.id, authToken), null, 'revoked');
  assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).runners[0].revoked, true);
  store.change(record.id, {paused: true});
  store.remove(record.id);
  assert.equal(store.count(), 0);
  assert.throws(() => store.remove(record.id), /Unknown runner/);
});

test('runners.json is validated', () => {
  assert.throws(() => parseRunners('{'), /Cannot parse/);
  assert.throws(() => parseRunners('{"schemaVersion":2,"runners":[]}'), /schemaVersion 1/);
  assert.throws(() => parseRunners('{"schemaVersion":1,"runners":[{"id":"x"}]}'), /invalid/);
  assert.deepEqual(parseRunners('{"schemaVersion":1,"runners":[]}'), []);
});

test('a registration token is single use and expires', () => {
  let time = 1000;
  const tokens = createRegistrationTokens({now: () => time});
  const first = tokens.create({minutes: 15, by: 'boss'});
  assert.equal(tokens.pending().length, 1);
  assert.ok(!JSON.stringify(tokens.pending()).includes(first.token), 'the secret is never listed');
  assert.equal(tokens.redeem('wrong'), null);
  assert.equal(tokens.redeem(first.token), 'boss');
  assert.equal(tokens.redeem(first.token), null, 'single use');
  const second = tokens.create({minutes: 60, by: 'boss'});
  time += 59 * 60000;
  assert.equal(tokens.redeem(second.token), 'boss', 'still valid just before the end');
  const third = tokens.create({minutes: 15, by: 'boss'});
  time += 15 * 60000;
  assert.equal(tokens.redeem(third.token), null, 'expired');
  assert.throws(() => tokens.create({minutes: 7, by: 'boss'}), /minutes/);
  assert.equal(tokens.redeem(undefined), null);
  assert.equal(tokens.redeem('x'.repeat(1000)), null);
  const fourth = tokens.create({minutes: 1440, by: 'boss'});
  assert.equal(tokens.cancel(tokens.pending()[0].id), true);
  assert.equal(tokens.redeem(fourth.token), null, 'cancelled');
});

test('the runner file is written 0600 in a 0700 directory and read back; bad content is refused', t => {
  const file = path.join(tmp(t), 'config', 'qemuweb-runner', 'runner.json');
  const config = {url: 'https://qemuweb.example.org', runnerId: 'r-1a2b3c4d', authToken: 'secret', name: 'salle-12', runtime: '/srv/rt', limits: {maxSessions: 4}};
  writeRunnerConfig(file, config);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(readRunnerConfig(file), config);
  assert.throws(() => readRunnerConfig(`${file}.missing`), /register this runner first/);
  assert.throws(() => writeRunnerConfig(file, {...config, runnerId: 'bad'}), /runnerId/);
  assert.throws(() => writeRunnerConfig(file, {...config, limits: {maxSessions: 0}}), /limit/);
  assert.throws(() => writeRunnerConfig(file, {...config, extra: 1}), /unknown field/);
  fs.writeFileSync(file, '{');
  assert.throws(() => readRunnerConfig(file), /Cannot parse/);
});

test('server URLs: https anywhere, plain http only on this machine unless --insecure', () => {
  assert.deepEqual(serverUrls('https://qemuweb.example.org/'), {base: 'https://qemuweb.example.org', registerUrl: 'https://qemuweb.example.org/api/runner/register',
    connectUrl: 'wss://qemuweb.example.org/runner/connect', plain: false});
  assert.equal(serverUrls('ws://127.0.0.1:3002').connectUrl, 'ws://127.0.0.1:3002/runner/connect');
  assert.equal(serverUrls('http://localhost:3002').plain, false);
  assert.throws(() => serverUrls('http://qemuweb.example.org'), /--insecure/);
  assert.equal(serverUrls('http://qemuweb.example.org', {insecure: true}).plain, true);
  assert.throws(() => serverUrls('ftp://x'), /scheme/);
  assert.throws(() => serverUrls('https://user:pw@x'), /login or password/);
  assert.throws(() => serverUrls('not a url'), /Invalid server URL/);
});

test('the reconnect delay doubles from 2 s up to 30 s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 10].map(retryDelay), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});
