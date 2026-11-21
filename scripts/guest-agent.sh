#!/usr/bin/env bash
# Ask the QEMU guest agent of a running host: ping, info or interfaces (read-only, nothing else).
# See scripts/guest-agent.js (--help) and docs/guest-agent.md.
set -euo pipefail
exec node "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/guest-agent.js" "$@"
