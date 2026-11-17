#!/usr/bin/env bash
# Print the process tree of the QemuWeb servers of the current user: each server, its local
# runner (when the version has one), and the QEMU, vde_switch and vdeterm processes below it.
#   scripts/tree.sh                 print the tree once
#   scripts/tree.sh --watch [SECS]  refresh every SECS seconds (default 2) until Ctrl+C
# A server is a node process running a server.js that sits next to lib/session-manager.js, in
# any directory (a test server started from a /tmp export is shown too). A runner whose server
# is gone is listed as an orphan.
set -euo pipefail

INTERVAL=2
WATCH=0
case "${1:-}" in
  '') ;;
  --watch)
    WATCH=1
    if [[ -n ${2:-} ]]; then
      [[ $2 =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "Usage: $0 [--watch [SECONDS]]" >&2; exit 2; }
      INTERVAL="$2"
    fi
    ;;
  -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "Usage: $0 [--watch [SECONDS]]" >&2; exit 2 ;;
esac

# "<pid> <root>" for every QemuWeb server of this user.
servers() {
  local pid rest arg root
  while read -r pid rest; do
    [[ "$(basename -- "${rest%% *}")" == node ]] || continue
    for arg in $rest; do
      [[ "$arg" == server.js || "$arg" == */server.js ]] || continue
      if [[ "$arg" == /* ]]; then root="${arg%/server.js}"; else root="$(readlink -f -- "/proc/$pid/cwd" 2>/dev/null || true)"; fi
      if [[ -n "$root" && -f "$root/lib/session-manager.js" ]]; then printf '%s %s\n' "$pid" "$root"; fi
      break
    done
  done < <(pgrep -u "$UID" -a -f "server.js|runner/main.js" || true)
}

# PIDs of runner processes (node .../runner/main.js) owned by this user.
runners() {
  local pid rest arg
  while read -r pid rest; do
    [[ "$(basename -- "${rest%% *}")" == node ]] || continue
    for arg in $rest; do
      if [[ "$arg" == */runner/main.js ]]; then printf '%s\n' "$pid"; break; fi
    done
  done < <(pgrep -u "$UID" -a -f "server.js|runner/main.js" || true)
}

# Listening TCP port of a PID, when ss can tell.
listening_port() {
  ss -H -ltnp 2>/dev/null | awk -v pid="$1" '$0 ~ ("pid=" pid ",") { n = split($4, a, ":"); print a[n]; exit }'
}

# One-line summary of what runs below a PID.
summary() {
  ps -eo pid=,ppid=,comm= | awk -v root="$1" '
    { parent[$1] = $2; name[$1] = $3 }
    END {
      for (p in parent) {
        for (q = p; q != "" && q != 0 && q != root; q = parent[q]) ;
        if (q == root && p != root) {
          if (name[p] ~ /^qemu-system/) vms++
          else if (name[p] == "vde_switch") switches++
          else if (name[p] == "vdeterm") terminals++
        }
      }
      printf "%d QEMU, %d vde_switch, %d vdeterm\n", vms, switches, terminals
    }'
}

# The tree of one PID: pstree when installed, ps otherwise. Lines are cut to the terminal width.
tree() {
  local pid="$1" width="${COLUMNS:-$(tput cols 2>/dev/null || echo 200)}"
  if command -v pstree >/dev/null 2>&1; then
    pstree -a -p -g -T -l "$pid" | sed 's/MainThread,/node,/' | cut -c "1-$width"
  else
    ps -o pid,ppid,pgid,args --forest -ww --sid "$(ps -o sid= -p "$pid" | tr -d ' ')" | cut -c "1-$width"
  fi
}

report() {
  local pid root port count=0
  local -A known=()
  echo "QemuWeb processes of $USER at $(date '+%H:%M:%S')"
  while read -r pid root; do
    [[ -n "$pid" ]] || continue
    count=$((count + 1))
    known[$pid]=1
    port="$(listening_port "$pid")"
    echo
    echo "Server $pid${port:+ on port $port} ($root): $(summary "$pid")"
    tree "$pid"
  done < <(servers)
  # A runner whose parent is not one of the servers above is an orphan.
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    local parent
    parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    [[ -n "${known[$parent]:-}" ]] && continue
    count=$((count + 1))
    echo
    echo "Orphan runner $pid (no server above it): $(summary "$pid")"
    tree "$pid"
  done < <(runners)
  (( count )) || { echo; echo "No QemuWeb server or runner is running."; }
}

if (( WATCH )); then
  trap 'exit 0' INT TERM
  while true; do
    frame="$(report)"
    printf '\033[H\033[2J%s\n\nRefreshing every %ss, Ctrl+C to quit.\n' "$frame" "$INTERVAL"
    sleep "$INTERVAL"
  done
else
  report
fi
