#!/usr/bin/env bash
# Starts QemuWeb as two processes, the way a deployment does: the server (control plane) and a
# runner (the process that runs the machines), each as its own command. Output lines are
# prefixed [server] and [runner]. Ctrl+C or SIGTERM stops both (the runner stops its machines);
# if one of them exits, the other is stopped and this script exits with its status.
#   ./scripts/start.sh            PORT=3003 ./scripts/start.sh to choose another port
# To keep the machines running while the server restarts, run `node server.js` and
# ./scripts/runner.sh yourself in two terminals (see docs/deployment.md).
set -euo pipefail

script_path="$(readlink -f -- "${BASH_SOURCE[0]}")"
root="$(cd -- "$(dirname -- "$script_path")/.." && pwd -P)"
port="${PORT:-3002}"
if [[ ! "$port" =~ ^[0-9]+$ ]]; then
  echo "Invalid PORT: $port" >&2
  exit 2
fi
cd -- "$root"

server_pid=''
runner_pid=''
stopping=0

# The runner first: it stops every machine before it exits. Then the server.
stop_all() {
  (( stopping )) && return 0
  stopping=1
  trap - EXIT INT TERM
  if [[ -n "$runner_pid" ]] && kill -0 "$runner_pid" 2>/dev/null; then kill -TERM "$runner_pid" 2>/dev/null || true; fi
  if [[ -n "$runner_pid" ]]; then wait "$runner_pid" 2>/dev/null || true; fi
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then kill -TERM "$server_pid" 2>/dev/null || true; fi
  if [[ -n "$server_pid" ]]; then wait "$server_pid" 2>/dev/null || true; fi
}
trap 'stop_all; exit 130' INT
trap 'stop_all; exit 143' TERM
trap stop_all EXIT

# The server listens on runtime/runner-<port>.sock. A runner started with --exit-on-disconnect does
# not retry a first connection that fails, so it starts once the socket exists (a dead server
# takes its runner with it, and the script ends when either one exits).
node server.js > >(sed -u 's/^/[server] /') 2>&1 &
server_pid=$!
for _ in {1..150}; do
  [[ -S "$root/runtime/runner-$port.sock" ]] && break
  kill -0 "$server_pid" 2>/dev/null || break
  sleep 0.2
done
if kill -0 "$server_pid" 2>/dev/null; then
  ./scripts/runner.sh --exit-on-disconnect > >(sed -u 's/^/[runner] /') 2>&1 &
  runner_pid=$!
fi

while kill -0 "$server_pid" 2>/dev/null && [[ -n "$runner_pid" ]] && kill -0 "$runner_pid" 2>/dev/null; do sleep 0.5; done

status=0
if ! kill -0 "$server_pid" 2>/dev/null; then
  wait "$server_pid" 2>/dev/null || status=$?
  echo "The server exited (status $status); stopping the runner." >&2
else
  wait "$runner_pid" 2>/dev/null || status=$?
  echo "The runner exited (status $status); stopping the server." >&2
fi
exit "$status"
