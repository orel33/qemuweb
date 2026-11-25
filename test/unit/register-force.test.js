// runner.sh register refuses to replace an existing runner file (its token would be lost) unless --force. The program is run against
// a closed port of this machine: the refusal comes before any connection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {spawnSync} = require('node:child_process');

const main = path.join(__dirname, '..', '..', 'runner', 'main.js');

test('register: an existing runner file is kept, --force goes on to the registration', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-reg-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'runner.json');
  fs.writeFileSync(file, 'the previous token');
  const register = (...extra) => spawnSync(process.execPath, [main, 'register', '--url', 'http://127.0.0.1:1', '--token', 'a-registration-token', '--runner-config', file, ...extra], {encoding: 'utf8', timeout: 20000});
  const refused = register();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /runner\.json exists: it holds the token of a registered runner/);
  assert.match(refused.stderr, /Registration aborted/);
  assert.doesNotMatch(refused.stdout + refused.stderr, /a-registration-token/);
  const forced = register('--force');
  assert.equal(forced.status, 1, 'nothing listens on that port');
  assert.match(forced.stdout, /will be replaced/);
  assert.match(forced.stderr, /Registration failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'the previous token', 'replaced only by a registration that succeeds');
});
