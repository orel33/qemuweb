#!/usr/bin/env bash
set -euo pipefail

script_path="$(readlink -f -- "${BASH_SOURCE[0]}")"
cd -- "$(dirname -- "$script_path")/.."
exec npm start
