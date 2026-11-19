# Roadmap to 1.0.0

The single plan of the project: the milestones to 1.0.0, their tasks and the side notes that used to live in a
separate TODO list. Each task has a stable code (used for its branch and its delegated session); tick it when it is
delivered and delete its notes when they no longer help. Something noticed along the way goes to the **Backlog** at
the end, or straight into the milestone it belongs to.

## Goal of 1.0.0

**QemuWeb open to a whole class at the CREMI, in production, without trusting the users.** One session per student,
about **30 simultaneous sessions** (a switch and around 5 nodes each), spread over the server, a pool of runners and
lab workstations, behind the CREMI HTTPS front end and OpenID.

Until the hardening milestone (8), give accounts only to **trusted users**: any user can run any single-line QEMU
monitor command on their own hosts, and there are no quotas and no jail.

## Where we are (0.9.0)

| Milestone | Content | Version |
| --- | --- | --- |
| 1 to 4 | Session and node naming, modular refactoring, multi-user accounts, admin role | 0.9.0-beta.1 to beta.4 |
| 5 | Local runner as a separate process, remote runners (registration token, authenticated WebSocket, placement, grace period, administration) | 0.9.0-beta.4.1 to beta.5.1 |
| Docs, graph | PDF documentation, Graphic view rebuilt (GRA01), README and documentation split into `docs/` | 0.9.0-beta.5.2, beta.5.3 |
| CREMI | Apache and OpenID front end, `--auth proxy` (shared `X-Proxy-Key`), accounts without password, Connections panel and WebSocket test in `/admin` | 0.9.0-beta.5.4 |
| Stabilisation | File formats back to `schemaVersion` 1, demo archives rewritten, session ZIP named `qemuweb-session.zip`; remote runner validated at the CREMI (registration, placement, network cut, revocation) | **0.9.0** |

Formats: from 0.9.0, every change of a format increments its number and comes with an explicit decision on
compatibility.

## Order of the work

1. **Reliable operation first** (milestone 6): little code, a large gain for whoever runs the server.
2. **Reliable runners before personal runners** (7): sessions that survive, forced loss, then the student's own runner.
3. **Hardening before opening** (8): personal runners, guest access and the whole class are only opened once the
   protections exist.
4. **Load at the end** (9): the 30-session test validates the whole.

Each milestone is released as a beta `1.0.0-beta.N`, with the usual rules: tasks in visible sessions, tests on the
user's order, local merge, manual test, then the tag.

| Milestone | Title | Size | Depends on |
| --- | --- | --- | --- |
| 6 | Operation at the CREMI | medium | none |
| 7 | Reliable runners and personal runners | large | 6 (partly) |
| 8 | Hardening | large | 7 (validation of runners) |
| 9 | Load and quality | medium | 6, 7, 8 |
| 10 | Graphic view and finishing | medium | independent |

Sizes of tasks: S about an hour, M half a day, L a day or more.

## Milestone 6: operation at the CREMI

What separates a deployment that works from one you can operate calmly.

- [ ] **AUT01** (M) Authentication.
  - Remove `--auth both`: two modes only, `password` (local tests, ad hoc server) and `proxy` (production). `both` mixes
    two ways in on one port and blurs "who authenticates this request?". Cost: no password login through the SSH
    tunnel on a production server; an administrator is an OpenID login listed in `users.json` with the role admin, and
    in an incident the service restarts with `--auth password` (documented in the tutorial). Touches
    `server/options.js`, `server/auth/index.js`, the unit, the tutorial, the docs and the tests.
  - The SSO session expires during use: Apache then answers an API call or a Socket.IO connection with a redirection to
    the CREMI login, not a 401. Today `public/api.js` and `public/socket.js` only redirect on a 401 (and on the
    Socket.IO error `Authentication required.`): a redirection to another origin makes the `fetch` fail without a
    status and the socket shows `WebSocket unavailable`, and the page does not reload. Fix: `OIDCUnAuthAction 401` in
    a `<Location>` for `/api/` and `/socket.io/`, and the interface reloading the page on a 401 when `/auth/me` says
    `via: proxy` (and `/login.html`, a 401 in `--auth proxy`, must not be the target).
  - Group to role: administrators come from `users.json` only; `X-User-Groups` is unused. Decide whether a directory
    group may grant the admin role, and how to list a student in `/admin` without a prior `--no-password` entry.
  - The proxy identity has no throttling of its own (see SEC01).
  - Rotating the shared key without interruption, described in the tutorial.
