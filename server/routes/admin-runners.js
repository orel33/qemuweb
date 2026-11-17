'use strict';

// GET /api/admin/runners: the runners the server knows, for the "Runners" panel of /admin.
// Read-only and not audited (like the session list). The web interface registers nothing: a
// runner always dials the server (docs/deployment.md, "The runner process").
//   {runners: [{id, state, engines, kvm, cpus, memoryBytes, systems, warnings, sessions}], connectHint}
//   systems      the systems whose base image this runner knows (hello)
//   connectHint  the command that starts a runner, while none is online; null otherwise
const DEFAULT_PORT = 3002;

function runnerSummaries({registry, manager}) {
  return registry.list().filter(entry => entry.state !== 'lost').map(entry => {
    const capabilities = entry.capabilities || {};
    return {
      id: entry.id, state: entry.state,
      engines: capabilities.engines || [], kvm: capabilities.kvm === true, cpus: capabilities.cpus ?? null,
      memoryBytes: capabilities.memoryBytes ?? null, systems: Object.keys(capabilities.images || {}).sort(),
      warnings: capabilities.warnings || [],
      sessions: manager.list().filter(workspace => workspace.session.runnerId === entry.id).length
    };
  });
}

// `runtime`: the --runtime of the server when it was given, else null (the runner's default is the same).
function connectHint({runners, port, runtime = null}) {
  if (runners.some(runner => runner.state === 'online')) return null;
  const options = [port === DEFAULT_PORT ? '' : `--port ${port}`, runtime ? `--runtime ${runtime}` : ''].filter(Boolean);
  return ['./scripts/runner.sh', ...options].join(' ');
}

function runnersHandler({manager, port, runtime = null}) {
  return (_req, res) => {
    const runners = runnerSummaries({registry: manager.registry, manager});
    res.json({runners, connectHint: connectHint({runners, port, runtime})});
  };
}

module.exports = {runnersHandler, runnerSummaries, connectHint};
