# Sourced by start.sh, stop.sh, killall.sh and cleanall.sh. The rule of the default runtime directory
# (/tmp/qw-<login>/<port>, see common/runtime-dir.js) lives in that file only: these functions ask it.

# default_runtime PORT|runner: the default runtime directory of a server port (nothing is created).
default_runtime() {
  node "$(dirname -- "${BASH_SOURCE[0]}")/../../common/runtime-dir.js" path "$1"
}

# default_account_root: /tmp/qw-<login>, the directory that holds the default runtime directories of this account.
default_account_root() {
  dirname -- "$(default_runtime runner)"
}