- [ ] **SVC01** (M) Services and operation.
  - systemd units for the server, the local runner and a remote runner; `logrotate`; recovery after a reboot.
  - CREMI wildcard certificate: `/etc/apache2/certs/star_emi_u-bordeaux_fr.crt` and `.key` are links the CREMI
    repoints every year (the current one ends on 2 December 2026); Apache must be reloaded afterwards: say it in the
    tutorial or add a hook.
  - The OpenID provider must be reachable from Apache without the proxy (to check on the CREMI machine).
  - The small independent fixes of the Annex (`BUG` and `TODO` lists) can be taken along.
- [ ] **DOC01** (M) Documentation.
  - One installation path: `docs/deployment.md` stays the generic reference and points to the files of `deploy/`
    (unit, Apache site) instead of copying them; `deploy/cremi/deploy-cremi.md` becomes a short recipe that links to
    it; the remote runner test sheet no longer repeats the runner installation.
  - Bring `docs/user-guide.md` up to date (serial ports, `start.sh`, runner commands, Follow).
- [ ] **PRP01** (S) `prepare.sh`.
  - The Debian ISO and its `SHA512SUMS` come from `cdimage.debian.org`, which the CREMI squid has answered 503 for:
    a setting for the base URL (or another host), or document placing both in `sources/debian13-legacy/` by hand.
  - Alpine and OpenWrt builds do not use the proxy yet.
  - The failure strings and phase markers of `scripts/prepare/lib/common.sh` are still unchecked against a real log.

**Done when**

- [ ] `--auth` has only `password` and `proxy`, and the CREMI server runs in `proxy`.
- [ ] An expired SSO session sends the user back to the login, with no obscure error.
- [ ] The server and a remote runner start at boot and their logs rotate.
- [ ] One documented installation path, with no copy to keep in two places.
- [ ] A Debian image builds behind the CREMI proxy without a special option.

## Milestone 7: reliable runners and personal runners

- [ ] **RUN02** (L) Robust runners.
  - Persist the session-to-runner binding: a restart currently deletes every session of a remote runner (the hello of an
    untrusted runner is never adopted), although the VMs could keep running as for the local runner.
  - Let the administrator force the loss of the sessions of a revoked or lost runner, without waiting for
    `--runner-grace`.
  - Keep the paused state of the local runner (a remote runner's is in `runners.json`).
  - Test the re-selection of the console after a runner comes back (`runner-state`) in a real browser: today it is
    only tested through the socket events of `check-runner-remote`.
  - Restrict `/runner/connect` and `/api/runner/register` by address when the runners are known.
- [ ] **PRN01** (L) Personal runners, server side (design below).
- [ ] **PRN02** (M) The "My runner" page and the "runner offline" message.
- [ ] **PRN03** (M) Base images for a runner: shared directory or HTTP download, workstation sheet.

### Personal runners (design)

Two cases. At **home**, the user has no runner: the session runs on the server's pool of runners (pre-registered
machines; `pickRunner` already picks the least loaded online runner under its `maxSessions`, not a round robin, and an
administrator can pause one). In a **lab room**, the student's own workstation becomes their runner, and browser and
runner are on the same computer.

- **"My runner" page**, open to every signed-in account (students included), in the account menu: creates a
  registration token (15 minutes, single use, a few creations per day), shows the command to paste
  (`./scripts/runner.sh register --url URL --token TOKEN`, then `run`), the state of the runner (online, offline since)
  and revokes it. A page, not a command line tool: `/admin -> Runners` already covers the pool.
- **Server side**: the token and the runner record get an `ownerLogin` (today only an administrator creates tokens;
  see `server/runner-registration.js`, `server/routes/admin-runners.js`, `server/runner-store.js` and the
  registration route). One personal runner per user to start with. The registration token stays in memory and single
  use (a restart drops it, acceptable at 15 minutes); the runner's own token is durable in its `runner.json` (0600).
