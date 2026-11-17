#!/usr/bin/env bash
# Demo of the Web interface on PORT (default 3003): a separate, temporary users file (never the
# repository's users.json) with admin/admin (admin), toto/toto and tutu/tutu (students), and
# demo/lan.zip loaded and started in the sessions of toto and tutu. Passwords equal to logins
# exist only in this mode. Stop with Ctrl+C; scripts/stop.sh and scripts/tree.sh also find the server.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$ROOT"
PORT="${PORT:-3003}"
if [[ ! "$PORT" =~ ^[0-9]+$ ]]; then
  echo "Invalid PORT: $PORT" >&2
  exit 2
fi

demo_server_pid=''
demo_dir="$(mktemp -d "${TMPDIR:-/tmp}/qemuweb-demo-XXXXXX")"

# Stops the server (it removes its sessions and nodes, and stops its runner) and deletes the temporary users file.
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

printf '\n== QemuWeb demo on port %s ==\n' "$PORT"
node scripts/demo.js prepare "$demo_dir/users.json"
PORT="$PORT" QEMUWEB_USERS_FILE="$demo_dir/users.json" node server.js &
demo_server_pid=$!
node scripts/demo.js load "http://127.0.0.1:$PORT"

cat <<EOT

QemuWeb demo: http://127.0.0.1:$PORT
  admin / admin   (admin)
  toto  / toto    (student, demo/lan.zip loaded and started)
  tutu  / tutu    (student, demo/lan.zip loaded and started)
Passwords equal to logins exist only in this demo mode's temporary users file.
Stop with Ctrl+C.
EOT
wait "$demo_server_pid"
