#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

usage() {
  cat <<'EOF'
Usage: ./run-tests.sh <test>

Available tests:
  unit            Node unit tests
  lan2            Two-host Debian 13 Legacy LAN integration test
  lan2-tcg        LAN2 using QEMU/TCG
  gts16-lan2      LAN2 with guest startup media
  gts16-profiles  Guest startup media on Alpine, Debian Cloud and OpenWrt
  web             Start the Web app on PORT=3003 for manual UI testing

Use --list or --help to show this list. Nothing runs without a test name.
To keep a live log: ./run-tests.sh lan2 2>&1 | tee lan2.log
EOF
}

case "${1:-}" in
  ''|--help|-h|--list) usage ;;
  unit) npm test ;;
  lan2) npm run test:lan2 ;;
  lan2-tcg) LAN2_ENGINE=qemu-tcg npm run test:lan2 ;;
  gts16-lan2) npm run test:gts16-lan2 ;;
  gts16-profiles) npm run test:gts16-profiles ;;
  web) PORT="${PORT:-3003}" npm start ;;
  *) printf 'Unknown test: %s\n' "$1" >&2; usage >&2; exit 2 ;;
esac