- **Placement**: `pickRunner(login, ...)` already receives the login and ignores it. A **new or loaded** session goes to
  the owner's personal runner when it is online, else to the server pool; an existing session **stays where it is** (no
  migration: Save then Load session ZIP moves one). A personal runner takes **only its owner's session**, never another
  user's (the one isolation rule kept before any quota). A session whose runner is offline shows "runner offline"
  and comes back when the runner reconnects.
- **Base images**: a read-only shared folder (NFS; the working disks are qcow2 files backed by the base image, which is
  never written) or an HTTP/FTP download checked with the `.sha256` files, plus an option naming the images directory of
  a runner (today `images/` of the repository).
- **Lab workstation prerequisites** (to confirm with the CREMI): students in the `kvm` group (or an ACL on `/dev/kvm`),
  Node 24, QEMU and VDE installed, the repository or a release reachable (shared home or folder), a short local
  `--runtime` (at most 49 characters, for example under `/tmp`). `register --runtime` is only needed when the runner's
  directory differs from `runtime/` of the repository.
- **Later**: a device-code login (the runner prints a code, the user confirms it in the signed-in browser) instead of
  pasting a token; a launcher in the room's image; balancing by free memory instead of a session count.

**Done when**

- [ ] A server restart leaves the sessions of a remote runner in place.
- [ ] The administrator can force the loss of the sessions of a runner.
- [ ] A student creates their token, registers a lab workstation and their session lands on it; another student cannot
  place theirs there.
- [ ] A lab workstation finds the images through the shared directory or the download.

## Milestone 8: hardening

Application protections and the runner jail. **This milestone conditions the opening to the class**: before it, a
personal runner and any guest access exist only for trusted users.

