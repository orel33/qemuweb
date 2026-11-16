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
use `PORT=3003 ./start.sh` to choose another port.

The server listens only on `127.0.0.1`. To use it from another machine, forward
the port over SSH (`ssh -L 3002:127.0.0.1:3002 <server>`) or put it behind
nginx with TLS: see [docs/deployment.md](docs/deployment.md).

VirtualBox is optional: install it separately to provide `VBoxManage`. The
VirtualBox engine is disabled in the Web interface when `VBoxManage` is
unavailable.

## Users and sessions

Each user logs in with a login and a password and always finds the same
session: its hosts, switches, consoles and logs. The session lives on the
server, independently of the browser: closing the tab or logging out stops
nothing, and several tabs of one user share the session. It disappears only
when the user deletes it (**Delete session**, the red trash button at the end of the bottom-left toolbar) or when the server
stops, which stops every machine.

Accounts live in `users.json` at the repository root (mode 0600, ignored by
Git; `QEMUWEB_USERS_FILE` selects another file, and
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

For scripts, the password can come from `QEMUWEB_PASSWORD` or from the first
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
  student's session, read-only, with the admin's own layout. A banner of
  distinct colour shows the observed user, previous/next active session, a
  session list, **Follow**, **Take control** and **My session**; **Supervision**
  stays in the header.
  The admin sees the consoles live (what the guest echoes, so not a password
  typed without echo), their history and logs, also when the student is
  offline. With **Follow** on (the default), the view follows what the student
  shows: the selected node, Terminals or Graphic, and the console layout (1
  terminal, 2 side by side or stacked, or 4; switch consoles, page, a pane
  shown alone); off, the admin
  navigates freely. An observation tab never saves its layout in the admin's
  view settings. The target belongs to the tab: another tab can stay on the admin's
  own session. A login without a session (not used since the server started,
  or deleted) shows a message and a link back to **Supervision**. The server refuses every change from an observer, including
  console input, Clear and resizing.
- **Take control** of the student's session: an exclusive lock on the whole
  session. The student's keyboard is blocked on every console and a banner
  tells them who controls it; they still see the commands and their output.
  The admin types into whatever console they display. While the admin holds
  control, the student's page follows the admin's view and layout (the reverse
  of **Follow**) and its view and layout buttons are disabled. Control ends
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
[docs/deployment.md](docs/deployment.md#server-logs)). With `QEMUWEB_AUTH=off`,
the implicit local user is admin, so `/admin` is open to anyone reaching the
server.

Until per-user quotas, command restrictions and cross-site request checks
exist (milestone 6), give accounts only to trusted users: any user can run any
single-line QEMU monitor command on their own hosts. Log out only clears the
browser's cookie; see [docs/deployment.md](docs/deployment.md#known-limits).

| Variable | Default | Effect |
| --- | --- | --- |
| `QEMUWEB_USERS_FILE` | `users.json` | Users file. |
| `QEMUWEB_SESSION_HOURS` | `12` | Login lifetime, renewed while the user is active. |
| `QEMUWEB_TRUST_PROXY` | unset | Express `trust proxy` value behind a reverse proxy (for example `loopback`), so that cookies get `Secure` over HTTPS. |
| `QEMUWEB_AUTH` | `password` | `off` disables authentication: one shared local session, for single-user local work only. |
| `QEMUWEB_LOG_DIR` | `logs` | Directory of the server logs (created with mode 0700): `admin.log`, the audit log of administrator actions, and `users.log`, the user events (JSON lines, mode 0600). |

With `QEMUWEB_AUTH=off`, the server prints a warning at startup and the
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
- Before loading, the dialog summarizes the archive and warns when a base image
  changed since the session was saved and the archive contains working disks
  (qcow2) for it: those disks are discarded, never reused. Each host with a
  working disk records, in its `host.json`, the base image it depends on (format, size
  and SHA-256). Hosts without a working disk simply start from the current image,
  without a warning (image builds are not reproducible, so the hash differs from one
  machine to another).
- **Load topology** reads a `.topo` text file that describes only hosts,
  switches, and their links, without disks or startup scripts. Examples:
  [`topo/lan.topo`](topo/lan.topo), [`topo/dmz.topo`](topo/dmz.topo),
  [`topo/gw.topo`](topo/gw.topo).

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

## Configuration

| File | Purpose |
| --- | --- |
| [`config.json`](config.json) | System catalog, base images, memory, and QEMU or VirtualBox options. |
| [`.env`](.env) | Executable names used by QemuWeb. |
| `.env.local` | Machine-specific overrides of `.env` (absolute paths); ignored by Git. |
| `users.json` | User accounts (see [Users and sessions](#users-and-sessions)); ignored by Git. |
| `runtime/sessions/<id>/` | One user's session: `session.json` (its definition, identical to the one in a ZIP archive), `meta.json` (its `owner` and creation date, never exported), `<host>/host.json`, `<host>/startup/start.sh`, `<switch>/switch.json`, working disks, and sockets. The ID is random. |
| `runtime/users/<login>` | Link to the user's session directory, for administrators. |

`runtime/` is temporary: a node's files are removed with the node or when
the server stops. Use **Save session** to keep a portable copy; archives do not
record the owner, so any user can load them.

## Maintenance scripts

| Command | Effect |
| --- | --- |
| `scripts/user.sh <command>` | Manage user accounts in `users.json`. |
| `scripts/stop.sh` | Stop the server started on `PORT` (default 3002). |
| `scripts/killall.sh [--dry-run]` | Stop this project's servers, QEMU processes, and VirtualBox VMs, including orphans. |
| `scripts/cleanall.sh [--dry-run] [--images] [--sources]` | Run `killall.sh`, then remove `runtime/` files and optionally images or downloads. |

## Development

| Path | Role |
| --- | --- |
| `server.js` | Startup: preflight, authentication, session manager, HTTP routes and Socket.IO wiring. |
| `routes/` | HTTP API of one session (`routes/index.js` builds one router per session), by area: settings, nodes, hosts, topology, archives, metrics. |
| `sockets.js` | Socket.IO consoles; forwards each runner's events to the browsers of its session only. |
| `runner/` | Node processes behind the facade `runner/index.js`, one runner instance per session: QEMU, VirtualBox, VDE switches, consoles, startup media, metrics. |
| `lib/` | Session manager (one session per user), session, server instance records, session ZIP archives and snapshots, `.topo` parsing. |
| `lib/auth/` | Authentication: users file, password hashes, signed cookie. |
| `scripts/user.sh`, `scripts/user.js` | User account administration. |
| `common/` | Code shared by the runner and the server: IDs, launch settings, `config.json` validation. |
| `public/` | Web interface: `index.html`, `css/app.css`, ES modules started by `app.js`, xterm.js terminals, network graph. |
| `scripts/prepare/` | One image preparation script per system. |

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
start on another port with `PORT=3003 ./start.sh`.
