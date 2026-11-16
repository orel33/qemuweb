#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

usage() {
  cat <<'EOF'
Usage: ./scripts/run-tests.sh <test>

Available tests:
  unit                           Unit tests: topology, UI helpers, guest media, metrics, auth, admin and sessions
  two-users-isolation            Two logged-in users: no shared nodes, events or controls (VDE only)
  session-reconnect              Log out and back in: running nodes, consoles and logs restored
  admin                          Admin role: /api/admin gate, observation, control, cleanup, accounts, audit (VDE only)
  two-hosts                      Two Debian Legacy hosts: VDE, ping and Stop/Resume
  four-hosts-startup             Four Debian Legacy hosts configured by start.sh templates
  startup-media-profiles         Startup ISO on Debian Legacy, Alpine, Debian Cloud and OpenWrt
  check-network-debian13-legacy  Two Debian Legacy hosts on one VDE switch: eth0, hostname, ping, tcpdump
  check-network-debian13-cloud   Two Debian Cloud hosts on one VDE switch: eth0, hostname, ping, tcpdump
  check-network-alpine           Two Alpine hosts on one VDE switch: eth0, hostname, ping, tcpdump
  check-network-openwrt          Two OpenWrt hosts on one VDE switch: eth0, hostname, ping, tcpdump
  web                            Web app on PORT=3003, accounts admin, toto, tutu (demo/lan.zip loaded)

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

# Manual Web test: a separate, temporary users file (never the repository's users.json) with
# admin/admin (admin), toto/toto and tutu/tutu (students). Passwords equal to logins are for
# this local test mode only. toto and tutu start with demo/lan.zip loaded in their session.
run_web() {
  local port="${PORT:-3003}"
  web_server_pid=''
  web_dir="$(mktemp -d "${TMPDIR:-/tmp}/qemuweb-web-XXXXXX")"
  trap cleanup_web EXIT
  trap 'exit 130' INT TERM
  printf '\n== Web app on port %s with test accounts ==\n' "$port"
  node test/manual/web-setup.js prepare "$web_dir/users.json"
  PORT="$port" QEMUWEB_USERS_FILE="$web_dir/users.json" node server.js &
  web_server_pid=$!
  node test/manual/web-setup.js load "http://127.0.0.1:$port"
  cat <<EOF

Manual Web test: http://127.0.0.1:$port
  admin / admin   (admin)
  toto  / toto    (student, demo/lan.zip loaded)
  tutu  / tutu    (student, demo/lan.zip loaded)
Passwords equal to logins exist only in this test mode's temporary users file.
Stop with Ctrl+C.
EOF
  wait "$web_server_pid"
}

# Stops the server (it removes its sessions and nodes) and deletes the temporary users file.
cleanup_web() {
  if [[ -n "${web_server_pid:-}" ]] && kill -0 "$web_server_pid" 2>/dev/null; then
    kill -TERM "$web_server_pid" 2>/dev/null || true
    wait "$web_server_pid" 2>/dev/null || true
  fi
  rm -rf -- "${web_dir:-}"
}

case "${1:-}" in
  ''|--help|-h|--list) usage ;;
  unit) run_test 'Unit tests: topology, UI helpers, guest media, metrics, auth, admin and sessions' npm test ;;
  two-users-isolation) run_test 'Two logged-in users: isolation of nodes, consoles and events' npm run test:two-users-isolation ;;
  session-reconnect) run_test 'Reconnection: running nodes, consoles and logs restored' npm run test:session-reconnect ;;
  admin) run_test 'Admin role: supervision, observation, console control, cleanup, accounts and audit' npm run test:admin ;;
  two-hosts) run_test 'Two Debian Legacy hosts: VDE, ping and Stop/Resume' npm run test:two-hosts ;;
  four-hosts-startup) run_test 'Four Debian Legacy hosts: startup templates and full LAN ping' npm run test:four-hosts-startup ;;
  startup-media-profiles) run_test 'Startup ISO on Debian Legacy, Alpine, Debian Cloud and OpenWrt' npm run test:startup-media-profiles ;;
  check-network-debian13-legacy) run_test 'Two Debian Legacy hosts on one VDE switch: eth0, hostname, ping, tcpdump' npm run test:check-network-debian13-legacy ;;
  check-network-debian13-cloud) run_test 'Two Debian Cloud hosts on one VDE switch: eth0, hostname, ping, tcpdump' npm run test:check-network-debian13-cloud ;;
  check-network-alpine) run_test 'Two Alpine hosts on one VDE switch: eth0, hostname, ping, tcpdump' npm run test:check-network-alpine ;;
  check-network-openwrt) run_test 'Two OpenWrt hosts on one VDE switch: eth0, hostname, ping, tcpdump' npm run test:check-network-openwrt ;;
  web) run_web ;;
  *) printf 'Unknown test: %s\n' "$1" >&2; usage >&2; exit 2 ;;
esac