- [ ] **SEC01** (L) Accounts and web sessions.
  - Password: at least 8 characters, enforced by `scripts/user.sh` and the reset from `/admin`, with `--allow-weak` for
    test accounts.
  - Throttle repeated login failures (by login and by address; the relay now sends `X-Forwarded-For`), no permanent
    lock; it also covers the identity given by the front end.
  - `Origin` check on the API (state-changing requests) and on the Socket.IO handshake, with a list of allowed origins.
    To handle: a missing `Origin` on the Socket.IO fallback (the browser's GET requests do not send one).
  - Revocable logout: the signed cookie is stateless on the server, so a copy stays valid until it expires; keep a
    list of web sessions on the server, or rotate the secret.
  - Guest access by password outside OpenID, only here and with the quotas, the allowlist and the throttling in place,
    never an administrator account (idea: `OIDCUnAuthAction pass`, `X-Proxy-Key` sent only with an OpenID identity, a
    "CREMI login" link on the login page).
- [ ] **SEC02** (L) HMP allowlist and quotas.
  - `/api/nodes/:nodeId/monitor` accepts only `info ...`, `system_reset`, `system_powerdown`, `stop`, `cont`, `sendkey`
    and `nmi`; the runner checks it itself, remote ones included.
  - Quotas (a `limits` section of `config.json`, validated by `common/system-config.js`): per VM, memory and vCPU
    instead of the 32 768 MB and 64 vCPU hard-coded in `common/launch-settings.js`; per session, number of nodes and
    total memory of the started hosts; for the server or a runner, refuse to start a VM beyond the available RAM.
    Enforced by the runner with a clear message; the limits of a remote runner stay in its `runner.json`.
- [ ] **SEC03** (L) Untrusted runners. Everything a student's runner sends is validated: an event or a response is
  accepted only for a session bound to that runner, frames and payloads have size limits, console data is treated as
  untrusted text, archive streams are size-limited on both sides. A runner provides no identity or authorization:
  logins, roles, console control and audit stay in the control plane.
- [ ] **SEC04** (L) Minimal jail.
  - The runner runs under a dedicated system account `qemuweb-runner` (group `kvm`), with `runtime/` in `0700` and the
    base images read-only.
  - One systemd scope per session (`systemd-run --user --scope -p MemoryMax=... -p CPUQuota=...`) as a safety net
    beyond the QEMU limits. An unprivileged runner can limit memory and CPU only if systemd delegates the cgroup
    controllers: check on the target machines, with the QEMU limits as the only protection otherwise. VirtualBox stays
    supported but outside the jail (its VMs belong to the VBoxSVC daemon).
  - Later if needed: a uid per session, bubblewrap or nsjail, a network namespace.

**Done when**

- [ ] An HMP command outside the allowlist is refused, on a remote runner too.
- [ ] A quota overrun is refused with a clear message.
- [ ] A too short password is refused, except with `--allow-weak`.
- [ ] Repeated login failures are slowed down.
- [ ] A request or a Socket.IO connection from a disallowed origin is refused.
- [ ] After a logout, the old cookie opens no session.
- [ ] A student's runner sending invalid data, or data outside its session, is ignored with no effect on others.
- [ ] A VM that exceeds its RAM is killed by its scope without affecting other sessions.

## Milestone 9: load and quality

- [ ] **IMG01** (M) A lighter, faster `debian13-legacy` image, before LOD01 (smaller guests mean more sessions per
  runner). Goals: the shortest possible boot, the smallest footprint, and **no spontaneous network traffic**: a
  `tcpdump` on a freshly booted, idle host must show nothing, so that a student's capture only shows what the lab
  generates. Work:
  - Measure the current image first and keep the numbers (boot time to the serial login prompt, memory used at idle,
    size of the RAW image, number of running services) so the gain is real; a small repeatable script for it.
  - Disable what a lab host does not need, one by one, checking nothing the labs use breaks: today the build installs
    the Debian `standard` task (`tasksel/first`) plus `rsyslog`, and enables `systemd-networkd` with `DHCP=yes` on every
    Ethernet interface. Candidates: the `standard` task itself (install only what `pkgsel/include` lists), timers
    (`apt-daily`, `man-db`, `fstrim`, `e2scrub`), `systemd-timesyncd`, `systemd-resolved` (LLMNR, mDNS), `rsyslog` (the
    journal is enough), `getty@tty1` (no display), `cron` and anything else `systemctl list-unit-files` shows enabled.
  - Silence the network until the lab asks: no DHCP client request at boot (the lab's `start.sh` or a command
    configures an address; leave DHCP available but off), no IPv6 router solicitation, neighbour discovery or MLD
    report (`net.ipv6.conf.*.disable_ipv6` or `accept_ra=0` and no link-local autoconfiguration, to decide), no LLMNR
    or mDNS, no NTP. A student who wants DHCP or IPv6 turns it on; document how.
  - Faster boot: shorter GRUB timeout, no splash, `quiet`, a lighter initramfs, no waiting for the network
    (`systemd-networkd-wait-online` off), a kernel command line without unneeded probing; keep the serial consoles.
  - Keep what the labs use (`iproute2`, `net-tools`, `tcpdump`, `iputils-ping`, `curl`, editors): if `tcpdump` is not
    installed today, add it, since the aim is to look at traffic.
  - Check the five demos (`lan`, `gw0`, `gw1`, `dmz0`, `dmz1`) and the startup scripts still work, and that a rebuilt image
    changes the hash that session archives compare (`prepare.sh --hash`).
  - Apply the same to `debian13-cloud` afterwards if it pays off; Alpine and OpenWrt are already light.
- [ ] **LOD01** (L) Load test of about 30 simultaneous sessions (a switch and 5 nodes each) on the server, the pool and
  lab workstations: memory and CPU measured, no VM killed, a responsive interface. Balance by free memory instead of a
  session count if the test shows it is needed.
- [ ] **QUA01** (M) Quality.
  - Run the manual test sheet on the production server without a deviation; unit and integration tests green; PDFs and
    README up to date.
  - The open defects of the Annex (`BUG` list) are cleared or consciously deferred.

**Done when**

- [ ] A freshly booted idle `debian13-legacy` host shows no packet in `tcpdump` on its interfaces, boots measurably faster
  than before and uses less memory (numbers recorded).
- [ ] The 30-session load test passes with no VM killed.
- [ ] The manual test sheet is run on the CREMI server without a deviation.
- [ ] The PDFs and the README are up to date.

## Milestone 10: Graphic view and finishing

- [ ] **UXS01** to **UXS04** Rework the user interface around the session, which is confusing today. First a short
  design (UXS01, S: a written proposal with a sketch of the toolbar, agreed with the user), then three tasks.
  Today the bottom-left toolbar (`public/index.html`) puts in one row: Load/Save topology, Load/Save session ZIP, New host,
  New switch, Clone, Resume all, Stop all, **Remove all hosts and switches** (`exit-all`) and **Delete session** (the red
  trash button). Both of the last two empty the session; the difference (the session itself) means nothing to a student.
  - **UXS02** (M) Session lifecycle. A user always has one session, so it should exist from the login without a
    "create" step, and the two destructive actions become **one**: *Reset session* (confirm, stop and remove every node,
    the session stays, empty). *Delete session* leaves the student's toolbar (an administrator still deletes sessions
    from `/admin`). To settle: whether an administrator gets an implicit session too or only on demand (an admin
    usually only supervises). **Dependency with PRN01**: a session is placed on a runner when it is created; creating it
    at login would place it on the server pool before the student has started a personal runner. Place it instead
    when the first node starts or when a ZIP is loaded (the session exists from the login, but is not bound to a runner
    until then).
  - **UXS03** (M) Regroup the actions in clear categories, with the same words in the interface and in the guide:
    **Session** (Load and Save ZIP, Load and Save topology, Start all, Stop all, Reset), **Nodes** (New host, New
    switch, Clone, and per node: Start, Stop, Reboot, Settings, Remove) and **View** (layout, pages, switch consoles,
    Graphic or Terminals). For example a "Session" menu, a "Nodes" group and the existing view buttons, with labelled
    tooltips and the disabled ones saying why. Same grouping in the Graphic view tools.
  - **UXS04** (L) **Edit mode and Run mode.** Edit: change the topology (add, remove, clone, connect, node settings),
    nothing needs to be running. Run: the machines run, consoles and Start/Stop/Reboot are the actions, and editing the
    topology is disabled with a tooltip. A mode switch in the session header, one place that decides which controls
    are enabled (today the `write-action` and `view-control` classes and several scattered conditions do, including
    observation and admin control). To settle: whether Run requires every node to be started or only some; what happens
    to a node added while others run (allowed in Edit only, then Resume); how the Graphic tools (Add host, Add switch,
    Connect, GRA04) follow the mode.
  Checked by hand on desktop and at phone width; unit tests for the pure rule "which controls are enabled in which
  mode". Update `docs/user-guide.md` (and note that it still says the CREMI runs `--auth both`: it is now `--auth proxy`).
