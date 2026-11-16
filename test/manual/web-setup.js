'use strict';

// Setup of the manual Web test (`./scripts/run-tests.sh web`), in two steps:
//   node test/manual/web-setup.js prepare <users-file>
//     checks demo/lan.zip and the base images it needs, then writes a separate users file
//     with admin/admin (admin), toto/toto and tutu/tutu (students).
//   node test/manual/web-setup.js load <base-url>
//     waits for the server, logs in as toto and tutu and loads demo/lan.zip into their
//     sessions with automatic start, exactly like the Load session button
//     (POST /api/session-archive/import?autoStart=true&discardStaleDisks=false; no backdoor).
//     Start errors are reported but do not fail the setup.
// Passwords equal to logins are for this local test mode only; never use them elsewhere.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {hashPassword} = require('../../lib/auth/passwords');
const {writeUsers} = require('../../lib/auth/users-store');
const {readArchive} = require('../../lib/session-archive');
const {QemuWebClient} = require('../integration/qemuweb-client');

const root = path.resolve(__dirname, '../..');
const archive = path.join(root, 'demo', 'lan.zip');
const ACCOUNTS = [
  {login: 'admin', password: 'admin', role: 'admin'},
  {login: 'toto', password: 'toto', role: 'student'},
  {login: 'tutu', password: 'tutu', role: 'student'}
];
const STUDENTS = ACCOUNTS.filter(account => account.role === 'student');

function fail(message) {
  console.error(`Web test setup: ${message}`);
  process.exit(1);
}

// Systems used by the hosts of the archive, read from a temporary extraction.
async function archiveSystems() {
  if (!fs.existsSync(archive)) fail(`missing ${path.relative(root, archive)}.`);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-web-demo-'));
  try {
    await readArchive(archive, stage);
    const {hosts = []} = JSON.parse(fs.readFileSync(path.join(stage, 'session.json'), 'utf8'));
    return [...new Set(hosts.map(id => JSON.parse(fs.readFileSync(path.join(stage, id, 'host.json'), 'utf8')).system))];
  } catch (error) {
    fail(`cannot read ${path.relative(root, archive)}: ${error.message}`);
  } finally {
    fs.rmSync(stage, {recursive: true, force: true});
  }
}

async function prepare(usersFile) {
  if (!usersFile) fail('usage: web-setup.js prepare <users-file>');
  const missing = (await archiveSystems()).filter(system => !fs.existsSync(path.join(root, 'images', `${system}.raw`)));
  if (missing.length) {
    fail(`${path.relative(root, archive)} needs ${missing.map(system => `images/${system}.raw`).join(', ')}; ` +
      `prepare it with ${missing.map(system => `bash scripts/prepare.sh --system ${system}`).join(' and ')}.`);
  }
  writeUsers(usersFile, await Promise.all(ACCOUNTS.map(async ({login, password, role}) =>
    ({login, role, hash: await hashPassword(password)}))));
}

async function load(baseUrl) {
  if (!baseUrl) fail('usage: web-setup.js load <base-url>');
  const data = fs.readFileSync(archive);
  for (const {login, password} of STUDENTS) {
    const client = new QemuWebClient(baseUrl);
    try {
      await client.waitForServer(30000);
      await client.signIn(login, password);
      const result = await client.request('/api/session-archive/import?autoStart=true&discardStaleDisks=false', {
        method: 'POST', body: data, headers: {'content-type': 'application/zip'}
      });
      console.log(`Web test setup: ${login}: ${path.relative(root, archive)} loaded and started (${result.hosts} hosts, ${result.switches} switches).`);
      for (const error of result.startErrors || []) console.log(`  start error: ${error}`);
      for (const warning of result.warnings || []) console.log(`  warning: ${warning}`);
    } catch (error) {
      fail(`cannot load ${path.relative(root, archive)} for ${login}: ${error.message}`);
    }
  }
}

const [command, argument] = process.argv.slice(2);
const actions = {prepare, load};
if (!actions[command]) fail('usage: web-setup.js prepare <users-file> | load <base-url>');
actions[command](argument).catch(error => fail(error.stack || error.message));
