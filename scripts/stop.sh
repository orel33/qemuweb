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
  echo "No QemuWeb server running on port $port (stale PID removed)."
  exit 0
fi

is_matching_server() {
  local target_pid="$1"
  if [[ -d "/proc/$target_pid" ]]; then
    if [[ "$(readlink -f -- "/proc/$target_pid/cwd" 2>/dev/null || true)" == "$root" ]] &&
       [[ "$(tr '\0' ' ' < "/proc/$target_pid/cmdline" 2>/dev/null || true)" == *server.js* ]]; then
      return 0
    fi
    return 1
  fi
  # Fallback for systems without /proc (e.g. macOS)
  local cmd
  cmd="$(ps -p "$target_pid" -o args= 2>/dev/null || true)"
  if [[ "$cmd" == *server.js* ]]; then
    return 0
  fi
  return 1
}

if ! is_matching_server "$pid"; then
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
    exit 0
  fi
  sleep 0.2
done

echo 'QemuWeb is still shutting down; its sessions may need a little more time.' >&2
exit 1
