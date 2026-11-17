#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
port="${PORT:-3002}"
if [[ ! "$port" =~ ^[0-9]+$ ]]; then
  echo "Invalid PORT: $port" >&2
  exit 2
fi
pid_file="$root/runtime/server-$port.pid"
session_file="$root/runtime/server-$port.session"

if [[ ! -f "$pid_file" ]]; then
  rm -f -- "$session_file"
  echo "No QemuWeb server tracked on port $port."
  exit 0
fi

read -r pid < "$pid_file"
if [[ ! "$pid" =~ ^[0-9]+$ ]] || ! kill -0 "$pid" 2>/dev/null; then
  rm -f -- "$pid_file"
  rm -f -- "$session_file"
  rm -f -- "$root/runtime/runner-$port.sock"
  echo "No QemuWeb server running on port $port (stale PID removed)."
  exit 0
fi

# The server of this project: `node server/main.js` from the project directory, or by its absolute path.
is_server=0
mapfile -d '' -t args < "/proc/$pid/cmdline" 2>/dev/null || true
cwd="$(readlink -f -- "/proc/$pid/cwd" 2>/dev/null || true)"
for arg in "${args[@]:1}"; do
  if [[ "$arg" == "$root/server/main.js" || ( "$arg" == server/main.js && "$cwd" == "$root" ) ]]; then is_server=1; fi
done
if (( ! is_server )); then
  echo "PID $pid does not belong to this QemuWeb server; no process was stopped." >&2
  exit 1
fi

echo "Stopping QemuWeb on port $port (PID $pid)…"
kill -TERM "$pid"
for _ in {1..60}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f -- "$pid_file"
    rm -f -- "$session_file"
    echo 'QemuWeb stopped.'
    # A runner started by hand (./scripts/runner.sh) keeps its VMs and waits for a server again;
    # one started by start.sh (--exit-on-disconnect) stops them and exits by itself.
    while IFS= read -r runner; do
      [[ "$(readlink -f -- "/proc/$runner/cwd" 2>/dev/null || true)" == "$root" ]] || continue
      if [[ "$(tr '\0' ' ' < "/proc/$runner/cmdline" 2>/dev/null || true)" == *--exit-on-disconnect* ]]; then
        echo "The runner of start.sh (PID $runner) stops its machines and exits by itself."
      else
        echo "A runner (PID $runner) is still running on port $port: its VMs keep running. Stop it with Ctrl+C in its terminal, or ./scripts/killall.sh."
      fi
    done < <(pgrep -u "$(id -u)" -f "runner/main.js --port $port( |\$)" 2>/dev/null || true)
    exit 0
  fi
  sleep 0.2
done

echo 'QemuWeb is still shutting down; its nodes may need a little more time.' >&2
exit 1
