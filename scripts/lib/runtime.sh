# Sourced by start.sh, stop.sh, killall.sh and cleanall.sh. The rule of the default runtime directories
# (/tmp/qw-<login>/<port> for the server, /tmp/qw-<login>/l-<port> for the local runner, see common/runtime-dir.js) and the one of
# the token file (common/local-token.js) live in those files only: these functions ask them.

# default_runtime PORT: the default directory of the server that listens on PORT (nothing is created).
default_runtime() {
  node "$(dirname -- "${BASH_SOURCE[0]}")/../../common/runtime-dir.js" path server "$1"
}

# default_runner_runtime PORT: the default directory of the local runner that dials the server on PORT (nothing is created).
default_runner_runtime() {
  node "$(dirname -- "${BASH_SOURCE[0]}")/../../common/runtime-dir.js" path local "$1"
}

# local_runner_token_file DIR: the token file of the local runner in the server's runtime directory DIR (the rule is common/local-token.js).
local_runner_token_file() {
  node "$(dirname -- "${BASH_SOURCE[0]}")/../../common/local-token.js" path "$1"
}

# local_runner_host BIND: the address the local runner dials for a server bound to BIND (the rule is common/bind.js: a wildcard is
# reached on 127.0.0.1, a specific address on itself). Fails (status 2) when BIND is not an IPv4 or IPv6 address.
local_runner_host() {
  node "$(dirname -- "${BASH_SOURCE[0]}")/../../common/bind.js" runner-host "$1"
}

# is_loopback_address ADDRESS: succeeds for a loopback address (common/bind.js).
is_loopback_address() {
  node "$(dirname -- "${BASH_SOURCE[0]}")/../../common/bind.js" is-loopback "$1"
}

# default_account_root: /tmp/qw-<login>, the directory that holds every default runtime directory of this account.
default_account_root() {
  node "$(dirname -- "${BASH_SOURCE[0]}")/../../common/runtime-dir.js" root
}
