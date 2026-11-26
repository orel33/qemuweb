# User guide

Using QemuWeb from the browser, and managing its accounts and sessions. Installation is in
[install](install.md), the options of the programs in [reference](reference.md).

## Users and sessions

Each user logs in (with a login and a password, or through the authenticating front end, see
[How to log in](#how-to-log-in)) and always has exactly one session, from the login on: there is
nothing to create, the session is simply empty at first. It holds the user's hosts, switches,
consoles and logs. The session lives on the server, independently of the browser: closing the tab
or logging out stops nothing, and several tabs of one user share the session.

A session runs on a runner (a machine that executes the virtual machines), chosen when the session
first needs one: when its first host or switch is created, or a topology, an example or a session
ZIP is loaded. An empty session needs no runner. If no runner is available at that moment, the
creation or the load answers *No runner is available*; reading the empty session never does.

The bottom-left toolbar also has **Resume all** (start every stopped switch,
then every stopped host, as when a session is loaded), **Stop all** (stop every
host and switch; the nodes and their disks are kept) and **Reset session**, the red trash
button at its end: after a confirmation it stops and removes every host and switch, with their
working disks, consoles and logs; the session stays, empty (it keeps its engine). Resume all and
Stop all skip a node whose start, stop or reboot is in progress. Reset session is the only
destructive action of a user; an administrator can also delete a user's session from the admin
page (the user's next request then finds a new, empty session).

### How to log in

Two modes exist. By default (`--auth password`) a user logs in with a login and a password of `users.json`; this is the mode
of local tests, of an ad hoc server and of the emergency procedure. At the CREMI, QemuWeb runs with `--auth proxy` behind
Apache and the OpenID of the CREMI: the front end does the login and there is **no password login at all** (no login page,
`/auth/login` answers 404). One session per login, whatever the mode.

- **Users and administrators: through Apache and OpenID** (`https://qemuweb.emi.u-bordeaux.fr/`). The user logs in once, at the CREMI;
  QemuWeb then trusts the identity that Apache gives (`X-Remote-User`). The header shows the
  login (and the display name when the front end gives one); **Log out** goes to the OpenID logout (`--logout-url`; no button
  without it). A login that is not in `users.json` is a **student**: nothing has to be created for a student. An administrator is
  an account of `users.json` with the role `admin` (add it with `scripts/user.sh add LOGIN --role admin --no-password`). The identity is
  trusted only on a request that carries a key shared with Apache (`X-Proxy-Key`, `--proxy-key-file`); a request without the
  key has no identity (401), a header sent without the key is ignored, whatever its address, and a wrong key is refused (403, written to `users.log`).
- **The SSH tunnel to port 3002 gives 401 in `proxy` mode**, by design: it carries no key. If OpenID is down, restart the server
  in `password` mode (see "Emergency: password mode" in `deploy/cremi/deploy-cremi.md`) and log in with a password account.
- **An expired OpenID session.** When the session of the front end expires while the page is open, its API calls answer 401: the page
  reloads once, and Apache then sends the user to the CREMI login. A second 401 within 30 seconds is not followed by another reload: the usual error is shown.

Logging out of the front end (here OpenID) does not delete the QemuWeb session: the machines keep running, and the next
login finds the same session (**Reset session** empties it; only an administrator deletes it).

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
the other page: **Admin** (`/admin`) from their session or an observed
one, **My session** (`/`) from `/admin`. (The view toggle, at the bottom
right, shows the view it switches to: **Graphic** or **Terminals**.) `/admin` shows one section at a time, chosen in a tab bar under
the header: **Sessions** (the default), **Accounts**, **Runners**, **WebSocket** and **Logs**. The tab is kept in the URL fragment
(`/admin#runners`, `#accounts`, `#websocket`, `#logs`, `#sessions`): a reload or a shared link returns to that tab, and an
unknown fragment means Sessions. The tabs follow the usual keyboard rules (Left and Right move between tabs, Home and End jump to
the first and last, Enter or Space activates). Only the visible tab refreshes (every few seconds, and at once when it opens),
and nothing refreshes while the browser tab is in the background. A badge on a tab label shows a problem without opening it,
refreshed about every 30 seconds: **Runners** counts the runners offline or paused (amber when one is offline), **WebSocket**
the connections on polling (amber), **Sessions** the sessions with a running node, **Accounts** the disabled accounts.
**Sessions** lists every session, the admin's own marked: user, state (**active**: at least one running node, or
**idle**), creation date, nodes, running VMs, reserved RAM, CPU and last
activity (the owner's requests and console input; an admin observing does not
count). Next to each user, a green dot shows **online** when a browser of that
user is connected (**online ×n** for several tabs; the tooltip gives the count),
or **offline**; the admin's own row is online. A session lives on the server
whether or not its user is connected: it exists from the user's first
request (empty, and then listed as **empty**: no node, so no runner holds it) and is kept after logging out or closing the browser. When the runner of a session is offline (a network cut, a restart of the
runner or of the server), the user's page says "Runner offline, reconnecting…" and requests answer "The runner of your session is offline; it comes back or
your session is dropped after N seconds": the session is kept for `--runner-grace` seconds (counted from the start after a server restart), is bound
again with its machines and consoles when the runner returns, and is dropped when the time is over (the next request opens a new, empty
session). While it waits, a user cannot reset it and gets no second session; the row of an offline session reads **runner offline**
in **Sessions**. In **Runners**, **Drop sessions** drops the sessions of an offline runner at once (confirmation asked); **Revoke** does too;
an offline runner row shows the seconds left before its sessions are dropped. Below the runners table, **Runner status**
shows for the runner chosen in its list (the online runners can be chosen) what `scripts/status.sh` shows on the runner's
machine: the runner process (pid, uptime, memory, CPU), then each session (ID, owner, age, totals) with its nodes (name,
kind, system, engine, pid, memory used over the memory configured for a host, CPU in percent of one core; a stopped node
reads **stopped**, a VirtualBox host has no pid), and the totals of the runner. The runner measures it itself, so a
remote runner works too; only its own processes are measured. It refreshes every few seconds while the Runners tab is
open; "Runner offline" or "No session" shows when there is nothing to list. From there an admin
can:

- **Observe** a session: `/?observe=<login>` opens the normal interface on the
  student's session, read-only: the same buttons as the student's page, the
  write actions greyed out instead of hidden (the tooltip of a greyed-out control says why). A banner of
  distinct colour shows the observed user, previous/next active session, a
  session list, **Follow**, **Take control** and **My session**; **Admin**
  stays in the header. Any user who has used QemuWeb since the server started can be observed, an empty
  session included (it shows as empty). Observing never opens a session: a user who has not used QemuWeb
  since the server started, or whose session was deleted, has none, and the page says so (*toto has no
  session: ...*) with **Take control** disabled.
  The admin sees the consoles live (what the guest echoes, so not a password
  typed without echo), their history and logs, also when the student is
  offline. With **Follow** on (the default), the view follows what the student
  shows: the selected node, Terminals or Graphic, and the console layout (1
  terminal, 2 side by side or stacked, or 4; which node each pane shows, switch
  consoles, the view of each pane: Console ttyS0/ttyS1, Monitor or Log (an observer sees a followed Monitor as the console), and the
  floating console of the Graphic view, open or closed on the same node, at the student's position and size relative to the
  Graphic view, kept inside the admin's window; the admin cannot move or resize it meanwhile), and the admin's own view controls are
  disabled, with the reason as their tooltip (one driver at a time); off, the admin navigates freely from the
  view shown. An observation tab never saves its layout in the admin's
  view settings. The target belongs to the tab: another tab can stay on the admin's
  own session. A login without a session (not used since the server started,
  or deleted) shows a message and a link back to **Admin**. The server refuses every change from an observer without
  control, including console input, Clear and resizing.
  While an admin observes without control, the student's page shows a yellow banner
  ("**boss** is observing your session"; two names, or "3 administrators are observing your
  session" with the logins in its tooltip), gone when the last observation page closes. The
  admin's banner says "You are observing the session of **toto**" (yellow), "You are
  controlling the session of **toto**" (orange) or "**chef** is controlling the session of
  **toto**" when another admin holds control. Every banner is one sentence with the logins in
  bold, and its tooltip gives the explanation (read-only, whether the view follows the student).
- **Take control** of the student's session: an exclusive lock on the whole
  session (Follow is forced on and the student's current view applied first; the
  Follow box stays checked and disabled while control is held). The student's keyboard is blocked on every console and a banner
  tells them who controls it (orange, "**boss** is controlling your session", the
  explanation in its tooltip; it replaces the observation banner); they still see the commands and their output.
  The admin types into whatever console they display. While the admin holds
  control, the student's page follows the admin's view and layout (the reverse
  of **Follow**, pane views included) and its view, layout and pane view buttons are disabled (the tooltip names the admin).
  The admin in control can also do everything the student can on that session: start, stop,
  reboot, add, clone, connect and remove nodes, change host and switch settings and the engine,
  **Resume all**, **Stop all**, **Reset session** (the confirmation says "This removes every node of the
  session of toto"), **Load Session** (into the student's session: the dialog says that the session of
  toto is reset first), **Save Session**
  (downloaded to the admin's browser as `qemuweb-session-toto.zip`), the examples, captures,
  **Clear** and the console size. Deleting the session stays with the admin page. Meanwhile the
  student's actions are greyed out ("boss controls your session") and refused by the server;
  a dialog the student left open when control started stays open, but submitting it is refused.
  Every such action is written to `admin.log`, and to the student's `users.log` as done by
  the admin. Control ends
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
- Read the last 200 entries of the two server logs in the **Logs** tab
  (**Admin** and **Users**), or **Download** them (the button with the
  download arrow). Drag the grip at the bottom right of the log to make it
  taller or shorter (between about 160 pixels and 85% of the window; 60% by
  default); the height is remembered in this browser. At phone width the log
  keeps a fixed height.

Every administration action is written to `logs/admin.log`, an audit log of
administrator actions; user events (logins, sessions, nodes started or
stopped, archives) go to `logs/users.log` (see
[docs/deployment.md](deployment.md#server-logs)). With `--no-auth`,
the implicit local user is admin, so `/admin` is open to anyone reaching the
server.

Until per-user quotas, command restrictions and cross-site request checks
exist (milestone 8), give accounts only to trusted users: any user can run any
single-line QEMU monitor command on their own hosts. Log out only clears the
browser's cookie (and, behind OpenID, ends the OpenID session); see [docs/deployment.md](deployment.md#known-limits).

| Server option | Default | Effect |
| --- | --- | --- |
| `--users FILE` | `users.json` | Users file. |
| `--session-hours N` | `12` | Login lifetime, renewed while the user is active. |
| `--bind ADDRESS` | `127.0.0.1` | Address the server listens on (an IPv4 or IPv6 address). Another address than loopback is plain HTTP, for a trusted LAN test only: see [docs/deployment.md](deployment.md#listening-on-another-address-lan-test-no-proxy). |
| `--trust-proxy VALUE` | unset | Express `trust proxy` value behind a reverse proxy (for example `loopback`), so that cookies get `Secure` over HTTPS. |
| `--auth MODE` | `password` | `password`, `proxy` (the identity is given by an authenticating front end, for example Apache with mod_auth_openidc for OpenID, but also SAML, CAS, LDAP..., through `X-Remote-User`, trusted only with a shared `X-Proxy-Key`; no password login then). |
| `--proxy-key-file FILE` | unset | The key shared with the front end, mode 0600: one line, or two lines during a rotation (either is accepted); required by `proxy`. |
| `--logout-url URL` | unset | Where **Log out** goes for an identity from the authenticating front end. |
| `--no-auth` | authentication on | Disables authentication: one shared local session, for single-user local work only. |
| `--logs DIR` | `logs` | Directory of the server logs (created with mode 0700): `admin.log`, the audit log of administrator actions, and `users.log`, the user events (JSON lines, mode 0600). |
| `--examples DIR` | `examples` | Directory of the example topologies (`.topo`) and sessions (`.zip`) listed by the **Load Session** dialog (read only; a missing directory means no example). |

With `--no-auth`, the server prints a warning at startup and the
interface shows **Authentication disabled**. It is never the default.

## Using QemuWeb

### Included LAN demo

1. Prepare the Debian Cloud image used by the examples: `bash scripts/prepare.sh --system debian13-cloud`.
2. In the Web interface, choose the engine in the **Engine** select of the header (see
   [The session engine](#the-session-engine)), click
   **Load Session**, choose `lan.zip` in **Server examples** (or choose
   [`examples/lan.zip`](../examples/lan.zip) in **My files**) and press **Load**.
3. Start the hosts and the switch. Their startup scripts assign `192.168.0.x`
   addresses to the four hosts. Open their consoles and `ping` between them.

The archive contains settings and startup scripts but no working disks, so hosts
start from fresh images. Its settings apply to either engine.
 [`examples/`](../examples/) also contains DMZ and gateway sessions
(`dmz0.zip`, `dmz1.zip`, `gw0.zip`, `gw1.zip`).

Debian hosts have two serial ports: the pane view selector offers **Console
(ttyS0)** and **Console (ttyS1)**, so two commands can run at once. While nothing
has arrived on ttyS1, its pane shows a muted hint ("Nothing received yet. Press
Enter. ..."). If it stays, the image was prepared before 17 November 2026 and has
no login on ttyS1: rebuild it with `bash scripts/prepare.sh --system <id> --force`
(`bash scripts/prepare.sh --list` tells which images have it).

### The session engine

The header shows **Engine:** followed by a select (**QEMU - KVM** or
**VirtualBox**) on the line of the title. It is the engine of the whole session; the
engine select that was in General Settings is gone (General Settings keeps the
naming scheme and the console font).

- **While a host is up or busy** (a machine running, or an action in progress:
  starting, stopping, rebooting, resetting, loading) the select is **frozen**; hover
  it: *Stop all hosts to change the engine*. It follows the hosts live. The server
  refuses the change too (HTTP 409, *Stop all hosts before changing the engine.*),
  even from a page that was out of date. A running switch does not block it.
- When the server has only one engine the select is disabled; an engine the server
  does not have is a disabled option (*VirtualBox is unavailable on this server*).
  An administrator observing a user sees that user's engine, read-only. The Admin
  page has no select. At narrow widths only the select is shown, the label stays for
  screen readers.
- **Changing the engine keeps everything.** Hosts, names, network interfaces,
  switches, startup scripts and files stay. Each host keeps its hardware settings
  (memory, processors, clock, serial ports, startup disk) **for both engines**: Host
  Settings shows and edits those of the current engine (a note says so, *These
  settings are for QEMU - KVM; the VirtualBox settings of this host are kept
  separately*), so editing under VirtualBox never changes the QEMU values, and they
  are there when you switch back. A system with no base image in the new engine's
  format (a `.vdi` for VirtualBox, a `.raw` for QEMU) stays in the session: after the
  change a message names such hosts (*alpine: no VirtualBox image on this server*) and
  they fail to start with the usual message. A topology (`.topo`) has no engine and
  uses the current one; loading a session ZIP makes its engine the session engine.
- **Working disks are per engine.** A host may own a QEMU disk (`disk.qcow2`) and a
  VirtualBox disk (`disk.vdi`) at the same time; each is created from the matching
  base image at the first start under that engine and is used only by that engine.
  Switching never deletes either. **Reset** deletes the disk of the current engine only
  (its confirmation says which); removing a host deletes its disks. Neither engine
  converts a disk to the other format, and the two engines never run at once (KVM and
  VT-x exclusion).

### Sessions and topologies

- **Sessions are disposable.** With the default setup the session lives in `/tmp` on the server machine and does not survive a reboot of that machine (or an administrator wiping it): the next login finds an empty session. Use **Save Session** (ZIP, with the working disks if needed) to keep work. A server started with `--runtime` on a persistent disk (the CREMI deployment) keeps sessions across reboots.
- One **Load Session** button and one **Save Session** button (bottom left, with the session
  icons) handle both a topology and a session. Their two dialogs have the same frame: the
  button icon and the title, the options in one box, the steps with a green check mark for each finished
  one, a result line, and **Cancel** / the main button (**Load** or **Save**), then **Close**.
  Neither dialog changes size between its states, and **Escape** closes it except while it is working.
  Observing a user as an administrator, both buttons are disabled.
- **Save Session** opens one dialog. One status line gives the size of the session
  (*Save your current session: 4 hosts and 2 switches.*, or *Your current session is empty.*
  with **Save** disabled), and the same **Save** button is used whatever the
  checkbox **Save only the topology (.topo)** says (unchecked by default, remembered
  in the browser). Unchecked, it exports hosts, switches, settings, and startup
  scripts as the session ZIP `qemuweb-session.zip`, with the **Include working disks**
  option and a dimmed size estimate. With the option on, the ZIP carries the working disks
  that exist, `disk.qcow2` and `disk.vdi` of every host, whatever the current engine, and the
  estimate counts them and says which: *QEMU and VirtualBox disks are both included.* Checked, the disk option is greyed out, there is
  no estimate, and the topology text file `network.topo` is downloaded. After **Save** the steps
  appear (*Stop hosts and switches* when the disks are included, *Create the archive*, *Download the file*); an error is shown on its
  step with **Back** to the options, and **Close** ends the dialog.
- **Load Session** opens one dialog, with no menu and no second dialog. **File**: a
  switch chooses the source, **Server examples** (a list reading *name · Topology or Session · size*)
  or **My files** (the file picker of your computer, a `.topo` or a `.zip`); the choice is
  remembered in the browser. Whatever the source, the chosen file appears in the same card: its name,
  its kind (Session or Topology) and size, the first comment line of an example topology, and what the
  browser reads before you press anything: for a session the summary (hosts, switches, hosts with a startup disk, working disks), then the
  check of the base images (in orange when a base image changed since the session was saved); for a topology its hosts, switches and links.
  When the server has no example, **Server examples** is disabled (*No examples on the server*) and
  the dialog works with **My files**. The kind is the extension, confirmed by the content (a ZIP starts with `PK`, a topology is UTF-8
  text without control characters): a `.zip` that is text or a `.topo` that is binary
  is refused in the card with a message, and **Load** stays disabled.
- **Options** of Load Session: **Close the previous session** is always checked and greyed out, because
  loading always replaces the current session; **Start hosts and switches after loading** (checked
  by default, remembered); **Discard working disks** (unchecked by default, never remembered), usable
  only for a session ZIP that has working disks (greyed, with the reason, for a `.topo` or a ZIP without
  working disks). It discards the disks of both engines.
- **One click on Load** runs everything and shows the steps: *Read the file*, *Check the file*,
  *Close the previous session*, *Upload the file* (a server file is read by the server from its disk),
  *Create switches and hosts*, *Restore working disks*, *Start hosts and switches* (a topology has no upload
  and no restore). The result line ends the dialog and **Close** reloads the page on the loaded session.
  Warnings (a start that failed for some instances, a warning of the server) are orange lines of the steps.
  An error is shown on its step; before the session is closed the dialog says *Nothing was changed*
  and **Back** returns to the options. In particular, when a working disk no longer matches a rebuilt base image
  and **Discard working disks** is off, the load is **refused before anything is closed**: *Check "Discard working disks" and load again.*
- **A load goes into an empty session.** When the current session is not
  empty, the orange warning says *A load goes into an empty session: your session (4 hosts
  and 2 switches) is reset first, as Reset session does, and its working disks are discarded.*
  Nothing is removed when the dialog
  opens, nor while the file is read and checked (an unreadable or invalid file
  never destroys the session): the session is reset, as **Reset session** does, only when
  you press **Load**, after the check passed, then the file is
  loaded. If the load then fails, the dialog says so and that the session is empty.
  **Cancel** anywhere changes nothing. Use **Save Session** first to keep a copy.
- The **Examples** are the `.topo` and `.zip` files of the server's `examples/`
  directory (the `--examples DIR` option of the server; a missing directory means
  no example). They are read only, listed afresh at each opening of the dialog,
  and loaded by the server from its own disk with the same checks as an upload.
- Each host with a
  working disk records, in its `host.json`, the base image each disk depends on (size and
  SHA-256, one record per disk format). A saved VirtualBox disk only loads on a machine
  whose base `.vdi` is byte-identical to the one it was made on (every conversion to VDI
  gets a new identity), as a saved qcow2 needs the same raw image; otherwise the warning
  above and **Discard working disks** apply. A session saved by an earlier version (format 1)
  is not readable any more: delete it or rewrite its `host.json` files by hand. Hosts without a working disk simply start from the current image,
  without a warning (image builds are not reproducible, so the hash differs from one
  machine to another).
- A `.topo` text file describes only hosts, switches, and their links,
  without disks or startup scripts. Examples:
  [`topo/lan.topo`](../topo/lan.topo), [`topo/dmz.topo`](../topo/dmz.topo),
  [`topo/gw.topo`](../topo/gw.topo). They are the topologies of the tests: the Load Session dialog does not list
  them by default (`--examples topo` shows them).
- The hosts of every example (`.topo` and `.zip`) use the system `debian13-cloud`: starting them needs
  `images/debian13-cloud.raw` (`bash scripts/prepare.sh --system debian13-cloud`).

### Graphic view

The **Graphic** button (bottom right) shows the network as a diagram; **Terminals** goes
back. Each card shows the node name, its system, its state, and for a host its memory,
vCPUs and how many interfaces are linked (for a switch, how many ports are in use). Hovering a
card lists everything, including each interface's switch and port.

**Addresses.** For a running host, the address the guest reports with its prefix (for example
`192.168.0.1/24`) is drawn under the interface label (`eth0`, `eth1`, ...) at the host end of the link of
that interface, and listed in the hover of the card and of the link (with the MAC address). It follows the
guest: a DHCP lease, a static address at boot or `ip addr add` show up within a few seconds, and the label
disappears when the address is removed or the host stops. If an interface has several addresses, the
first is drawn followed by `+N`, all are in the hover; link-local and loopback addresses are not shown.
The address is what the guest says about itself (a student is root in it and can make it say anything): it
is informational, QemuWeb never uses it for anything. QemuWeb asks the QEMU guest agent of the guest
through a private channel, with no network traffic, so nothing shows when the system has no agent: the
four systems of QemuWeb have it in images prepared with this version, an image prepared before needs
`bash scripts/prepare.sh --system <id> --force`, and a VirtualBox host never shows addresses. Nothing is
drawn for a host without an address or whose agent has not started yet (the first seconds of a boot).

- **Move the view**: drag the background to pan, use the mouse wheel to zoom around the
  pointer, or the zoom buttons (`+`, `-` and `0` on the keyboard). **Fit to view** shows the
  whole network. The pan and the zoom are part of the view: **Follow** shows the student's on
  the observer's page (centered on the same point at the same zoom, whatever the size of the
  window), and the student's page shows the controlling admin's; that page then cannot pan or
  zoom (the zoom buttons are disabled, with the reason as their tooltip).
- **Move a node**: drag its card. The canvas has no edge: a node can be dragged anywhere you
  can see, at any zoom level. Node positions belong to the session, not to the browser: the
  server keeps them (`layout.json`, saved in the session ZIP and restored by **Load Session**),
  so every browser of the student and every observer shows the same layout, and the other
  pages see the node move during the drag. Only the session's driver moves nodes: the student,
  or the admin holding control (meanwhile the student's page cannot move them); an observer
  without control cannot, even with **Follow** unchecked. Nodes nobody moved are placed
  automatically (a layered layout that limits crossings), and a loaded topology gets a fresh
  layout.
- **Link style**: the button left of the zoom buttons switches the links between smooth **curves** (the
  default) and **rectilinear** lines, made of horizontal and vertical segments only, like a classic network
  diagram. The icon shows the style a press switches to. Only the path of the links changes: the interface and
  port labels, the addresses, selection, hover and the recording colour are the same. The style is part of
  the view: **Follow** shows the student's style on the observer's page, and while an administrator holds
  control the student's page shows the administrator's; the button is then disabled, its tooltip says why.
  Your own choice is remembered in this browser for your next visits (`localStorage`, key
  `qemuweb.graphic-links`, kept when you load a session); a style shown because you follow another view never
  replaces it.
- **Select**: a click selects a node, like its tab in the Terminals view (the selected node is
  highlighted and is the one the toolbar actions apply to).
- **Console**: a double click (or Enter on a focused card) opens the node's console as a
  floating window over the graph. It is the normal console pane (views, actions, font size);
  an administrator observing a session sees it read-only, and **Take control** applies to it
  as in the Terminals view. Whether it is open, its position and its size are part of the view:
  **Follow** shows it on the observer's page where the student put it, and the student's page
  does the same with the controlling admin's (the close button is then disabled, and the window
  cannot be moved or resized). Position and size are kept relative to the Graphic view, so a
  smaller browser shows the window at the same place, kept inside its window. Drag its title
  bar to move it, its bottom right corner to resize it, and use the close button to dismiss it.
  Going to the Terminals view hides it and coming back to Graphic shows it again, on the
  selected node, at the same place. Opening a console selects the node, which can
  change the page shown in the Terminals view.
- **Edit** (greyed out when observing): **Host** and **Switch** add a node where you click next
  (the usual dialog opens first). **Connect** links a host interface to a switch: click a
  host, choose its interface (or a new one), then click a switch; clicking a switch first
  also works. Click a link to select it, then **Remove link** disconnects that interface
  (the interface itself stays; remove it in Host Settings). A running host needs a restart
  for the change to apply, as in Host Settings. `Esc` cancels an editing mode.

### Capturing traffic

QemuWeb can record the frames of a host's Ethernet interface, in both directions, into a
standard **PCAP** file that is saved by your browser and that you open in Wireshark. The host
records them itself (QEMU copies every frame between the interface and its switch): nothing
runs in the guest and the guest cannot see it. It works on a **running QEMU host** with an
interface connected to a switch; a stopped host, a VirtualBox host and an interface that is
not connected are shown disabled, with the reason as the tooltip.

- **Start and stop.** Click the **Capture** button (the heartbeat line icon) in the bar of the
  terminal pane of the host (it is not shown for a switch). The dialog names the host; choose
  the **interface** (each one shows the switch it is connected to, such as "Ethernet 0 · to
  switch lan"; the connected one is preselected) and click the **Play** button (Start capture)
  next to it. **Stop** (the square) ends the capture, **Download** (the arrow) gives the file; a
  disabled button says why in its tooltip and in the line under the row. In the Graphic view you can also
  click a link and use **Capture…** in its popover: it opens the dialog on that host and
  interface. Several interfaces of a host can be recorded one after the other; each start
  records one file. A capture recording in another tab of your session shows a red dot on this
  button, and a red **REC** mark on the node and the link in the Graphic view.
- **Saved at once.** When the capture stops, whether you press **Stop** or it ends by itself
  (size limit, host stopped), the dialog saves `eth0-<date>.pcap` through your browser's normal
  download and shows "Saved: …". **Download** gives the file of the selected interface at any
  time, also while it records: you get what was captured so far (cut after its last whole
  packet) and the capture goes on. Open the file with Wireshark (`File → Open`) or `tcpdump -r`.
- **A capture lives only while the dialog is open.** Closing the dialog (Esc, **Close**, a
  click outside) deletes the capture files; if a capture is still recording, you are asked
  first ("Closing stops and discards the running capture. Close anyway?"): press **Stop**
  first to save it. Closing or reloading the browser tab does the same on the server,
  so nothing keeps recording unseen. If you open the dialog on a host that another tab of your
  session is capturing (or an administrator who took control), it shows "Recording in another
  tab" without Start or Stop, and closing your dialog leaves that capture alone.
- **Limits.** A capture file stops at **100 MB** (the state reads "stopped: size limit
  reached"; a burst of traffic can overshoot by a few megabytes), and a host keeps at most
  **4** capture files. The files are **not** part of the session ZIP. The packet times are
  QEMU's clock.
- **Live view.** Under the controls, the dialog shows the packets as text while they arrive, as
  `tcpdump` prints them (the last 2000 lines; **Clear** empties the area). It starts with the
  capture. The optional **Live filter** (a tcpdump expression such as `icmp`, `host 10.0.0.2`
  or `tcp port 80`; letters, digits and `. : / _ - ( ) [ ] & | ! < > = + * % ^ ,` only, 200
  characters at most, not starting with `-`) applies to the live view only: the PCAP file
  stays whole. Press Enter or leave the field to apply it. The view needs the `tcpdump`
  program on the machine of the runner; the area says so when it is missing.
- **Who can do what.** The owner of the session, and an administrator who **took control** of
  it, can start, stop, list, download, delete and watch captures. An administrator who only
  observes cannot, not even list or download; the controls are shown disabled. Starting,
  stopping, deleting and downloading are recorded in the audit logs (who, which host and
  capture, never the packets); so is a capture discarded when an administrator's tab closes.

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