- [ ] **ADM01** (M) Tabs in the Admin (Supervision) page. `/admin` (`public/admin.html`, `admin.js`,
  `admin-connections.js`) stacks five sections on one long page: Sessions, Runners, Connections (WebSocket), Accounts and
  Logs. Wanted: a tab bar, one section visible at a time (**Sessions**, **Accounts**, **Runners**, **WebSocket**,
  **Logs**, and room for later ones, for example **Quotas** or **Audit**), each with its own refresh.
  - The current tab is kept in the URL fragment (`/admin#runners`) so a reload or a shared link returns to it, and the
    keyboard works (arrow keys move between tabs, the ARIA `tablist`/`tab`/`tabpanel` roles).
  - Only the visible tab polls (today every panel refreshes every 4 seconds whether seen or not): less load on the
    server, and an unseen panel never steals the focus. The tab label shows a count or a warning (offline runners,
    connections on `polling`, sessions with a running node), so a problem is visible without opening the tab.
  - Dialogs (confirm, create account, reset password) stay as they are; the page works at phone width (tabs scroll
    sideways instead of wrapping), and in observation or admin-control mode nothing changes.
  - Rename in the interface: "Supervision" is the link's text and the page title; keep one word for it everywhere.
  - Unit tests for the tab logic if it is pure (which tab from the fragment, which panels poll); the layout is checked
    by hand.
