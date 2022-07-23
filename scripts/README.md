# Server scripts

## Session scripts

This scripts achieve session persistance and isolement based on *tmux* + *firejail*.

```bash
$ ./scripts/session-start.sh <sessionid>
$ ./scripts/session-run-cmd.sh <sessionid> <cmd> <args ...>
$ ./scripts/session-killall.sh <sessionid>
```

## Qemunet Scripts

This script is a light version of *Qemunet* dedicated to Linux VM (in mode text)...

```bash
$ ./scripts/qemunet-start.sh <sessionid>
$ ./scripts/qemunet-switch.sh <sessionid> <switchname>
$ ./scripts/qemunet-host.sh <sessionid> <sysname> <hostname> <switch0>:<port0> <switch1>:<port1> [...]
$ ./scripts/qemunet-exit.sh <sessionid>
```

## On-Run Algorithm

```
# init session
node.js -> pty.spawn() -> ./scripts/session-start.sh <sessionid>
node.js -> pty.spawn() -> ./scripts/session-run-cmd.sh ./scripts/qemunet-start.sh <sessionid>

# for all virtual switches, run...
node.js -> pty.spawn() -> ./scripts/session-run-cmd.sh ./scripts/qemunet-switch.sh <sessionid> <switchname>

# for all virtual hosts, run...
node.js -> pty.spawn() -> ./scripts/session-run-cmd.sh ./scripts/qemunet-host.sh <sessionid> <sysname> <hostname> <switch0>[:<port0>] <switch1>[:<port1>] [...]

# kill session
node.js -> pty.spawn() -> ./scripts/session-run-cmd.sh ./scripts/qemunet-exit.sh <sessionid> # not really useful
node.js -> pty.spawn() -> ./scripts/session-killall.sh <sessionid>
```

---
