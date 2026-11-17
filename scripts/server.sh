#!/usr/bin/env bash
# Starts the QemuWeb server (the control plane: web interface, accounts, sessions) by hand, the
# counterpart of scripts/runner.sh. A runner (./scripts/runner.sh) dials it on PORT.
#   ./scripts/server.sh              PORT=3003 ./scripts/server.sh to choose another port
# It takes no option but --help: the server is configured by environment variables (see README.md,
# "Server and runner command line"). Run it as your normal user, never as root. Stop it with
# Ctrl+C or ./scripts/stop.sh.
set -euo pipefail

if [[ "$(id -u)" == "0" ]]; then
  echo 'Do not run the server as root.' >&2
  exit 1
fi
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
port="${PORT:-3002}"
if [[ ! "$port" =~ ^[0-9]+$ ]]; then
  echo "Invalid PORT: $port" >&2
  exit 2
fi
cd -- "$root"
exec node server/main.js "$@"