- [ ] **GRA02** (L) Several floating consoles: up to 4 overlapping windows, cascaded, a click brings one to the front,
  each movable, resizable and closable, built on the 4 existing panes (today only one floating window exists: the
  selected node's pane, `public/graphic-console.js`; a double click on another node reuses it). To decide: the maximum
  number of windows; observer and Follow behaviour (disabled under Follow, as today); whether the geometry is kept
  until a reload or saved; whether the windows stay independent of the per-user Terminals layout. An alternative is a
  docked panel under the graph.
- [ ] **GRA04** (M) Connecting nodes by dragging, in the Graphic view. Today the **Connect** tool needs two clicks in a
  fixed order (a host, then a switch, or the reverse; `public/graphic-edit.js`), and a link is removed from a popover.
  Wanted: a **socket (plug) symbol on every node**; press it on the source node and **drag onto the target node** to make
  the connection, with a line following the pointer and the valid targets highlighted; release elsewhere or `Esc`
  cancels. To settle:
  - which interface of a host is used when it has several (the first free one, or a new one added automatically; today
    a host has up to 4 NICs, and the number of NICs is a host setting);
  - which pairs are valid (host to switch both ways; a host to a host or a switch to a switch is refused with a hint,
    unless the model gains such links);
  - dropping on an already connected interface (replace or refuse), and dropping on empty canvas (nothing, or add a
    node there);
  - touch: a drag with one finger must not conflict with panning (the plug is a handle that starts the connection);
  - whether the **Connect** button stays as a fallback, and a drag from the plug of a connected interface to detach or
    move a link (this would also remove the need to open Host Settings to delete the interface itself, see GRA03).
  Unit tests for the pure part (which interface, which pairs); the pointer interaction is checked by hand on desktop
  and at phone width.
- [ ] **GRA03** (M) Remaining points.
  - No IP address on the cards: QemuWeb does not know a guest's address without a guest agent (or a startup-script
    convention that reports it).
  - Touch: the view pans with one finger and zooms with the buttons only; no pinch zoom.
  - The position and size of the floating console are kept only until the page is reloaded.
  - A link is removed by disconnecting the interface, which stays; removing the interface itself is only in Host
    Settings.
  - Clear: the guard that decides whether `stty rows N cols M` may be typed is a heuristic on the cursor line (trimmed
    line ends with `#`, `$`, `%` or `>`, cursor at the end), not covering other prompts (`]`, `:`, `λ`, zsh symbols),
    wrapped long prompts, or REPLs whose prompt ends with `>` or `$` (python, sqlite, ssh). Ideas: a pure function with
    a unit test over many prompts; or let the guest announce its prompt (`PS1` in `prepare.sh`).
  - A pass on large networks (DMZ, gateways) and on small screens.

**Done when**

- [ ] Several floating consoles show at once and are driven by mouse and keyboard.
- [ ] A user never creates a session by hand; one action resets it; the toolbar groups Session, Nodes and View
  actions; Edit and Run modes enable different controls.
- [ ] The Admin page shows one section at a time in tabs, keeps the tab in the URL and polls only the visible one.
- [ ] Two nodes are connected by dragging from one's socket onto the other, and the result matches the Connect tool.
- [ ] The manual checks of the Graphic view all pass, on a desktop browser and at phone width.

## After 1.0.0

- OpenID Connect built into QemuWeb (no front end), with the directory groups mapped to roles; today Apache does it.
- Course subjects: the administrator publishes a session ZIP as a template, and each student instantiates it.
- A teacher role distinct from the administrator, limited to their groups' sessions.
- Other single sign-on systems are already supported through `--auth proxy` (see `docs/deployment.md`).

## Annex: minor independent tasks

Small tasks that belong to no milestone and depend on nothing. Take one when there is a gap, between two large tasks or
along with a related one. Sizes are S (about an hour) unless noted. Tick a line when it is delivered; keep the code in the
commit message.

### BUGFIX

- [ ] **BUG01** `prepare.sh --hash --system ID` reports nothing and exits 0 when the system is not built yet. In
  `write_image_hashes` (`scripts/prepare.sh`), `if [[ ! -s "$image" ]]; then continue; fi` skips a missing or empty image
  silently, so the command can succeed having recorded nothing. Print `ID.raw: no image` (and `ID.vdi`) and exit non-zero
  when a targeted system has no image at all (only one of the two formats is a warning); with no `--system`, list the
  systems not built as skipped, and exit non-zero only if no image was found anywhere. A test of the status and messages.
