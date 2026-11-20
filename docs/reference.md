# Reference

Configuration files, command-line options of the server and the runners, and the maintenance scripts. The
web interface is described in the [user guide](user-guide.md).

## Configuration

| File | Purpose |
| --- | --- |
| [`config.json`](../config.json) | System catalog, base images, memory, and QEMU or VirtualBox options. `serialPorts` lists the serial ports of a system (`ttyS0`, `ttyS1`): QemuWeb turns each into a QEMU `-serial` option, in order. |
| [`.env`](../.env) | Executable names used by QemuWeb. |
| `.env.local` | Machine-specific overrides of `.env` (absolute paths); ignored by Git. |
| `users.json` | User accounts (see [Users and sessions](user-guide.md#users-and-sessions)); ignored by Git. |
| `runtime/sessions/<id>/` | One user's session: `session.json` (its definition, identical to the one in a ZIP archive), `meta.json` (its `owner` and creation date, never exported), `<host>/host.json`, `<host>/startup/start.sh`, `<switch>/switch.json`, working disks, and sockets. The ID is random. |
| `runtime/users/<login>` | Link to the user's session directory, for administrators. |
| `runtime/runner-<port>.sock` | Socket (mode 0600) that the runner, which runs the machines, dials to reach the server. |

`runtime/` is temporary: a node's files are removed with the node or when
the server stops. `./scripts/start.sh` (`npm start`) runs the server and a runner (`runner/main.js`)
as two processes and stops both together; if the runner dies, the server closes its sessions and
`start.sh` ends (nothing is restarted: that is systemd's job in a deployment). A runner started by
itself (`./scripts/runner.sh`) keeps its machines when the server restarts, and the server adopts
its sessions again (see [docs/deployment.md](deployment.md#the-runner-process)). Use **Save session** to keep a portable copy; archives do not
record the owner, so any user can load them.

## Server and runner command line

`scripts/server.sh` and `scripts/runner.sh` are thin front ends, identical in structure, to `node server/main.js` and
`node runner/main.js`: they refuse to run as root, move to the repository root and `exec` Node.js
with their arguments, so the process is the Node.js one (`./scripts/status.sh`, `stop.sh` and
`killall.sh` recognise it). They parse nothing: both programs share one command-line module
(`common/cli.js`) and behave the same way:

- `--help` (or `-h`, anywhere on the line) prints the usage, the options with their defaults and the
  environment variables, and exits with status 0. It is instant: nothing else is loaded.
- Any unknown option, missing value or invalid value is refused before anything starts, with
  `<program>: <message>` and a `Usage:` line on stderr, and exit status 2. A failure after a valid
  start (a check that fails, a port already in use) is `<program>: <message>` with exit status 1.
- At startup each program prints a banner (`QemuWeb <version> server|runner`), its `Options` (every
  option with the value in effect and where it comes from: `default`, `option` or `derived`), then
  `Checking dependencies…` and `Checking configuration…`, with `✓` (ok), `⚠` (warning), `✗`
  (failure, the program then stops with `Startup aborted`) and `-` (not applicable).

The port and the runtime directory are options (there is no environment variable for them). The server and the runner started
with the same `--runtime` (`runtime/` of the repository by default) share that directory: the server creates
`runner-<port>.sock` in it and the runner looks for it there. The server cleans the empty sessions and
aliases only of the local runner (the one on the Unix socket) whose `hello` announces the same runtime
directory; a runner with another `--runtime`, and every remote runner, is never touched, whatever its
`hello` says.

### Server: `./scripts/server.sh [options]`

The server is configured by options only: it reads **no environment variable**.

| Option | Default | Effect |
| --- | --- | --- |
| `--listen PORT` | `3002` | TCP port of the web interface on 127.0.0.1; also names <runtime>/runner-PORT.sock, the socket its runner dials |
| `--runtime DIR` | `runtime/ of the repository` | runtime directory: sessions of a local runner, users/ aliases, server-PORT.pid and .session, and the socket DIR/runner-PORT.sock |
| `--users FILE` | `users.json of the repository` | users file (mode 0600) |
| `--runners FILE` | `runners.json of the repository` | registered remote runners (mode 0600): a hash of the token of each |
| `--logs DIR` | `logs/ of the repository` | directory of admin.log and users.log (mode 0700) |
| `--session-hours N` | `12` | login lifetime in hours (more than 0, at most 2160), renewed while the user is active |
| `--runner-grace SECONDS` | `300` | how long the sessions of a remote runner that lost its connection are kept before they are dropped (0 to 86400; 0 drops them at once) |
| `--trust-proxy VALUE` | `unset` | Express "trust proxy" value behind a reverse proxy ("loopback", "true", a hop count or addresses), so that cookies get Secure over HTTPS |
| `--auth MODE` | `password` | how users are identified: password (QemuWeb login), proxy (identity given by an authenticating front end, for example Apache with mod_auth_openidc for OpenID, but also SAML, CAS, LDAP..., through X-Remote-User, trusted only with a shared X-Proxy-Key; no password login then) |
| `--proxy-key-file FILE` | `unset` | the key shared with the authenticating front end, sent by it as X-Proxy-Key: one line, or two during a rotation (mode 0600); required by --auth proxy |
| `--logout-url URL` | `unset` | where the Log out button goes when the identity comes from the authenticating front end (no button without it) |
| `--no-auth` | `off` | disables authentication: one shared local session, for single-user local work only (default: authentication on) |
| `--ephemeral` | `off` | marks an ephemeral server of the test scenarios (tests only) |
| `-h`, `--help` | | this text |

Environment variables: none (this program reads no environment variable).

`scripts/start.sh` accepts these server options and passes them on to the server (the runner gets `--port PORT`
from `--listen`, `--runtime DIR` and `--exit-on-disconnect`). `scripts/user.sh [--users FILE] <command>` manages the accounts of another users file.

```text
QemuWeb 0.9.1 server

Options
  --listen          3002                                       (default)
  --runtime         /home/me/qemuweb/runtime                   (default)
  --users           /home/me/qemuweb/users.json                (default)
  --runners         /home/me/qemuweb/runners.json              (default)
  --logs            /home/me/qemuweb/logs                      (default)
  --session-hours   12                                         (default)
  --runner-grace    300                                        (default)
  --trust-proxy     unset                                      (default)
  --auth            password                                   (default)
  --proxy-key-file  unset                                      (default)
  --logout-url      unset                                      (default)
  --no-auth         off                                        (default)
  --ephemeral       off                                        (default)
  Runner socket     /home/me/qemuweb/runtime/runner-3002.sock  (derived)

Checking dependencies…
  ✓ Node.js  /usr/bin/node  (v24.22.0, requires ^24.0.0)

Checking configuration…
  ✓ config.json  9 systems
  ✓ users.json  3 accounts
  ✓ runners.json  1 registered runner
  ✓ logs directory  /home/me/qemuweb/logs  (mode 0700)
  ✓ runtime directory  /home/me/qemuweb/runtime  (writable)

QemuWeb is ready.
  Web interface      http://127.0.0.1:3002
  Sessions           /home/me/qemuweb/runtime/sessions (<runtime>/users/<login> links)
  Stop               Ctrl+C or ./scripts/stop.sh
```

### Runner: `./scripts/runner.sh [options]`

The runner is an ordinary unprivileged process; every path is a parameter.

| Option | Default | Effect |
| --- | --- | --- |
| `--port PORT` | `3002` | port of the server to reach: the runner dials `DIR/runner-PORT.sock`, DIR being its `--runtime` |
| `--connect SOCKET` | `none` | Unix socket of the server, instead of `--port` (the two exclude each other) |
| `--runtime DIR` | `runtime/ of the repository` | where the runner keeps its sessions (`DIR/sessions/<id>/`) and looks for the server socket `DIR/runner-PORT.sock`; the server cleans the empty sessions it leaves there only with the same `--runtime` |
| `--config FILE` | `config.json of the repository` | system catalog (images, memory, QEMU options) |
| `--exit-on-disconnect` | `off` | stop every machine and exit when the server connection is lost (default: keep the sessions and reconnect every 2 seconds) |
| `-h`, `--help` | | this text |

| Variable | Default | Effect |
| --- | --- | --- |
| `QEMU_SYSTEM_X86_64, QEMU_IMG, VDE_SWITCH, VDETERM, GENISOIMAGE, NODE, PYTHON3, VBOXMANAGE, TCPDUMP` | names in `.env` | names or paths of the external programs: `.env.local`, then the environment, then the default of `.env`. The runner disables an engine whose programs are missing; a missing `tcpdump` (searched in `PATH`, then `/usr/sbin` and `/sbin`) only disables the live view of captures. |

The `Checking dependencies…` block shows, for each external program, the path found and the variable that
named it with its source (for example `QEMU_SYSTEM_X86_64=qemu-system-x86_64, .env`). The server runs no
external program, but it runs on Node.js: its block shows the Node.js in use and checks its version
against the range of `package.json`. After the checks the runner prints the state of its
connection (`Waiting for the server…`, `Connected to the server.`, `Connection to the server lost, reconnecting…`).

```text
QemuWeb 0.9.1 runner

Options
  --port                3002                                       (default)
  --runtime             /home/me/qemuweb/runtime                   (default)
  --config              /home/me/qemuweb/config.json               (default)
  --exit-on-disconnect  off                                        (default)
  Server socket         /home/me/qemuweb/runtime/runner-3002.sock  (derived)

Checking dependencies…
  ✓ QEMU           /usr/bin/qemu-system-x86_64  (QEMU_SYSTEM_X86_64=qemu-system-x86_64, .env)
  ✓ VDE switch     /usr/bin/vde_switch  (VDE_SWITCH=vde_switch, .env)
  …
  ✓ tcpdump        /usr/bin/tcpdump  (TCPDUMP=tcpdump, .env)

Checking configuration…
  ✓ config.json  9 systems

Waiting for the server at /home/me/qemuweb/runtime/runner-3002.sock…
Connected to the server.
```


### Remote runner: `./scripts/runner.sh register` and `run`

A runner on **another machine or account** connects to the server over the network, with its own
token, instead of the local Unix socket. It is for **trusted machines** until milestone 8 (jail and
quotas): it runs the machines of the sessions the server places on it under the account that starts
it, never root. The machine needs this repository (or a copy of `runner/`, `common/`, `scripts/` and
`config.json`), Node.js, QEMU, VDE and the images prepared there by `scripts/prepare.sh`; it needs no
inbound port. Setup, nginx and systemd are in [docs/deployment.md](deployment.md#remote-runners). A step-by-step test sheet with a diagram is in
[docs/remote-runner-test.md](remote-runner-test.md) ([PDF](pdf/remote-runner-test.pdf)).

1. An administrator opens **Runners** in `/admin` and creates a **registration token** (single use,
   valid 15 minutes, 1 hour or 24 hours); the page shows the command **once**.
2. On the runner machine: `./scripts/runner.sh register --url https://qemuweb.example.org --token TOKEN [--name NAME] [--ca FILE]`.
   The runner file (`~/.config/qemuweb-runner/runner.json`, or the file of `--runner-config`;
   directory 0700, file 0600) receives the server URL, the
   runner ID, the runner's own token, its name and optional limits
   (`"limits": {"maxSessions": 4, "memoryBytes": 17179869184, "cpus": 8}`, edited by hand).
3. `./scripts/runner.sh run` opens an outbound WebSocket (`/runner/connect`) and keeps it. A network cut
   stops no machine: the runner reconnects (2 s, doubling up to 30 s) and the server resynchronises.
   If the server refuses the token (revoked), the runner stops its machines and exits with status 1.

The server places each new session on the least loaded online runner that is not paused (the local
runner first on a tie); a session stays on its runner. While a remote runner is offline, its sessions
are kept for `--runner-grace` seconds and answer 503 "offline" (the page says "Runner offline,
reconnecting…"); then they are dropped. After a server restart a remote runner's sessions are not
adopted (only the local runner's are) and are deleted when it reconnects. `/admin` can pause (drain),
revoke and remove a runner; every action is in `admin.log`. `ws://` and `http://` URLs are accepted
only for this machine unless `--insecure` is given (with a warning).

`./scripts/runner.sh run [options]`:

| Option | Default | Effect |
| --- | --- | --- |
| `--runtime DIR` | `runtime/ of the repository` | where the runner keeps its sessions (DIR/sessions/<id>/); default: the "runtime" of the runner file, else this |
| `--config FILE` | `config.json of the repository` | system catalog (images, memory, QEMU options) |
| `--url URL` | `the runner file` | server URL (https://host); default: the one that register wrote in the runner file |
| `--ca FILE` | `none` | PEM file of the certificate authority that signed the server certificate (self-signed); default: the one of the runner file, else the system ones |
| `--insecure` | `off` | accepts a plain http:// or ws:// server URL that is not on this machine (the token and the traffic are then readable on the network) |
| `--runner-config FILE` | `~/.config/qemuweb-runner/runner.json` | runner file written by register: server URL, runner ID, token, name, limits |
| `-h`, `--help` | | this text |

`./scripts/runner.sh register [options]` (it also takes `--help`):

| Option | Default | Effect |
| --- | --- | --- |
| `--url URL` | `required` | server URL, for example https://qemuweb.example.org |
| `--token TOKEN` | `required` | registration token created in /admin/runners (single use, short lived) |
| `--name NAME` | `the runner ID` | name shown in /admin/runners (up to 64 characters) |
| `--ca FILE` | `none` | PEM file of the certificate authority that signed the server certificate (self-signed); kept in the runner file |
| `--insecure` | `off` | accepts a plain http:// or ws:// server URL that is not on this machine (the token and the traffic are then readable on the network) |
| `--runtime DIR` | `runtime/ of the repository` | sessions directory the runner will use, kept in the runner file; default: runtime/ of the repository where it runs |
| `--runner-config FILE` | `~/.config/qemuweb-runner/runner.json` | where to write the runner file (directory 0700, file 0600) |
| `-h`, `--help` | | this text |

The environment variables are those of the local runner above. The tokens are never printed: the
`Options` block shows `********` for `--token`, and the runner file is only reported by its path.

## Maintenance scripts

| Command | Effect |
| --- | --- |
| `scripts/user.sh <command>` | Manage user accounts in `users.json`. |
| `scripts/start.sh` | Start the server and a runner as two processes (`[server options]`, see above; lines prefixed `[server]` and `[runner]`). The only launch sequence, also used by `npm start`, `scripts/demo.sh` and the integration tests. Ctrl+C stops the runner (and its machines), then the server; if one of them dies, the other is stopped. |
| `scripts/server.sh` | Start the server alone (`[options]`, `--help` lists them), the counterpart of `runner.sh`: a front end to `node server/main.js` (see [Server and runner command line](#server-and-runner-command-line)). Ctrl+C stops it. |
| `scripts/runner.sh [options]` | Start a runner (`--port PORT` for the server to reach, default 3002; `--runtime DIR`; `--exit-on-disconnect`), the counterpart of `server.sh`. `runner.sh register` and `runner.sh run` are the form for a runner on another machine (see Remote runner). It prints its own checks, keeps its machines if the server restarts and reconnects. Ctrl+C stops it and its machines. |
| `scripts/stop.sh [--listen PORT] [--runtime DIR]` | Stop the server started on that port (default 3002); a runner started alone keeps running. |
| `scripts/killall.sh [--dry-run]` | Stop this project's servers, runner processes, QEMU processes, VDE switches and terminals, and VirtualBox VMs, including orphans. |
| `scripts/status.sh [--all] [--pid PID] [--details] [--watch [SECONDS]]` | Show (default `runtime/` only) the process tree of the QemuWeb servers, their runner, and the hosts and switches below, with memory and CPU use. `--watch` refreshes it. |
| `scripts/cleanall.sh [--dry-run] [--images] [--sources]` | Run `killall.sh`, then remove the default `runtime/` files and optionally images or downloads; `logs/` is always kept. |
| `scripts/demo.sh [--listen PORT]` | Start the application on port N (default 3003) with a temporary users file (`admin`, `toto`, `tutu`, passwords equal to logins) and `demo/lan.zip` loaded and started for `toto` and `tutu`. Ctrl+C stops it. See [test/tests.md](../test/tests.md#manual-tests-of-the-web-interface). |
| `make docs` | Build the PDF of every Markdown document (`README.md`, `docs/*.md`, `test/tests.md`, `deploy/cremi/deploy-cremi.md`) in `docs/pdf/`; only those whose source, style or diagrams changed (`npm run docs` is the same). |
| `scripts/md2pdf.sh IN.md OUT.pdf` | Build one PDF: pandoc turns the Markdown into HTML with the style `docs/doc.css`, headless Chrome prints it. |
