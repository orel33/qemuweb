#!/usr/bin/env bash
# Manages QemuWeb user accounts (users.json); see scripts/user.js or run with --help.
set -euo pipefail

script_path="$(readlink -f -- "${BASH_SOURCE[0]}")"
root="$(cd -- "$(dirname -- "$script_path")/.." && pwd -P)"
exec node "$root/scripts/user.js" "$@"
