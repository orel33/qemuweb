// Test helper: a runner service and its control-plane client connected through an in-memory
// stream pair, with the same protocol as the runner process. No process is spawned.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {duplexPair} = require('node:stream');
const {once} = require('node:events');
const {createRunnerService, serveConnection} = require('../../runner');
const {Connection} = require('../../common/runner-protocol');
const {RunnerClient} = require('../../server/runner-client');
const {RunnerRegistry} = require('../../server/runner-registry');

const root = path.join(__dirname, '..', '..');
const commands = {QEMU_IMG: 'qemu-img', QEMU_SYSTEM_X86_64: 'qemu-system-x86_64', GENISOIMAGE: 'genisoimage'};

// Returns {runtimeRoot, service, client, registry, entry}; the runtime directory and the
// sessions are removed after the test.
async function runnerPair(t, {prefix = 'qw-pair-'} = {}) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const service = createRunnerService({commands, root, runtimeRoot, configPath: path.join(root, 'config.json')});
  const [controlSide, runnerSide] = duplexPair();
  const client = new RunnerClient(new Connection(controlSide));
  const registry = new RunnerRegistry();
  const entry = registry.add({id: 'local', client, local: true, trusted: true});
  const hello = once(registry, 'online');
  serveConnection(new Connection(runnerSide), service);
  await hello;
  t.after(async () => {
    await service.shutdown();
    client.close();
    fs.rmSync(runtimeRoot, {recursive: true, force: true});
  });
  return {runtimeRoot, service, client, registry, entry};
}

module.exports = {runnerPair, root, commands};
