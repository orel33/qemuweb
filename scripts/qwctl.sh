#!/usr/bin/env bash
# Installs and controls the systemd services of a QemuWeb server and its runners; see scripts/qwctl.js or run with --help.
# Run it as a normal account: it calls sudo itself where it is needed.
set -euo pipefail

script_path="$(readlink -f -- "${BASH_SOURCE[0]}")"
root="$(cd -- "$(dirname -- "$script_path")/.." && pwd -P)"
exec node "$root/scripts/qwctl.js" "$@"
