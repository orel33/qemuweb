#!/usr/bin/env bash
# Starts QemuWeb as two processes, the way a deployment does: the server (control plane) and a
# runner (the process that runs the machines), each as its own command. This is the only way to
# start QemuWeb here, in development and in the tests. Output lines are prefixed [server] and
# [runner].
#   ./scripts/start.sh [server options] [--runner-runtime DIR]   (--listen PORT, --runtime DIR, --local-runner, --users FILE, --runners FILE, --logs DIR, --examples DIR, --session-hours N, --runner-grace SECONDS,
#                                          --trust-proxy VALUE, --auth MODE, --proxy-key-file FILE, --logout-url URL, --no-auth, --ephemeral: see node server/main.js --help)
# The server gets all of them but --runner-runtime (plus --local-runner, and --runner-grace 0 unless given); the runner gets --port PORT
# (the server's --listen), --token-file FILE (local-runner.token in the SERVER's directory, which the server creates; the path only, never
# the token), --runtime DIR (--runner-runtime when given) and --exit-on-disconnect. Two directories, two owners: --runtime is the server's
# (default /tmp/qw-<login>/<port>), --runner-runtime the runner's (default /tmp/qw-<login>/l-<port>, never the server's), see common/runtime-dir.js;
# both are printed at start. The runner starts once the server listens on its port. A refused option is reported by the server (exit status 2, nothing started).
# Each process leads its own process group (setsid): a terminal Ctrl+C reaches this script only.
# Ctrl+C or SIGTERM stops the runner first (it stops every machine, within a bounded delay), kills
# what is left of its group (QEMU, vde_switch), then stops the server, and exits 0. When the
# runner ends for any reason (even SIGKILL), what is left of its group is killed at once. When
# the server or the runner exits by itself, the other is stopped and this script exits with
# the status of the one that ended. Nothing is ever restarted (that is systemd's job in a
# deployment, see docs/deployment.md).
# To keep the machines running while the server restarts, run ./scripts/server.sh and
# ./scripts/runner.sh yourself in two terminals.
set -euo pipefail

script_path="$(readlink -f -- "${BASH_SOURCE[0]}")"
root="$(cd -- "$(dirname -- "$script_path")/.." && pwd -P)"
cd -- "$root"
usage() {
  echo "Usage: $0 [server options]   (node server/main.js --help lists them; --listen PORT also goes to the runner) [--runner-runtime DIR]"
}
# The options are the server's: it validates them and refuses what it does not know (this script
# then ends with its status). Only --listen and --runtime are read here, for the runner and its token file; --runner-runtime is this script's own.
port=3002
runtime=''
runner_runtime=''
runner_given=0
runtime_given=0
grace_given=0
local_given=0
server_args=()
while (( $# )); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --listen|--runtime|--users|--runners|--logs|--examples|--session-hours|--runner-grace|--trust-proxy)
      server_args+=("$1")
      shift
      (( $# )) || break
      case "${server_args[-1]}" in
        --listen) port="$1" ;;
        --runner-grace) grace_given=1 ;;
        --runtime) runtime="$(realpath -m -- "$1")"; runtime_given=1 ;;
      esac
      server_args+=("$1")
      shift ;;
    --runner-runtime)
      shift
      (( $# )) || { echo "--runner-runtime requires a directory" >&2; exit 2; }
      runner_runtime="$(realpath -m -- "$1")"
      runner_given=1
      shift ;;
    --local-runner) local_given=1; server_args+=("$1"); shift ;;
    *) server_args+=("$1"); shift ;;
  esac
done

# The runner ends with the server (--exit-on-disconnect) and a runner that stopped is not coming back: unless the user
# gave --runner-grace, sessions are dropped at once (0). The same rule holds for every runner: the grace period only
# matters when the runner outlives the connection, which this script never does (a server-only restart needs server.sh
# and runner.sh in two terminals, see docs/deployment.md).
(( grace_given )) || server_args+=(--runner-grace 0)
# The local runner is the one this script starts: the server creates its token file.
(( local_given )) || server_args+=(--local-runner)

