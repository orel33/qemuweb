// The credential of the local runner: server/local-runner-token.js (the file the server creates with --local-runner),
// common/local-token.js (what the runner reads) and the start of the record "local". Real files in a temporary
// directory; no server.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {ensureLocalRunnerToken, startLocalRunner} = require('../../server/local-runner-token');
const {createRunnerStore} = require('../../server/runner-store');
const {TOKEN_FILE, tokenFilePath, readTokenFile} = require('../../common/local-token');

const temporary = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-token-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
};
const mode = file => fs.statSync(file).mode & 0o777;

test('a missing file is created: mode 0600, a new directory 0700, 32 random bytes in base64url, no temporary file left', t => {
  const dir = path.join(temporary(t), 'server', 'deeper');
  const token = ensureLocalRunnerToken(dir);
  assert.equal(token.file, path.join(dir, 'local-runner.token'));
  assert.equal(token.created, true);
  assert.equal(mode(token.file), 0o600);
  assert.equal(mode(dir), 0o700, 'a directory it creates is private');
  const content = fs.readFileSync(token.file, 'utf8');
  assert.match(content, /^[A-Za-z0-9_-]{43}\n$/);
  assert.deepEqual(fs.readdirSync(dir), ['local-runner.token'], 'the atomic write leaves nothing else');
  assert.equal(readTokenFile(token.file), content.trim());
});

test('a readable token file is never rewritten, and the same token matches after a restart', t => {
  const dir = temporary(t);
  const first = ensureLocalRunnerToken(dir);
  const content = fs.readFileSync(first.file, 'utf8');
  const stat = fs.statSync(first.file);
  const second = ensureLocalRunnerToken(dir);
  assert.equal(second.created, false);
  assert.equal(fs.readFileSync(first.file, 'utf8'), content);
  assert.equal(fs.statSync(first.file).ino, stat.ino, 'not even replaced');
  assert.ok(second.matches(content.trim()), 'the hash is recomputed from the file');
  // A token chosen by hand is a token too.
  const mine = 'a-token-of-my-own-with-32-chars-or-more!';
  fs.writeFileSync(first.file, `${mine}\n`, {mode: 0o600});
  assert.ok(ensureLocalRunnerToken(dir).matches(mine));
});

test('an unreadable or unusable file is replaced by a new one, and says why', t => {
  const dir = temporary(t);
  const file = tokenFilePath(dir);
  for (const content of ['', 'short\n', 'two words in the file that is long enough to pass the size\n', `${'x'.repeat(300)}\n`]) {
    fs.writeFileSync(file, content, {mode: 0o600});
    const token = ensureLocalRunnerToken(dir);
    assert.equal(token.created, true, JSON.stringify(content.slice(0, 20)));
    assert.match(token.reason, /does not hold a token/);
    assert.ok(!token.reason.includes('two words'), 'the reason never quotes the content');
    assert.match(fs.readFileSync(file, 'utf8'), /^[A-Za-z0-9_-]{43}\n$/);
  }
  if (process.getuid() !== 0) {
    fs.chmodSync(file, 0o000);
    const token = ensureLocalRunnerToken(dir);
    assert.equal(token.created, true);
    assert.match(token.reason, /cannot be read/);
    assert.equal(mode(file), 0o600);
  }
});

test('the token matches only itself, in constant time, and nothing else matches', t => {
  const {matches, file} = ensureLocalRunnerToken(temporary(t));
  const token = readTokenFile(file);
  t.mock.method(crypto, 'timingSafeEqual');
  assert.equal(matches(token), true);
  assert.equal(crypto.timingSafeEqual.mock.calls.length, 1, 'compared with timingSafeEqual, on equal-length digests');
  for (const wrong of [token.slice(0, -1), `${token}x`, '', 'local', token.toUpperCase(), undefined, null, 42, 'y'.repeat(300)]) assert.equal(matches(wrong), false, String(wrong).slice(0, 12));
});

test('the runner reads the file: MISSING, UNREADABLE and INVALID are told apart and never quote the content', t => {
  const dir = temporary(t);
  const file = tokenFilePath(dir);
  assert.equal(path.basename(file), TOKEN_FILE);
  assert.throws(() => readTokenFile(file), error => error.code === 'MISSING' && /does not exist/.test(error.message));
  fs.writeFileSync(file, 'secret-but-short\n');
  assert.throws(() => readTokenFile(file), error => error.code === 'INVALID' && !error.message.includes('secret'));
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.throws(() => readTokenFile(file), error => error.code === 'UNREADABLE');
});

test('startLocalRunner creates the record once, audits it, keeps a revoked record revoked and never logs the token', t => {
  const dir = temporary(t);
  const store = createRunnerStore(path.join(dir, 'runners.json'));
  const audit = [];
  const lines = [];
  const log = {log: line => lines.push(line), warn: line => lines.push(line)};
  const first = startLocalRunner({runtime: path.join(dir, 'server'), store, audit: {record: (...args) => audit.push(args)}, log});
  assert.deepEqual(store.get('local').tokenHash, undefined);
  assert.deepEqual(audit, [['server', 'register-local-runner', {runnerId: 'local'}, 'ok']]);
  assert.match(lines[0], /token file .* created/);
  store.change('local', {revoked: true});
  lines.length = 0;
  startLocalRunner({runtime: path.join(dir, 'server'), store, audit: {record: (...args) => audit.push(args)}, log});
  assert.equal(store.get('local').revoked, true, 'a start never un-revokes it');
  assert.equal(audit.length, 1, 'audited at its creation only');
  assert.ok(lines.some(line => /revoked: it stays refused/.test(line)));
  const token = readTokenFile(first.file);
  assert.ok(![...lines, JSON.stringify(audit), fs.readFileSync(store.file, 'utf8')].some(text => text.includes(token)), 'the token is nowhere');
  fs.chmodSync(first.file, 0o644);
  lines.length = 0;
  startLocalRunner({runtime: path.join(dir, 'server'), store, audit: {record() {}}, log});
  assert.ok(lines.some(line => /can be read by other users/.test(line)));
});
