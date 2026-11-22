#!/usr/bin/env bash
# Starts the QemuWeb server (the control plane: web interface, accounts, sessions) by hand, the
# counterpart of scripts/runner.sh. It listens on 127.0.0.1 unless --bind ADDRESS is given (docs/deployment.md). Start it with --local-runner for the runner of this machine (./scripts/runner.sh --port PORT).
#   ./scripts/server.sh [options]     (--help lists them; see also docs/reference.md, "Server and runner command line")
# A front end to `node server/main.js`, which parses and validates its arguments. Run it as your
# normal user, never as root. Stop it with Ctrl+C or ./scripts/stop.sh.
set -euo pipefail

if [[ "$(id -u)" == "0" ]]; then
  echo 'Do not run the server as root.' >&2
  exit 1
fi
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$root"
exec node server/main.js "$@"
