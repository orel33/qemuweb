# <img src="public/favicon.svg" alt="" width="32" height="32"> QemuWeb

QemuWeb lets you create and control Linux machines running in QEMU or VirtualBox
from a browser. Connect them through VDE switches, use their serial consoles,
and import or export sessions and network topologies.

## Quick start

QemuWeb targets **Ubuntu 24.04 on x86-64**.

1. Install the system packages. `build-essential` and `python3` are needed to
   compile `node-pty`, which has no Linux prebuild:

   ```sh
   sudo apt install bash build-essential coreutils findutils grep gzip curl git python3 qemu-system-x86 qemu-utils genisoimage vde2
   ```

2. Install **Node.js 24 LTS** with npm. Ubuntu's `nodejs` package is too old,
   and `npm ci` fails with `EBADENGINE` on other Node versions. Use one of:

   ```sh
   nvm install                 # with nvm; reads .nvmrc
   sudo n 24                   # with n
   ```

   Or use the [official download](https://nodejs.org/en/download). Then check
   that `node --version` prints `v24.x` (run `hash -r` first if the shell still
   finds the old version).

3. Check QEMU prerequisites:
   - `qemu-system-x86_64 -netdev help` must list `vde`. If it does not, see
     [QEMU without VDE support](#qemu-without-vde-support).
   - Your user must be able to read and write `/dev/kvm`. If not, run
     `sudo usermod -aG kvm $USER` and log in again.

4. Clone, install, prepare one image, and start:

   ```sh
   git clone https://github.com/orel33/qemuweb.git
   cd qemuweb
   npm ci
   bash scripts/prepare.sh --system alpine
   ./scripts/user.sh add alice      # create your account; prompts for a password
   ./start.sh
   ```

Open <http://127.0.0.1:3002> and log in. Press `Ctrl+C` to stop the server, or
use `./start.sh --listen 3003` to choose another port. `./start.sh` starts two processes, the server and a
runner (the process that runs the machines), each as its own command, with output lines prefixed
`[server]` and `[runner]`; stopping it stops both, and if one of them dies the other is stopped. To keep the machines running when the server
restarts, run `./scripts/server.sh` in one terminal and `./scripts/runner.sh` in another (see
[docs/deployment.md](docs/deployment.md#the-runner-process)).

The server listens only on `127.0.0.1`. To use it from another machine, forward
the port over SSH (`ssh -L 3002:127.0.0.1:3002 <server>`) or put it behind
nginx with TLS: see [docs/deployment.md](docs/deployment.md).

VirtualBox is optional: install it separately to provide `VBoxManage`. The
VirtualBox engine is disabled in the Web interface when `VBoxManage` is
unavailable.

### Starting the server and the runner by hand

`./start.sh` is the same as these two commands, run in two terminals from the
repository root (port 3002 and `runtime/` of the repository by default, for both):

```sh
./scripts/server.sh                          # terminal 1: the server (web interface, accounts, sessions)
./scripts/runner.sh                          # terminal 2: the runner (QEMU and VDE processes)
./scripts/server.sh --listen 3003            # another port: the runner names the same one
./scripts/runner.sh --port 3003
```

The runner connects to the server of its `--port` and reconnects by itself, so
the two can start in either order. Run it as your normal user, never as root.
`./scripts/runner.sh --exit-on-disconnect` makes it stop its machines and exit
when the server goes away, which is what `./start.sh` does. `--help` of either script lists its
options; a refused option prints `<program>: <message>` and a `Usage:` line, exits with status 2 and starts nothing
(see [Server and runner command line](#server-and-runner-command-line)).

| To | Command |
|---|---|
| Stop the server only; the runner keeps the machines and waits for a new server | `Ctrl+C` in terminal 1, or `./scripts/stop.sh` (with `--listen PORT` if needed) |
| Stop the runner and all its machines | `Ctrl+C` in terminal 2 |
| See the servers, runners and machines of this project | `./scripts/status.sh` (`-w` to refresh, `--all` for other projects) |
| Stop everything, including leftovers after a crash | `./scripts/killall.sh` |

After a server restart, the runner's sessions are adopted again: users find
their machines still running.

## Users and sessions

Each user logs in with a login and a password and always finds the same
session: its hosts, switches, consoles and logs. The session lives on the
server, independently of the browser: closing the tab or logging out stops
nothing, and several tabs of one user share the session. It disappears only
when the user deletes it (**Delete session**, the red trash button at the end of the bottom-left toolbar) or when the server
stops, which stops every machine.

The bottom-left toolbar also has **Resume all** (start every stopped switch,
then every stopped host, as when a session is loaded), **Stop all** (stop every
host and switch; the nodes and their disks are kept) and **Remove all hosts and
switches**. Both skip a node whose start, stop or reboot is in progress.

Accounts live in `users.json` at the repository root (mode 0600, ignored by
Git; `--users FILE` of the server (and of `scripts/user.sh`) selects another file, and
[`users.example.json`](users.example.json) shows the layout). Passwords are
stored as `scrypt` hashes. Manage them with `scripts/user.sh`:

```sh
./scripts/user.sh add alice                 # prompts for the password twice
./scripts/user.sh add bob --role admin      # roles: student (default) or admin
./scripts/user.sh passwd alice              # change a password
./scripts/user.sh role alice admin          # change a role
./scripts/user.sh remove alice              # delete the account
./scripts/user.sh disable alice             # refuse logins and cookies; the session stays
./scripts/user.sh enable alice              # allow a disabled account again
./scripts/user.sh list                      # logins, roles and disabled accounts (never the passwords)
./scripts/user.sh import-csv class.csv      # lines: login,password[,role]
```

| Command | What it does |
| --- | --- |
| `add <login> [--role student\|admin]` | Creates an account. It fails if the login already exists: use `passwd` to change the password. To add an account again after `remove`, simply run `add` again. |
| `passwd <login>` | Sets a new password for an existing account. |
| `role <login> student\|admin` | Changes the role of an existing account. |
| `remove <login>` | Deletes the account: the user can no longer log in and their cookie stops working at once. The script does not touch a running server: the session is **not** deleted, its machines keep running until it is deleted (from `/admin`) or the server restarts. If you `add` the same login again while the server is still running, that account finds the old session again. **Remove** in `/admin` also deletes the session. |
| `disable <login>` | Disables the account (`"disabled": true` in `users.json`): the user can no longer log in, their cookie is refused at once, and their open consoles are closed at their next action. Their session stays until an admin deletes it. |
| `enable <login>` | Allows a disabled account again. |
| `list` | Prints one `login<TAB>role` line per account, followed by `<TAB>disabled` for a disabled one. |
| `import-csv <file>` | Reads `login,password[,role]` lines (an optional header line is accepted). New logins are added, existing ones get the new password and role. |

For scripts, the password can come from the variable `QEMUWEB_PASSWORD` (never the command line) or from the first
line of standard input; otherwise the script prompts for it. Logins use letters, digits, `.`, `_`, `-` and `@` (up to
64 characters). Changes apply without restarting the server.

### Administration

`admin` is a role of an ordinary account: an admin has their own session and
works in it normally. At the top right of the header, admins have a button to
the other page: **Supervision** (`/admin`) from their session or an observed
one, **My session** (`/`) from `/admin`. (The view toggle, at the bottom
right, shows the view it switches to: **Graphic** or **Terminals**.) `/admin` lists every session, the admin's own marked, refreshed
every few seconds: user, state (**active**: at least one running node, or
**idle**), creation date, nodes, running VMs, reserved RAM, CPU and last
activity (the owner's requests and console input; an admin observing does not
count). Next to each user, a green dot shows **online** when a browser of that
user is connected (**online ×n** for several tabs; the tooltip gives the count),
or **offline**; the admin's own row is online. A session lives on the server
whether or not its user is connected: it is created at the user's first
request and kept after logging out or closing the browser. From there an admin
can:

- **Observe** a session: `/?observe=<login>` opens the normal interface on the
  student's session, read-only: the same buttons as the student's page, the
  write actions greyed out instead of hidden. A banner of
  distinct colour shows the observed user, previous/next active session, a
  session list, **Follow**, **Take control** and **My session**; **Supervision**
  stays in the header.
  The admin sees the consoles live (what the guest echoes, so not a password
  typed without echo), their history and logs, also when the student is
  offline. With **Follow** on (the default), the view follows what the student
  shows: the selected node, Terminals or Graphic, and the console layout (1
  terminal, 2 side by side or stacked, or 4; which node each pane shows, switch
  consoles, the view of each pane: Console ttyS0/ttyS1, Monitor or Log (an observer sees a followed Monitor as the console)), and the admin's own view controls are
  disabled (one driver at a time); off, the admin navigates freely from the
  view shown. An observation tab never saves its layout in the admin's
  view settings. The target belongs to the tab: another tab can stay on the admin's
  own session. A login without a session (not used since the server started,
  or deleted) shows a message and a link back to **Supervision**. The server refuses every change from an observer, including
  console input, Clear and resizing.
- **Take control** of the student's session: an exclusive lock on the whole
  session (Follow is forced on and the student's current view applied first; the
  Follow box stays checked and disabled while control is held). The student's keyboard is blocked on every console and a banner
  tells them who controls it; they still see the commands and their output.
  The admin types into whatever console they display. While the admin holds
  control, the student's page follows the admin's view and layout (the reverse
  of **Follow**, pane views included) and its view, layout and pane view buttons are disabled. Control ends
  with **Release control**, when the admin's last page on that session closes
  (changing the layout keeps it), or after 10 minutes without input; the student's page then keeps what it shows and is free
  again.
- **Stop all** VMs and switches of a session (nodes kept) or **Delete** it
  (disks included); the student's browsers reload into a new, empty session.
- Delete several sessions at once (select them, then **Delete selected**,
  confirmed on the listed sessions). The admin's own session cannot be
  selected.
- Manage accounts: **Create account** (login, password, role), reset a
  password, change the role, disable or enable, and **Remove** an account:
  it disappears from `users.json`, its pages are logged out at once and its
  session, if any, is deleted with its machines. An admin cannot disable,
  remove or change the role of their own account there.
- Read the last 200 entries of the two server logs in the **Logs** panel at
  the bottom of the page (**Admin** and **Users** tabs), or **Download** them.

Every administration action is written to `logs/admin.log`, an audit log of
administrator actions; user events (logins, sessions, nodes started or
stopped, archives) go to `logs/users.log` (see
[docs/deployment.md](docs/deployment.md#server-logs)). With `--no-auth`,
the implicit local user is admin, so `/admin` is open to anyone reaching the
server.

Until per-user quotas, command restrictions and cross-site request checks
exist (milestone 6), give accounts only to trusted users: any user can run any
single-line QEMU monitor command on their own hosts. Log out only clears the
browser's cookie; see [docs/deployment.md](docs/deployment.md#known-limits).

| Server option | Default | Effect |
| --- | --- | --- |
| `--users FILE` | `users.json` | Users file. |
| `--session-hours N` | `12` | Login lifetime, renewed while the user is active. |
| `--trust-proxy VALUE` | unset | Express `trust proxy` value behind a reverse proxy (for example `loopback`), so that cookies get `Secure` over HTTPS. |
| `--no-auth` | authentication on | Disables authentication: one shared local session, for single-user local work only. |
| `--logs DIR` | `logs` | Directory of the server logs (created with mode 0700): `admin.log`, the audit log of administrator actions, and `users.log`, the user events (JSON lines, mode 0600). |

With `--no-auth`, the server prints a warning at startup and the
interface shows **Authentication disabled**. It is never the default.

## Using QemuWeb

### Included LAN demo

1. Prepare the Debian Legacy image: `bash scripts/prepare.sh --system debian13-legacy`.
2. In the Web interface, choose an engine in **General Settings**, click
   **Load session ZIP**, and select [`demo/lan.zip`](demo/lan.zip).
3. Start the hosts and the switch. Their startup scripts assign `192.168.0.x`
   addresses to the four hosts. Open their consoles and `ping` between them.

The archive contains settings and startup scripts but no working disks, so hosts
start from fresh images. [`demo/`](demo/) also contains DMZ and gateway sessions
(`dmz0.zip`, `dmz1.zip`, `gw0.zip`, `gw1.zip`).

### Sessions and topologies

- **Save session** exports hosts, switches, settings, and startup scripts as a
  ZIP archive; **Load session ZIP** restores it.
- Choosing a ZIP opens a review dialog: it summarizes the archive (hosts,
  switches, hosts with a startup disk, working disks) and warns when a base image
  changed since the session was saved and the archive contains working disks
  (qcow2) for it: those disks cannot be reused, so **Discard working disks** is
  then checked and locked. Two options apply on **OK**: **Start hosts and
  switches after loading** (default) and **Discard working disks** (greyed when the
  archive has none); **Cancel** uploads nothing. Each host with a
  working disk records, in its `host.json`, the base image it depends on (format, size
  and SHA-256). Hosts without a working disk simply start from the current image,
  without a warning (image builds are not reproducible, so the hash differs from one
  machine to another).
- **Load topology** reads a `.topo` text file that describes only hosts,
  switches, and their links, without disks or startup scripts. Examples:
  [`demo/lan.topo`](demo/lan.topo), [`demo/dmz.topo`](demo/dmz.topo),
  [`demo/gw.topo`](demo/gw.topo).

### Startup scripts

Each host can run `start.sh` at boot from an automatically built startup disk.
Enable **Auto-build and attach startup disk** in **Host Settings → Startup**,
then edit `start.sh`. The default script uses placeholders replaced for each
host:

```sh
#!/bin/sh
hostname @HOSTNAME@
ifconfig @IFNAME0@ 192.168.0.@SWPORT0@ netmask 255.255.255.0 up
```

To ship another file, such as `firewall.sh`, use **Add extra files** in the same
tab and call it from `start.sh`, for example `sh /mnt/cdrom/firewall.sh`. Each
extra file is limited to 1 MiB, and all startup files together to 4 MiB. Save
the settings and restart the host to use the rebuilt disk.

## Images

`scripts/prepare.sh` prepares the systems listed in [`config.json`](config.json):
Alpine Linux 3.24, Debian 13 Cloud, Debian 13 Legacy, and OpenWrt 25.12.

```sh
bash scripts/prepare.sh                      # all systems
bash scripts/prepare.sh --system <id>        # alpine, debian13-cloud, debian13-legacy, openwrt
bash scripts/prepare.sh --list               # show prepared images
bash scripts/prepare.sh --hash               # record image hashes without building
bash scripts/prepare.sh --system <id> --force  # rebuild one system
```

Downloads go to `sources/<system>/`. Each system gets a RAW base image for QEMU
and a VDI base image for VirtualBox in `images/`; VirtualBox is not needed to
build them. Existing images are reused. `--force` keeps the previous RAW/VDI
pair in `images/backups/`; stop the system's machines first, because their
working disks depend on the base image.

Each build also records `images/<system>.raw.sha256` and `.vdi.sha256` (the output of
`sha256sum`, so `cd images && sha256sum -c alpine.raw.sha256` verifies one). The server
uses a hash file that is not older than its image to compare the image with a session
archive without reading several gigabytes; a missing, malformed or older file is ignored
and the image is hashed instead (asynchronously). `bash scripts/prepare.sh --hash`
records them for existing images without rebuilding anything. Restore an image from
`images/backups/` together with its `.sha256` file, since an older image is not detected
when its newer hash file is left in place.

Guests log in as `root` without a password on the serial console.

Debian hosts have two serial ports (`ttyS0` and `ttyS1`) so that two
commands can run at once, for example `ping` on the first and `tcpdump` on the
second. Choose what a pane shows with its view selector: **Console (ttyS0)**,
**Console (ttyS1)** (only for hosts that have it), **Monitor** or **Log**;
the program running on the other console keeps running. **Host Settings →
Console** lists the console sockets (`serial0.sock`, `serial1.sock`) and the
monitor socket. Alpine, OpenWrt and
VirtualBox hosts have a single console. Debian images prepared before this
feature have no login on `ttyS1`: run `scripts/prepare.sh` again.

## Configuration

| File | Purpose |
| --- | --- |
| [`config.json`](config.json) | System catalog, base images, memory, and QEMU or VirtualBox options. `serialPorts` lists the serial ports of a system (`ttyS0`, `ttyS1`): QemuWeb turns each into a QEMU `-serial` option, in order. |
| [`.env`](.env) | Executable names used by QemuWeb. |
| `.env.local` | Machine-specific overrides of `.env` (absolute paths); ignored by Git. |
| `users.json` | User accounts (see [Users and sessions](#users-and-sessions)); ignored by Git. |
| `runtime/sessions/<id>/` | One user's session: `session.json` (its definition, identical to the one in a ZIP archive), `meta.json` (its `owner` and creation date, never exported), `<host>/host.json`, `<host>/startup/start.sh`, `<switch>/switch.json`, working disks, and sockets. The ID is random. |
| `runtime/users/<login>` | Link to the user's session directory, for administrators. |
| `runtime/runner-<port>.sock` | Socket (mode 0600) that the runner, which runs the machines, dials to reach the server. |

`runtime/` is temporary: a node's files are removed with the node or when
the server stops. `./scripts/start.sh` (`npm start`) runs the server and a runner (`runner/main.js`)
as two processes and stops both together; if the runner dies, the server closes its sessions and
`start.sh` ends (nothing is restarted: that is systemd's job in a deployment). A runner started by
itself (`./scripts/runner.sh`) keeps its machines when the server restarts, and the server adopts
its sessions again (see [docs/deployment.md](docs/deployment.md#the-runner-process)). Use **Save session** to keep a portable copy; archives do not
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
aliases only of a runner whose `hello` announces the same runtime directory; a runner with another
`--runtime` is never touched.

### Server: `./scripts/server.sh [options]`

The server is configured by options only: it reads **no environment variable**.

| Option | Default | Effect |
| --- | --- | --- |
| `--listen PORT` | `3002` | TCP port of the web interface on `127.0.0.1`; also names `<runtime>/runner-PORT.sock`, the socket its runner dials |
| `--runtime DIR` | `runtime/ of the repository` | runtime directory: sessions of a local runner, `users/` aliases, `server-PORT.pid` and `.session`, and the socket `DIR/runner-PORT.sock` |
| `--users FILE` | `users.json of the repository` | users file (mode 0600) |
| `--logs DIR` | `logs/ of the repository` | directory of `admin.log` and `users.log` (mode 0700) |
| `--session-hours N` | `12` | login lifetime in hours (more than 0, at most 2160), renewed while the user is active |
| `--trust-proxy VALUE` | `unset` | Express "trust proxy" value behind a reverse proxy ("loopback", "true", a hop count or addresses), so that cookies get Secure over HTTPS |
| `--no-auth` | `off` | disables authentication: one shared local session, for single-user local work only (default: authentication on) |
| `--ephemeral` | `off` | marks an ephemeral server of the test scenarios (tests only) |
| `-h`, `--help` | | this text |

Environment variables: none (this program reads no environment variable).

`scripts/start.sh` accepts these server options and passes them on to the server (the runner gets `--port PORT`
from `--listen`, `--runtime DIR` and `--exit-on-disconnect`). `scripts/user.sh [--users FILE] <command>` manages the accounts of another users file.

```text
QemuWeb 0.9.0-beta.4.4 server

Options
  --listen         3002                                       (default)
  --runtime        /home/me/qemuweb/runtime                   (default)
  --users          /home/me/qemuweb/users.json                (default)
  --logs           /home/me/qemuweb/logs                      (default)
  --session-hours  12                                         (default)
  --trust-proxy    unset                                      (default)
  --no-auth        off                                        (default)
  --ephemeral      off                                        (default)
  Runner socket    /home/me/qemuweb/runtime/runner-3002.sock  (derived)

Checking dependencies…
  ✓ Node.js  /usr/bin/node  (v24.22.0, requires ^24.0.0)

Checking configuration…
  ✓ config.json  9 systems
  ✓ users.json  3 accounts
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
| `QEMU_SYSTEM_X86_64, QEMU_IMG, VDE_SWITCH, VDETERM, GENISOIMAGE, NODE, PYTHON3, VBOXMANAGE` | names in `.env` | names or paths of the external programs: `.env.local`, then the environment, then the default of `.env`. The runner disables an engine whose programs are missing. |

The `Checking dependencies…` block shows, for each external program, the path found and the variable that
named it with its source (for example `QEMU_SYSTEM_X86_64=qemu-system-x86_64, .env`). The server runs no
external program, but it runs on Node.js: its block shows the Node.js in use and checks its version
against the range of `package.json`. After the checks the runner prints the state of its
connection (`Waiting for the server…`, `Connected to the server.`, `Connection to the server lost, reconnecting…`).

```text
QemuWeb 0.9.0-beta.4.4 runner

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

Checking configuration…
  ✓ config.json  9 systems

Waiting for the server at /home/me/qemuweb/runtime/runner-3002.sock…
Connected to the server.
```

## Maintenance scripts

| Command | Effect |
| --- | --- |
| `scripts/user.sh <command>` | Manage user accounts in `users.json`. |
| `scripts/start.sh` | Start the server and a runner as two processes (`[server options]`, see above; lines prefixed `[server]` and `[runner]`). The only launch sequence, also used by `npm start`, `scripts/demo.sh` and the integration tests. Ctrl+C stops the runner (and its machines), then the server; if one of them dies, the other is stopped. |
| `scripts/server.sh` | Start the server alone (`[options]`, `--help` lists them), the counterpart of `runner.sh`: a front end to `node server/main.js` (see [Server and runner command line](#server-and-runner-command-line)). Ctrl+C stops it. |
| `scripts/runner.sh [options]` | Start a runner (`--port PORT` for the server to reach, default 3002; `--runtime DIR`; `--exit-on-disconnect`), the counterpart of `server.sh`. It prints its own checks, keeps its machines if the server restarts and reconnects. Ctrl+C stops it and its machines. |
| `scripts/stop.sh [--listen PORT] [--runtime DIR]` | Stop the server started on that port (default 3002); a runner started alone keeps running. |
| `scripts/killall.sh [--dry-run]` | Stop this project's servers, runner processes, QEMU processes, VDE switches and terminals, and VirtualBox VMs, including orphans. |
| `scripts/status.sh [--all] [--pid PID] [--details] [--watch [SECONDS]]` | Show (default `runtime/` only) the process tree of the QemuWeb servers, their runner, and the hosts and switches below, with memory and CPU use. `--watch` refreshes it. |
| `scripts/cleanall.sh [--dry-run] [--images] [--sources]` | Run `killall.sh`, then remove the default `runtime/` files and optionally images or downloads; `logs/` is always kept. |
| `scripts/demo.sh [--listen PORT]` | Start the application on port N (default 3003) with a temporary users file (`admin`, `toto`, `tutu`, passwords equal to logins) and `demo/lan.zip` loaded and started for `toto` and `tutu`. Ctrl+C stops it. See [test/TESTS.md](test/TESTS.md#manual-tests-of-the-web-interface). |

## Development

| Path | Role |
| --- | --- |
| `server/` | The server (control plane), `node server/main.js`, symmetric to `runner/`: startup (a runner dials in, see `scripts/start.sh`) in `main.js`, session manager (one session per user), runner client, registry, runner gateway, server instance records, audit logs. |
| `server/routes/` | HTTP API of one session (`server/routes/index.js` builds one router per session), by area: settings, nodes, hosts, topology, archives, metrics. Each route sends one command to the session's runner. |
| `server/sockets.js` | Socket.IO consoles; forwards each runner's events to the browsers of its session only. |
| `runner/` | The runner, a separate process (`runner/main.js`) serving every session of the machine over the runner protocol: QEMU, VirtualBox, VDE switches, consoles, startup media, archives, metrics. |
| `server/auth/` | Authentication: users file, password hashes, signed cookie. |
| `scripts/user.sh`, `scripts/user.js` | User account administration. |
| `scripts/demo.sh`, `scripts/demo.js` | Web demo with test accounts and `demo/lan.zip`. |
| `common/` | Code shared by the runner and the server: runner protocol framing, IDs, launch settings, `config.json` validation, `.topo` parsing. |
| `public/` | Web interface: `index.html`, `css/app.css`, ES modules started by `app.js`, xterm.js terminals, network graph. |
| `scripts/prepare/` | One image preparation script per system. |
| `demo/` | Example sessions (`.zip`) and topologies (`.topo`): LAN, DMZ and gateway. |

See [docs/architecture.md](docs/architecture.md) for the data paths between the
browser, the server, and QEMU, VirtualBox, and VDE.

Tests:

```sh
npm test                          # unit tests only
./scripts/run-tests.sh --list     # unit and integration scenarios
```

Integration tests log in with a temporary users file; most need prepared
images, QEMU with VDE, and usually KVM. See
[test/TESTS.md](test/TESTS.md) for each scenario and its prerequisites.

## Troubleshooting

### QEMU without VDE support

Ubuntu 24.04's packaged QEMU may lack the VDE network backend. Build a
compatible binary with the [QEMU installation notes](misc/install-qemu.md), then
create `.env.local` in the repository root:

```text
QEMU_SYSTEM_X86_64=/opt/qemu-<version>/bin/qemu-system-x86_64
```

This overrides only `QEMU_SYSTEM_X86_64`; `qemu-img` still comes from the
distribution. Check that `/opt/qemu-<version>/bin/qemu-system-x86_64 -netdev help`
lists `vde`, then run `./start.sh` again.

### Port already in use

Another QemuWeb server is probably running. Stop it with `scripts/stop.sh`, or
start on another port with `./start.sh --listen 3003`.
