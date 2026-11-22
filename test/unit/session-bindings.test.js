// bindings.json (server/session-bindings.js): the server's own session -> owner -> runner record.
// It is untrusted input at load time and is written before a session is created.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createSessionBindings, parseBindings} = require('../../server/session-bindings');

const ID = n => n.toString(16).padStart(16, '0');
const DATE = '2026-01-02T03:04:05.000Z';
const entry = (n, owner, runnerId = 'local') => ({id: ID(n), owner, runnerId, createdAt: DATE});
const file = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-bind-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return path.join(dir, 'bindings.json');
};

test('a binding is written atomically with mode 0600, read back after a restart, and the file goes away with the last binding', t => {
  const target = file(t);
  const bindings = createSessionBindings(target, {log: () => {}});
  bindings.set(entry(1, 'toto'));
  bindings.set(entry(2, 'bob', 'r-00000001'));
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['bindings.json'], 'no temporary file left');
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), {schemaVersion: 1, sessions: [entry(1, 'toto'), entry(2, 'bob', 'r-00000001')]});
  const reloaded = createSessionBindings(target, {log: () => {}});
  assert.deepEqual(reloaded.list(), [entry(1, 'toto'), entry(2, 'bob', 'r-00000001')]);
  assert.deepEqual(reloaded.get(ID(1)), entry(1, 'toto'));
  reloaded.remove(ID(1));
  reloaded.remove(ID(2));
  assert.equal(fs.existsSync(target), false);
  reloaded.remove(ID(2));
});

test('a failed write leaves no binding in memory (the session is then not created)', t => {
  const target = path.join(file(t), 'missing-directory', 'bindings.json');
  const bindings = createSessionBindings(target, {log: () => {}});
  assert.throws(() => bindings.set(entry(1, 'toto')));
  assert.equal(bindings.get(ID(1)), null);
});

test('invalid, duplicate, unknown-field and oversized entries are skipped with a message, never a crash', () => {
  const messages = [];
  const parsed = parseBindings(JSON.stringify({schemaVersion: 1, sessions: [
    entry(1, 'toto'),
    entry(1, 'other'),
    entry(2, 'toto'),
    {...entry(3, 'a b')},
    {...entry(4, '../x')},
    {...entry(5, 'bob'), runnerId: 'remote'},
    {...entry(6, 'bob'), id: 'xyz'},
    {...entry(7, 'bob'), createdAt: 'yesterday'},
    {...entry(8, 'bob'), trusted: true},
    null, 'text', 7,
    entry(9, 'carol', 'r-0000000a')
  ]}), message => messages.push(message));
  assert.deepEqual([...parsed.keys()], [ID(1), ID(9)]);
  assert.equal(messages.length, 11, "one message per skipped entry");
  assert.ok(messages.some(message => /duplicate/.test(message)));
});

test('a corrupt, old or oversized file means no bindings and a loud message, not a crash', t => {
  const messages = [];
  const log = message => messages.push(message);
  for (const text of ['{', '[]', '{"schemaVersion":2,"sessions":[]}', '{"schemaVersion":1,"sessions":"x"}', 'null']) {
    const target = file(t);
    fs.writeFileSync(target, text);
    assert.deepEqual(createSessionBindings(target, {log}).list(), []);
  }
  assert.equal(messages.length, 5);
  assert.ok(messages.every(message => /bindings\.json/.test(message) && /deleted when the runners connect/.test(message)));
  const big = file(t);
  fs.writeFileSync(big, ' '.repeat(5 * 1024 * 1024));
  assert.deepEqual(createSessionBindings(big, {log}).list(), []);
  assert.equal(messages.length, 6);
  assert.deepEqual(createSessionBindings(path.join(path.dirname(big), 'absent.json'), {log}).list(), [], 'an absent file is normal and silent');
  assert.equal(messages.length, 6);
});

test('with no file the bindings live in memory only', () => {
  const bindings = createSessionBindings();
  bindings.set(entry(1, 'toto'));
  assert.equal(bindings.get(ID(1)).owner, 'toto');
  bindings.remove(ID(1));
  assert.deepEqual(bindings.list(), []);
});