# The directories, from the same rules as the processes' own (common/runtime-dir.js; an invalid port is refused by the server):
# the server's (--runtime, else /tmp/qw-<login>/<port>) holds the token file the server creates (common/local-token.js), the runner's
# (--runner-runtime, else /tmp/qw-<login>/l-<port>) is its own.
source "$root/scripts/lib/runtime.sh"
runtime_args=()
runner_dir=''
token_file=''
if [[ "$port" =~ ^[0-9]+$ ]]; then
  [[ -n "$runtime" ]] || runtime="$(default_runtime "$port")"
  [[ -n "$runner_runtime" ]] || runner_runtime="$(default_runner_runtime "$port")"
fi
[[ -n "$runtime" ]] && token_file="$(local_runner_token_file "$runtime")"
[[ -z "$runner_runtime" ]] || runtime_args=(--runtime "$runner_runtime")
if [[ -n "$runtime" ]]; then
  echo "Server directory: $runtime"
  echo "Runner directory: ${runner_runtime}"
  # --runtime moved to the server's directory only (it also held the runner's sessions before the runner got its own directory).
  [[ "$runtime_given" != 1 || "$runner_given" == 1 ]] || echo "The runner keeps its sessions in $runner_runtime; add --runner-runtime DIR to move them."
fi

server_pid=''
runner_pid=''
stopping=0

# Waits up to $2 tenths of a second for the process $1 to end (bash reaps it: kill -0 then fails).
wait_gone() {
  local i
  for ((i = 0; i < $2; i++)); do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.1
  done
  return 1
}

# SIGKILL for what is left of the runner's process group (QEMU, vde_switch, vdeterm).
kill_runner_group() {
  [[ -n "$runner_pid" ]] && kill -KILL -- "-$runner_pid" 2>/dev/null || true
}

# The runner first: it stops every machine before it exits. Then its group, then the server.
stop_all() {
  (( stopping )) && return 0
  stopping=1
  trap - EXIT INT TERM
  if [[ -n "$runner_pid" ]]; then
    if kill -0 "$runner_pid" 2>/dev/null; then
      kill -TERM "$runner_pid" 2>/dev/null || true
      wait_gone "$runner_pid" 200 || true
    fi
    kill_runner_group
  fi
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait_gone "$server_pid" 150 || kill -KILL "$server_pid" 2>/dev/null || true
  fi
}
trap 'stop_all; exit 0' INT TERM
trap stop_all EXIT

# The runner starts once the server listens on its port (the token file exists by then: the server creates it before it
# listens). It would retry anyway, but a dead server must not leave it waiting: this script ends when either one exits.
setsid ./scripts/server.sh "${server_args[@]}" > >(sed -u 's/^/[server] /') 2>&1 &
server_pid=$!
listening=0
for _ in {1..150}; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then listening=1; break; fi
  kill -0 "$server_pid" 2>/dev/null || break
  sleep 0.2
done
if (( listening )) && [[ -n "$token_file" ]] && kill -0 "$server_pid" 2>/dev/null; then
  setsid ./scripts/runner.sh --port "$port" --token-file "$token_file" "${runtime_args[@]}" --exit-on-disconnect > >(sed -u 's/^/[runner] /') 2>&1 &
  runner_pid=$!
elif kill -0 "$server_pid" 2>/dev/null; then
  echo "The server does not listen on port $port after 30 seconds; stopping it." >&2
  stop_all
  exit 1
fi

while kill -0 "$server_pid" 2>/dev/null && [[ -n "$runner_pid" ]] && kill -0 "$runner_pid" 2>/dev/null; do sleep 0.5; done

# One of them ended by itself: its status is ours.
status=0
if ! kill -0 "$server_pid" 2>/dev/null; then
  wait "$server_pid" 2>/dev/null || status=$?
  echo "The server exited (status $status); stopping the runner." >&2
else
  wait "$runner_pid" 2>/dev/null || status=$?
  note=''
  (( status != 78 )) || note=', the server refused its token'
  echo "The runner exited (status $status$note); stopping the server." >&2
fi
stop_all
exit "$status"
