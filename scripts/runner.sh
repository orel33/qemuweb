#!/usr/bin/env bash
# Starts a runner (the process that runs the machines) by hand, the counterpart of
# scripts/server.sh. It dials the QemuWeb server of this project (--port PORT, default 3002, started with --local-runner)
# at ws://127.0.0.1:PORT (ws://ADDRESS:PORT with --host ADDRESS, for a server started with --bind ADDRESS) as the runner "local", with the token the server wrote in a file (--token-file FILE, default:
# local-runner.token of the default directory of the port; no token on the command line); keeps its VMs if the server
# restarts and reconnects; exits with status 78 when the server refuses its token.
#   ./scripts/runner.sh [options]     (--help lists them; see also docs/reference.md, "Server and runner command line")
# A front end to `node runner/main.js`, which parses and validates its arguments. Run it as your
# normal user, never as root. Stop it with Ctrl+C: it stops its VMs first.
set -euo pipefail

if [[ "$(id -u)" == "0" ]]; then
  echo 'Do not run the runner as root.' >&2
  exit 1
fi
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$root"
exec node runner/main.js "$@"
