#!/usr/bin/env bash
# Demo of the Web interface on port 3003 or --listen PORT: separate, temporary users and runners files (never the
# repository's users.json and runners.json) with admin/admin (admin), toto/toto and tutu/tutu (students), and
# examples/lan.zip loaded and started in the sessions of toto and tutu. Passwords equal to logins
# exist only in this mode. Its sessions live in a temporary directory, so `scripts/status.sh` needs --all to see it.
#   ./scripts/demo.sh [--listen PORT] [--bind ADDRESS]
# --bind ADDRESS (default 127.0.0.1) is the server's: with another address (a LAN test, a remote runner that dials this machine) the demo
# is open to the network in clear text, with passwords equal to logins: a trusted LAN only (docs/remote-runner-test.md, variant C).
# Stop with Ctrl+C; scripts/stop.sh and scripts/status.sh also find the server.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$ROOT"
port=3003
bind=127.0.0.1
usage() { echo "Usage: $0 [--listen PORT] [--bind ADDRESS]"; }
while (( $# )); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --listen|--bind)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      if [[ "$1" == --listen ]]; then port="$2"; else bind="$2"; fi
      shift 2 ;;
    *) usage >&2; exit 2 ;;
  esac
done
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
  echo "Invalid port: $port (1 to 65535)" >&2
  exit 2
fi
# The address the local runner and this script reach the server on (the rule is common/bind.js, the same as start.sh's).
source "$ROOT/scripts/lib/runtime.sh"
host="$(local_runner_host "$bind")" || { echo "Invalid address for --bind: $bind (an IPv4 or IPv6 address, never a host name)" >&2; exit 2; }
loopback=0
if is_loopback_address "$bind"; then loopback=1; fi
url_host="$host"
[[ "$url_host" != *:* ]] || url_host="[$url_host]"

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
# The same two commands as scripts/start.sh (server and runner), with the temporary users and runners files and two temporary
# directories, one per process (the server's and the runner's own sessions, deleted when the demo stops; the defaults
# /tmp/qw-<login>/<port> and l-<port> would be shared with a start.sh on the same port).
mkdir -p "$demo_dir/server" "$demo_dir/runner"
./scripts/start.sh --listen "$port" --bind "$bind" --runtime "$demo_dir/server" --runner-runtime "$demo_dir/runner" --users "$demo_dir/users.json" --runners "$demo_dir/runners.json" &
demo_server_pid=$!
node scripts/demo.js load "http://$url_host:$port"

cat <<EOT

QemuWeb demo: http://$url_host:$port
  admin / admin   (admin)
  toto  / toto    (student, examples/lan.zip loaded and started)
  tutu  / tutu    (student, examples/lan.zip loaded and started)
Passwords equal to logins exist only in this demo mode's temporary users file.
Stop with Ctrl+C.
EOT
if (( ! loopback )); then
  if [[ "$bind" == 0.0.0.0 || "$bind" == :: ]]; then remote="<address of this machine>"; else remote="$url_host"; fi
  cat <<EOT

WARNING: the demo listens on $bind, in clear text (HTTP), with passwords equal to logins (admin is an administrator): use it only on a
trusted LAN. A runner on another machine registers with the token of /admin, Runners (admin / admin), then:
  ./scripts/runner.sh register --url http://$remote:$port --token TOKEN --insecure
  ./scripts/runner.sh run --url http://$remote:$port --insecure
EOT
fi
wait "$demo_server_pid"
