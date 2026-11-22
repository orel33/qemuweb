# Sourced by start.sh, stop.sh, killall.sh and cleanall.sh. The rule of the default runtime directory
# (/tmp/qw-<login>/<port>, see common/runtime-dir.js) and the one of the token file (common/local-token.js) live in those files only: these functions ask them.

# default_runtime PORT|runner: the default runtime directory of a server port (nothing is created).
default_runtime() {
  node "$(dirname -- "${BASH_SOURCE[0]}")/../../common/runtime-dir.js" path "$1"
}

# local_runner_token_file DIR: the token file of the local runner in the server's runtime directory DIR (the rule is common/local-token.js).
local_runner_token_file() {
  node "$(dirname -- "${BASH_SOURCE[0]}")/../../common/local-token.js" path "$1"
}

# default_account_root: /tmp/qw-<login>, the directory that holds the default runtime directories of this account.
default_account_root() {
  dirname -- "$(default_runtime runner)"
}
