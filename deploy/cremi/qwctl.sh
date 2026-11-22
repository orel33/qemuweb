#!/usr/bin/env bash
# Start, stop, restart or inspect the two QemuWeb services of the CREMI server: the server (qemuweb-server) and the
# local runner (qemuweb-runner). Run it as the qemuweb account (it uses sudo for systemctl).
#   ./deploy/cremi/qwctl.sh status [server|runner|all]
#   ./deploy/cremi/qwctl.sh start|stop|restart [server|runner|all]   (default: all)
#   ./deploy/cremi/qwctl.sh logs [server|runner|all] [LINES]         (last lines of the journal, default 20)
# Restarting the server alone keeps the machines (the runner holds them; the sessions come back when it reconnects).
# Stopping or restarting the runner stops every machine of the local runner: the script asks first (-y answers yes).
set -euo pipefail

SERVER=qemuweb-server
RUNNER=qemuweb-runner

usage() {
  sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

yes=0
args=()
for arg in "$@"; do
  case "$arg" in
    -y|--yes) yes=1 ;;
    -h|--help) usage ;;
    *) args+=("$arg") ;;
  esac
done
set -- "${args[@]}"
(( $# >= 1 )) || usage
action=$1
target=${2:-all}

case "$target" in
  server) units=("$SERVER") ;;
  runner) units=("$RUNNER") ;;
  all) units=("$RUNNER" "$SERVER") ;;
  *) [[ "$action" == logs && "$target" =~ ^[0-9]+$ ]] || { echo "qwctl: unknown target '$target' (server, runner or all)" >&2; usage; } ;;
esac
# "logs 50" means all units, 50 lines
lines=20
if [[ "$action" == logs ]]; then
  if [[ "$target" =~ ^[0-9]+$ ]]; then lines=$target; units=("$RUNNER" "$SERVER"); else lines=${3:-20}; fi
fi

# Stopping the runner stops every machine it runs: ask before doing it.
confirm_runner() {
  local unit
  for unit in "${units[@]}"; do
    [[ "$unit" == "$RUNNER" ]] || continue
    (( yes )) && return 0
    echo "This stops every machine of the local runner."
    read -r -p "Continue? [y/N] " answer
    [[ "$answer" == y || "$answer" == Y ]] || { echo "Cancelled."; exit 1; }
    return 0
  done
}

status() {
  local unit
  for unit in "${units[@]}"; do
    printf '%-16s %-10s since %s\n' "$unit" "$(systemctl is-active "$unit" || true)" \
      "$(systemctl show "$unit" -p ActiveEnterTimestamp --value)"
  done
  # the machines and the switches of the local runner
  echo "machines: $(pgrep -c qemu-system || true) qemu, $(pgrep -c vde_switch || true) vde_switch"
}

case "$action" in
  status) status ;;
  start) sudo systemctl start "${units[@]}"; sleep 2; status ;;
  stop) confirm_runner; sudo systemctl stop "${units[@]}"; status ;;
  restart) confirm_runner; sudo systemctl restart "${units[@]}"; sleep 3; status ;;
  logs)
    for unit in "${units[@]}"; do
      echo "== $unit"
      sudo journalctl -u "$unit" -n "$lines" --no-pager -o cat
    done ;;
  *) usage ;;
esac
