#!/usr/bin/env bash
# Starts the QemuWeb server (the control plane: web interface, accounts, sessions) by hand, the
# counterpart of scripts/runner.sh. A runner (./scripts/runner.sh --port N) dials it.
#   ./scripts/server.sh [--listen N] [--runtime DIR]     (--help lists the options)
# A front end to `node server/main.js`, which validates its arguments (see README.md, "Server and
# runner command line"). Run it as your normal user, never as root. Stop it with Ctrl+C or
# ./scripts/stop.sh.
set -euo pipefail

if [[ "$(id -u)" == "0" ]]; then
  echo 'Do not run the server as root.' >&2
  exit 1
fi
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$root"
exec node server/main.js "$@"