- [ ] **BUG02** The "switch consoles" button is not greyed out when the view is driven (Follow checked, or owner under
  admin control) although it carries the `view-control` class. Not reproduced by reading the code: find the exact case.
- [ ] **BUG03** A `monitor` view received before the node data says Monitor is supported falls back to the console and is
  not applied again later.
- [ ] **BUG04** The test harness kills only `start.sh` after 12 s, so the server and the runner, in their own sessions,
  could survive a hung stop (`test/integration/qemuweb-client.js`).
- [ ] **BUG05** The lines written to the Log view by Clear have no timestamp.
- [ ] **BUG06** A runner with an unreadable `config.json` still prints `✓ config.json  0 systems` after the
  `Cannot read the system catalog` error. It should print a ✗ and abort.
- [ ] **BUG07** `start.sh` says "The server exited (status 2); stopping the runner." although no runner was started when
  the server refuses its options. Also check by hand that `./scripts/start.sh --session-hours 0` exits 2 at once and
  leaves nothing running.
- [ ] **BUG08** `docs/user-guide.md` still says the CREMI runs `--auth both`; it is `--auth proxy`. (Disappears with AUT01.)

### TODO

- [ ] **TOD01** `status.sh`, `killall.sh` and `cleanall.sh` only know the default `runtime/`: add `--runtime DIR` to each, as
  `start.sh` and `stop.sh` have.
- [ ] **TOD02** Report a `runtime/` path longer than 49 characters at startup (the sockets of a node must fit in 107 bytes),
  in the server and the runner, with the `--runtime` hint; today it only fails when the first node is created. Or shorten
  the node socket paths with a short alias directory. (M)
- [ ] **TOD03** More `config.json` warnings at startup, beyond the engine, KVM and serial port checks.
- [ ] **TOD04** A tooltip on a disabled view control saying why (view driven by the owner or by the controlling admin).
- [ ] **TOD05** A `--version` option for `server/main.js` and `runner/main.js`, so the administrator can compare the versions of
  the two processes after an update.
- [ ] **TOD06** At startup the server could compare its version with the runner's hello and say "restart the runner" instead
  of letting an archive fail with `Invalid session.json in archive.` after a format change.
- [ ] **TOD07** `register --runtime` is only needed when the runner's directory differs from `runtime/` of the repository:
  say it in the registration output.

## Backlog

Things noticed with no milestone yet. Move one into a milestone when it is scheduled, delete it when done.

- Merge `docs/remote-runner-test.md` with the deployment documents once the runner choice is settled (see DOC01).
- Standalone local terminals (`CLI01`, size L, independent of the web interface): run machines on the user's own computer
  without a server and open `xterm` windows or `tmux` panes on their consoles. The runner already exposes `serial0.sock`,
  `serial1.sock` and `mon.sock` per node, and everything goes through `runner/index.js`. To settle: a mode with no server
  at all, or terminals attached to the machines of a runner that the server also manages; the local computer only, or
  a remote runner too (needs a tunnel for the sockets). Not a condition of 1.0.0.

## Decisions made

| Question | Decision |
| --- | --- |
| Authentication | Two modes, `password` and `proxy` (identity from the front end through `X-Remote-User`, guarded by `X-Proxy-Key`); `both` is removed in AUT01 |
| Server restart | Local runner: sessions adopted again. Remote runner: sessions dropped today, the binding will be persisted (RUN02) |
| Inactive sessions | No expiry: the administrator cleans up by hand from `/admin` |
| Sessions per user | One, for good; a session lives on the runner that created it and moves by Save then Load ZIP |
| Personal runners | Created by the user from "My runner"; a new or loaded session goes there when it is online, else to the pool |
| Administrator console | Read-only; writing only after an explicit takeover (exclusive lock, visible to the student, logged) |
| Session identifier | Random; the login is in `owner`; link `runtime/users/<login>` |
| Security | Milestone 8; until then, trusted users only |
| `schemaVersion` | At 1 since 0.9.0; any format change increments it with an explicit compatibility decision |
| VirtualBox | Kept, outside the jail and the cgroup quotas; QEMU first |
| Target size | About 30 simultaneous sessions (a switch and 5 nodes each) |
