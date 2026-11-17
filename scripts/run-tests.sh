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
  check-runner                   Local runner process: session through it, SIGKILL recovery, clean shutdown (VDE only)
  admin                          Admin role: /api/admin gate, observation, control, cleanup, accounts, audit (VDE only)
  check-load                     Load demo/*.topo and demo/lan.zip, export and re-import, refuse corrupted files (no VM)
  check-load-start               Load demo/lan.zip with automatic start like the Load session button: switch and 4 hosts running
  two-hosts-stop-resume          Two Debian Legacy hosts on one VDE switch: serial static IP, ping both ways, Stop/Resume keeping disk, port and MAC, ping again
  four-hosts-startup             Four Debian Legacy hosts configured by start.sh templates
  check-host-debian13-legacy     Debian Legacy host with startup disk: script, resource, Reboot with edited files, Stop/Resume
  check-host-debian13-cloud      Debian Cloud host with startup disk: script, resource, Reboot with edited files, Stop/Resume
  check-host-alpine              Alpine host with startup disk: script, resource, Reboot with edited files, Stop/Resume
  check-host-openwrt             OpenWrt host with startup disk: script, resource, Reboot with edited files, Stop/Resume, concurrent hosts, missing script/media
  check-network-debian13-legacy  Two Debian Legacy hosts on one VDE switch: eth0, hostname, ping, tcpdump
  check-network-debian13-cloud   Two Debian Cloud hosts on one VDE switch: eth0, hostname, ping, tcpdump
  check-network-alpine           Two Alpine hosts on one VDE switch: eth0, hostname, ping, tcpdump
  check-network-openwrt          Two OpenWrt hosts on one VDE switch: eth0, hostname, ping, tcpdump

Use --list or --help to show this list. Nothing runs without a test name.
See test/TESTS.md for the purpose and prerequisites of each test.
To keep a live log: ./scripts/run-tests.sh two-hosts-stop-resume 2>&1 | tee two-hosts-stop-resume.log
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
  check-runner) run_test 'Local runner process: session, SIGKILL recovery and shutdown' npm run test:check-runner ;;
  admin) run_test 'Admin role: supervision, observation, console control, cleanup, accounts and audit' npm run test:admin ;;
  check-load) run_test 'Load demo/*.topo and demo/lan.zip, export and re-import, refuse corrupted files (no VM)' npm run test:check-load ;;
  check-load-start) run_test 'Load demo/lan.zip with automatic start like the Load session button: switch and 4 hosts running' npm run test:check-load-start ;;
  two-hosts-stop-resume) run_test 'Two Debian Legacy hosts on one VDE switch: serial static IP, ping both ways, Stop/Resume keeping disk, port and MAC, ping again' npm run test:two-hosts-stop-resume ;;
  four-hosts-startup) run_test 'Four Debian Legacy hosts: startup templates and full LAN ping' npm run test:four-hosts-startup ;;
  check-host-debian13-legacy) run_test 'Debian Legacy host with startup disk: script, resource, Reboot with edited files, Stop/Resume' npm run test:check-host-debian13-legacy ;;
  check-host-debian13-cloud) run_test 'Debian Cloud host with startup disk: script, resource, Reboot with edited files, Stop/Resume' npm run test:check-host-debian13-cloud ;;
  check-host-alpine) run_test 'Alpine host with startup disk: script, resource, Reboot with edited files, Stop/Resume' npm run test:check-host-alpine ;;
  check-host-openwrt) run_test 'OpenWrt host with startup disk: script, resource, Reboot with edited files, Stop/Resume, concurrent hosts, missing script/media' npm run test:check-host-openwrt ;;
  check-network-debian13-legacy) run_test 'Two Debian Legacy hosts on one VDE switch: eth0, hostname, ping, tcpdump' npm run test:check-network-debian13-legacy ;;
  check-network-debian13-cloud) run_test 'Two Debian Cloud hosts on one VDE switch: eth0, hostname, ping, tcpdump' npm run test:check-network-debian13-cloud ;;
  check-network-alpine) run_test 'Two Alpine hosts on one VDE switch: eth0, hostname, ping, tcpdump' npm run test:check-network-alpine ;;
  check-network-openwrt) run_test 'Two OpenWrt hosts on one VDE switch: eth0, hostname, ping, tcpdump' npm run test:check-network-openwrt ;;
  *) printf 'Unknown test: %s\n' "$1" >&2; usage >&2; exit 2 ;;
esac
