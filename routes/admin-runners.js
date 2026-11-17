'use strict';

// GET /api/admin/runners: the runners the server knows, for the "Runners" panel of /admin.
// Read-only and not audited (like the session list). The web interface registers nothing: a
// runner always dials the server (docs/deployment.md, "The runner process").
//   {runners: [{id, state, mode, engines, kvm, cpus, memoryBytes, systems, warnings, sessions}],
//    connectHint}
//   mode         'local' when the server started it (--local), 'manual' when started by hand
//   systems      the systems whose base image this runner knows (hello)
//   connectHint  the command that starts a runner, while none is online and the server was not
//                started with --local; null otherwise
const DEFAULT_PORT = 3002;

function runnerSummaries({registry, manager, local}) {
  return registry.list().filter(entry => entry.state !== 'lost').map(entry => {
    const capabilities = entry.capabilities || {};
    return {
      id: entry.id, state: entry.state, mode: local ? 'local' : 'manual',
      engines: capabilities.engines || [], kvm: capabilities.kvm === true, cpus: capabilities.cpus ?? null,
      memoryBytes: capabilities.memoryBytes ?? null, systems: Object.keys(capabilities.images || {}).sort(),
      warnings: capabilities.warnings || [],
      sessions: manager.list().filter(workspace => workspace.session.runnerId === entry.id).length
    };
  });
}

function connectHint({runners, local, port}) {
  if (local || runners.some(runner => runner.state === 'online')) return null;
  return `${port === DEFAULT_PORT ? '' : `PORT=${port} `}./scripts/runner.sh`;
}

// Express handler; `local` is whether the server was started with --local.
function runnersHandler({manager, local, port}) {
  return (_req, res) => {
    const runners = runnerSummaries({registry: manager.registry, manager, local});
    res.json({runners, connectHint: connectHint({runners, local, port})});
  };
}

module.exports = {runnersHandler, runnerSummaries, connectHint};
