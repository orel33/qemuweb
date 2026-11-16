#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

usage() {
  cat <<'EOF'
Usage: ./scripts/run-tests.sh <test>

Available tests:
  unit                      Unit tests: topology, UI helpers, guest media, metrics, auth, admin and sessions
  two-users-isolation       Two logged-in users: no shared nodes, events or controls (VDE only)
  session-reconnect         Log out and back in: running nodes, consoles and logs restored
  admin                     Admin role: /api/admin gate, observation, control, cleanup, accounts, audit (VDE only)
  two-hosts                 Two Debian Legacy hosts: VDE, ping and Stop/Resume
  two-hosts-tcg             Same two-hosts scenario using QEMU software emulation
  two-hosts-startup-media   Two hosts plus per-host startup ISO, resources and Reboot
  four-hosts-startup        Four Debian Legacy hosts configured by start.sh templates
  startup-media-profiles    Startup ISO on Alpine, Debian Cloud and OpenWrt
  guest-network             Two guests per system: login, hostname, LAN ping and tcpdump
  web                       Start the Web app on PORT=3003 for manual UI testing

Use --list or --help to show this list. Nothing runs without a test name.
See test/TESTS.md for the purpose and prerequisites of each test.
To keep a live log: ./scripts/run-tests.sh two-hosts 2>&1 | tee two-hosts.log
EOF
}

run_test() {
  printf '\n== %s ==\n' "$1"
  shift
  "$@"
}

case "${1:-}" in
  ''|--help|-h|--list) usage ;;
  unit) run_test 'Unit tests: topology, UI helpers, guest media, metrics, auth, admin and sessions' npm test ;;
  two-users-isolation) run_test 'Two logged-in users: isolation of nodes, consoles and events' npm run test:two-users-isolation ;;
  session-reconnect) run_test 'Reconnection: running nodes, consoles and logs restored' npm run test:session-reconnect ;;
  admin) run_test 'Admin role: supervision, observation, console control, cleanup, accounts and audit' npm run test:admin ;;
  two-hosts) run_test 'Two Debian Legacy hosts: VDE, ping and Stop/Resume' npm run test:two-hosts ;;
  two-hosts-tcg) run_test 'Two Debian Legacy hosts using QEMU/TCG' env TWO_HOSTS_ENGINE=qemu-tcg npm run test:two-hosts ;;
  two-hosts-startup-media) run_test 'Two Debian Legacy hosts with per-host startup ISO and Reboot' npm run test:two-hosts-startup-media ;;
  four-hosts-startup) run_test 'Four Debian Legacy hosts: startup templates and full LAN ping' npm run test:four-hosts-startup ;;
  startup-media-profiles) run_test 'Startup ISO on Alpine, Debian Cloud and OpenWrt' npm run test:startup-media-profiles ;;
  guest-network) run_test 'Four-system QEMU/KVM guest network diagnostic' npm run test:guest-network ;;
  web) PORT="${PORT:-3003}" npm start ;;
  *) printf 'Unknown test: %s\n' "$1" >&2; usage >&2; exit 2 ;;
esac
