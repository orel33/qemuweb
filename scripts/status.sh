#!/usr/bin/env bash
# Process tree of the QemuWeb servers and their runner. See scripts/status.js (--help).
set -euo pipefail
exec node "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/status.js" "$@"
