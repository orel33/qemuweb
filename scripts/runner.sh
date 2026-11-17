#!/usr/bin/env bash
# Starts a runner: it dials the QemuWeb server of this project (--port, default 3002) on
# <runtime>/runner-<port>.sock, keeps its VMs if the server restarts and reconnects.
#   ./scripts/runner.sh [options]     (--help lists them; see also README.md, "Server and runner command line")
# A front end to `node runner/main.js`. Run it as your normal user, never as root. Stop it with
# Ctrl+C: it stops its VMs first.
set -euo pipefail

if [[ "$(id -u)" == "0" ]]; then
  echo 'Do not run the runner as root.' >&2
  exit 1
fi
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$root"
exec node runner/main.js "$@"
