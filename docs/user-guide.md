# User guide

Using QemuWeb from the browser, and managing its accounts and sessions. Installation is in
[install](install.md), the options of the programs in [reference](reference.md).

## Users and sessions

Each user logs in (with a login and a password, or through the authenticating front end, see
[How to log in](#how-to-log-in)) and always finds the same
session: its hosts, switches, consoles and logs. The session lives on the
server, independently of the browser: closing the tab or logging out stops
nothing, and several tabs of one user share the session. It disappears only
when the user deletes it (**Delete session**, the red trash button at the end of the bottom-left toolbar) or when the server
stops, which stops every machine.

The bottom-left toolbar also has **Resume all** (start every stopped switch,
then every stopped host, as when a session is loaded), **Stop all** (stop every
host and switch; the nodes and their disks are kept) and **Remove all hosts and
switches**. Both skip a node whose start, stop or reboot is in progress.

### How to log in

By default (`--auth password`) a user logs in with a login and a password of `users.json`. At the CREMI, QemuWeb runs
with `--auth both` behind Apache and the OpenID of the CREMI, and there are two ways in to the same server and the same
sessions (one session per login, whatever the way in):

- **Students: through Apache and OpenID** (`https://qemuweb.emi.u-bordeaux.fr/`). The user logs in once, at the CREMI;
  QemuWeb then trusts the identity that Apache gives (`X-Remote-User`) and never shows its own login page. The header shows the
  login (and the display name when the front end gives one); **Log out** goes to the OpenID logout (`--logout-url`; no button
  without it). A login that is not in `users.json` is a **student**: nothing has to be created for a student. It is
  trusted only on a request that carries the key shared with Apache (`X-Proxy-Key`, `--proxy-key-file`); a header sent
  without the key is ignored, whatever its address, and a wrong key is refused (403, written to `users.log`).
- **Administrators: the same way, and also by an SSH tunnel.** An administrator is an account of `users.json` with the role
  `admin`: through OpenID their CREMI login is recognised as administrator (add it with
  `scripts/user.sh add LOGIN --role admin --no-password`). For the administration of the server itself, an SSH
  tunnel to `127.0.0.1:3002` (or a local browser) reaches QemuWeb without the key: the QemuWeb login page, and the password
  of an account that has one (`scripts/user.sh add admin --role admin`) apply.

Logging out of the front end (here OpenID) does not delete the QemuWeb session: the machines keep running, and the next
login finds the same session (**Delete session** is the only way to remove it, apart from an admin).

`--auth proxy` means that the identity is given by an authenticating front end (here Apache with mod_auth_openidc; it could be SAML, CAS, LDAP...) through `X-Remote-User`, trusted only with the shared `X-Proxy-Key`; the mode accepts only that identity (no login page, no password). A `disabled` account of `users.json` is refused
through the front end too, and an account added with `--no-password` that is `disabled` is the way to refuse one student.

Accounts live in `users.json` at the repository root (mode 0600, ignored by
Git; `--users FILE` of the server (and of `scripts/user.sh`) selects another file, and
[`users.example.json`](../users.example.json) shows the layout). Passwords are
stored as `scrypt` hashes. Manage them with `scripts/user.sh`:

```sh
./scripts/user.sh add alice                 # prompts for the password twice
./scripts/user.sh add bob --role admin      # roles: student (default) or admin
./scripts/user.sh add carol --role admin --no-password   # no password: recognised through the front end only
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
| `add <login> [--role student\|admin] [--no-password]` | Creates an account. It fails if the login already exists: use `passwd` to change the password. To add an account again after `remove`, simply run `add` again. With `--no-password` no password is asked and none is stored: the account cannot log in with a password and is only recognised, for its role and its `disabled` flag, when the authenticating front end gives its login. |
| `passwd <login>` | Sets a new password for an existing account. Refused for an account without a password: `remove` it and `add` it again. |
| `role <login> student\|admin` | Changes the role of an existing account. |
| `remove <login>` | Deletes the account: the user can no longer log in and their cookie stops working at once. The script does not touch a running server: the session is **not** deleted, its machines keep running until it is deleted (from `/admin`) or the server restarts. If you `add` the same login again while the server is still running, that account finds the old session again. **Remove** in `/admin` also deletes the session. |
| `disable <login>` | Disables the account (`"disabled": true` in `users.json`): the user can no longer log in, their cookie is refused at once, and their open consoles are closed at their next action. Their session stays until an admin deletes it. |
| `enable <login>` | Allows a disabled account again. |
| `list` | Prints one `login<TAB>role` line per account, followed by `<TAB>disabled` for a disabled one and `<TAB>no password` for an account without password. |
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
- Manage accounts: **Create account** (login, password, role; the option **No password**
  creates an account that is recognised through the front end only), reset a
  password (not offered for an account without password), change the role, disable or enable, and **Remove** an account:
  it disappears from `users.json`, its pages are logged out at once and its
  session, if any, is deleted with its machines. An admin cannot disable,
  remove or change the role of their own account there.
- See which transport each browser connection really uses in the **Connections**
  panel: one line per live Socket.IO connection (login, **WebSocket** or
  **polling**, connected since, and whether it is the **main** connection of a
  tab, an **observer** or a console connection), refreshed with the rest of the
  page, with a summary such as "7 connections: 6 WebSocket, 1 polling". The
  interface always asks for WebSocket first. A connection on **polling** works,
  but slower (every keystroke and every console line is a separate HTTP
  request), and the panel then shows a warning: usually the reverse proxy does
  not forward `Upgrade` and `Connection`. **Test WebSocket** opens a test
  connection from your own browser, forced to WebSocket, and shows "WebSocket
  OK" with the average and minimum round trip time, or why it failed; if it
  failed it also tries polling and says whether the interface runs in fallback
  mode. The test creates no session. The server also writes one line to its
  output when a connection is still on polling 20 seconds after it connected
  (see [docs/deployment.md](deployment.md#websocket-check)).
- Read the last 200 entries of the two server logs in the **Logs** panel at
  the bottom of the page (**Admin** and **Users** tabs), or **Download** them.

Every administration action is written to `logs/admin.log`, an audit log of
administrator actions; user events (logins, sessions, nodes started or
stopped, archives) go to `logs/users.log` (see
[docs/deployment.md](deployment.md#server-logs)). With `--no-auth`,
the implicit local user is admin, so `/admin` is open to anyone reaching the
server.

Until per-user quotas, command restrictions and cross-site request checks
exist (milestone 6), give accounts only to trusted users: any user can run any
single-line QEMU monitor command on their own hosts. Log out only clears the
browser's cookie (and, behind OpenID, ends the OpenID session); see [docs/deployment.md](deployment.md#known-limits).

| Server option | Default | Effect |
| --- | --- | --- |
| `--users FILE` | `users.json` | Users file. |
| `--session-hours N` | `12` | Login lifetime, renewed while the user is active. |
| `--trust-proxy VALUE` | unset | Express `trust proxy` value behind a reverse proxy (for example `loopback`), so that cookies get `Secure` over HTTPS. |
| `--auth MODE` | `password` | `password`, `proxy` (the identity is given by an authenticating front end, for example Apache with mod_auth_openidc for OpenID, but also SAML, CAS, LDAP..., through `X-Remote-User`, trusted only with the shared `X-Proxy-Key`) or `both`. |
| `--proxy-key-file FILE` | unset | The shared key, one line, mode 0600; required by `proxy` and `both`. |
| `--logout-url URL` | unset | Where **Log out** goes for an identity from the authenticating front end. |
| `--no-auth` | authentication on | Disables authentication: one shared local session, for single-user local work only. |
| `--logs DIR` | `logs` | Directory of the server logs (created with mode 0700): `admin.log`, the audit log of administrator actions, and `users.log`, the user events (JSON lines, mode 0600). |

With `--no-auth`, the server prints a warning at startup and the
interface shows **Authentication disabled**. It is never the default.

## Using QemuWeb

### Included LAN demo

1. Prepare the Debian Legacy image: `bash scripts/prepare.sh --system debian13-legacy`.
2. In the Web interface, choose an engine in **General Settings**, click
   **Load session ZIP**, and select [`demo/lan.zip`](../demo/lan.zip).
3. Start the hosts and the switch. Their startup scripts assign `192.168.0.x`
   addresses to the four hosts. Open their consoles and `ping` between them.

The archive contains settings and startup scripts but no working disks, so hosts
start from fresh images. [`demo/`](../demo/) also contains DMZ and gateway sessions
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
  [`demo/lan.topo`](../demo/lan.topo), [`demo/dmz.topo`](../demo/dmz.topo),
  [`demo/gw.topo`](../demo/gw.topo).

### Graphic view

The **Graphic** button (bottom right) shows the network as a diagram; **Terminals** goes
back. Each card shows the node name, its system, its state, and for a host its memory,
vCPUs and how many interfaces are linked (for a switch, how many ports are in use). No IP
address is shown: QemuWeb does not know the guests' addresses. Hovering a card lists
everything, including each interface's switch and port.

- **Move the view**: drag the background to pan, use the mouse wheel to zoom around the
  pointer, or the zoom buttons (`+`, `-` and `0` on the keyboard). **Fit to view** shows the
  whole network. The canvas has no edge: a node can be dragged anywhere you can see, at any
  zoom level. Positions are saved in this browser; nodes you have not moved are placed
  automatically (a layered layout that limits crossings), and a loaded topology gets a fresh
  layout.
- **Select**: a click selects a node, like its tab in the Terminals view (the selected node is
  highlighted and is the one the toolbar actions apply to).
- **Console**: a double click (or Enter on a focused card) opens the node's console as a
  floating window over the graph. It is the normal console pane (views, actions, font size);
  an administrator observing a session sees it read-only, and **Take control** applies to it
  as in the Terminals view. Drag its title bar to move it, its bottom right corner to resize
  it, and use the close button to dismiss it. Opening a console selects the node, which can
  change the page shown in the Terminals view.
- **Edit** (greyed out when observing): **Host** and **Switch** add a node where you click next
  (the usual dialog opens first). **Connect** links a host interface to a switch: click a
  host, choose its interface (or a new one), then click a switch; clicking a switch first
  also works. Click a link to select it, then **Remove link** disconnects that interface
  (the interface itself stays; remove it in Host Settings). A running host needs a restart
  for the change to apply, as in Host Settings. `Esc` cancels an editing mode.

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
