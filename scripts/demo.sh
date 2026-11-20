#!/usr/bin/env bash
# Demo of the Web interface on port 3003 or --listen PORT: a separate, temporary users file (never the
# repository's users.json) with admin/admin (admin), toto/toto and tutu/tutu (students), and
# examples/lan.zip loaded and started in the sessions of toto and tutu. Passwords equal to logins
# exist only in this mode. Its sessions live in a temporary directory, so `scripts/status.sh` needs --all to see it.
#   ./scripts/demo.sh [--listen PORT]
# Stop with Ctrl+C; scripts/stop.sh and scripts/status.sh also find the server.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$ROOT"
port=3003
case "${1:-}" in
  '') ;;
  -h|--help) echo "Usage: $0 [--listen PORT]"; exit 0 ;;
  --listen) [[ $# -eq 2 ]] || { echo "Usage: $0 [--listen PORT]" >&2; exit 2; }; port="$2" ;;
  *) echo "Usage: $0 [--listen PORT]" >&2; exit 2 ;;
esac
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
  echo "Invalid port: $port (1 to 65535)" >&2
  exit 2
fi

demo_server_pid=''
demo_dir="$(mktemp -d "${TMPDIR:-/tmp}/qemuweb-demo-XXXXXX")"

# Stops start.sh (it stops the runner, which stops the nodes, then the server) and deletes the temporary users file.
cleanup() {
  trap - EXIT
  if [[ -n "$demo_server_pid" ]] && kill -0 "$demo_server_pid" 2>/dev/null; then
    kill -TERM "$demo_server_pid" 2>/dev/null || true
    wait "$demo_server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$demo_dir"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

printf '\n== QemuWeb demo on port %s ==\n' "$port"
node scripts/demo.js prepare "$demo_dir/users.json"
# The same two commands as scripts/start.sh (server and runner), with the temporary users file and a
# temporary runtime directory (its own sessions, deleted when the demo stops; the default
# /tmp/qw-<login>/<port> would be shared with a start.sh on the same port).
mkdir -p "$demo_dir/runtime"
./scripts/start.sh --listen "$port" --runtime "$demo_dir/runtime" --users "$demo_dir/users.json" &
demo_server_pid=$!
node scripts/demo.js load "http://127.0.0.1:$port"

cat <<EOT

QemuWeb demo: http://127.0.0.1:$port
  admin / admin   (admin)
  toto  / toto    (student, examples/lan.zip loaded and started)
  tutu  / tutu    (student, examples/lan.zip loaded and started)
Passwords equal to logins exist only in this demo mode's temporary users file.
Stop with Ctrl+C.
EOT
wait "$demo_server_pid"
