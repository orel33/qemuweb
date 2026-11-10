#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

usage() {
  cat <<'EOF'
Usage: ./scripts/run-tests.sh <test>

Available tests:
  unit            Unit tests: topology, UI helpers, guest media and metrics
  lan2            Two Debian Legacy hosts: VDE, ping and Stop/Resume
  lan2-tcg        Same LAN2 scenario using QEMU software emulation
  gts16-lan2      LAN2 plus per-host startup ISO, resources and Reboot
  gts16-profiles  Startup ISO on Alpine, Debian Cloud and OpenWrt
  web             Start the Web app on PORT=3003 for manual UI testing

Use --list or --help to show this list. Nothing runs without a test name.
See test/TESTS.md for the purpose and prerequisites of each test.
To keep a live log: ./scripts/run-tests.sh lan2 2>&1 | tee lan2.log
EOF
}

run_test() {
  printf '\n== %s ==\n' "$1"
  shift
  "$@"
}

case "${1:-}" in
  ''|--help|-h|--list) usage ;;
  unit) run_test 'Unit tests: topology, UI helpers, guest media and metrics' npm test ;;
  lan2) run_test 'Debian Legacy LAN2: VDE, ping and Stop/Resume' npm run test:lan2 ;;
  lan2-tcg) run_test 'Debian Legacy LAN2 using QEMU/TCG' env LAN2_ENGINE=qemu-tcg npm run test:lan2 ;;
  gts16-lan2) run_test 'Debian Legacy LAN2 with per-host startup ISO and Reboot' npm run test:gts16-lan2 ;;
  gts16-profiles) run_test 'Startup ISO on Alpine, Debian Cloud and OpenWrt' npm run test:gts16-profiles ;;
  web) PORT="${PORT:-3003}" npm start ;;
  *) printf 'Unknown test: %s\n' "$1" >&2; usage >&2; exit 2 ;;
esac
