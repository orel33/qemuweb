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
  - Runtime path longer than 49 characters (a node's sockets must fit in 107 bytes) is only reported when the first
    node is created: check it at startup, in the server and the runner, with the `--runtime` hint (or shorten the
    socket paths with a short alias directory).
  - `status.sh`, `killall.sh` and `cleanall.sh` only know the default `runtime/`: add `--runtime DIR` to each.
  - Small fixes: a runner with an unreadable `config.json` still prints `✓ config.json  0 systems` after the error (it
    should print a ✗ and abort); `start.sh` says "stopping the runner" although none was started when the server refuses
    its options (and the status propagation is to be checked by hand: `./scripts/start.sh --session-hours 0` must exit
    2 at once and leave nothing running).
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

- [ ] **LOD01** (L) Load test of about 30 simultaneous sessions (a switch and 5 nodes each) on the server, the pool and
  lab workstations: memory and CPU measured, no VM killed, a responsive interface. Balance by free memory instead of a
  session count if the test shows it is needed.
- [ ] **QUA01** (M) Quality.
  - Run the manual test sheet on the production server without a deviation; unit and integration tests green; PDFs and
    README up to date.
  - Open defects: the "switch consoles" button is not greyed out when the view is driven (Follow checked, or owner under
    admin control) although it carries the `view-control` class (not reproduced by reading the code; find the exact
    case); a `monitor` view received before the node data says Monitor is supported falls back to the console and is
    not applied again later; the test harness kills only `start.sh` after 12 s, so the server and the runner, in
    their own sessions, could survive a hung stop (`test/integration/qemuweb-client.js`); the lines written to the Log
    view by Clear have no timestamp.
  - More `config.json` warnings at startup (beyond the engine, KVM and serial port checks).

**Done when**

- [ ] The 30-session load test passes with no VM killed.
- [ ] The manual test sheet is run on the CREMI server without a deviation.
- [ ] The PDFs and the README are up to date.

## Milestone 10: Graphic view and finishing

- [ ] **GRA02** (L) Several floating consoles: up to 4 overlapping windows, cascaded, a click brings one to the front,
  each movable, resizable and closable, built on the 4 existing panes (today only one floating window exists: the
  selected node's pane, `public/graphic-console.js`; a double click on another node reuses it). To decide: the maximum
  number of windows; observer and Follow behaviour (disabled under Follow, as today); whether the geometry is kept
  until a reload or saved; whether the windows stay independent of the per-user Terminals layout. An alternative is a
  docked panel under the graph.
- [ ] **GRA03** (M) Remaining points.
  - No IP address on the cards: QemuWeb does not know a guest's address without a guest agent (or a startup-script
    convention that reports it).
  - Touch: the view pans with one finger and zooms with the buttons only; no pinch zoom.
  - The position and size of the floating console are kept only until the page is reloaded.
  - A link is removed by disconnecting the interface, which stays; removing the interface itself is only in Host
    Settings.
  - Disabled view controls have no tooltip saying why (view driven by the owner or by the controlling admin).
  - Clear: the guard that decides whether `stty rows N cols M` may be typed is a heuristic on the cursor line (trimmed
    line ends with `#`, `$`, `%` or `>`, cursor at the end), not covering other prompts (`]`, `:`, `λ`, zsh symbols),
    wrapped long prompts, or REPLs whose prompt ends with `>` or `$` (python, sqlite, ssh). Ideas: a pure function with
    a unit test over many prompts; or let the guest announce its prompt (`PS1` in `prepare.sh`).
  - A pass on large networks (DMZ, gateways) and on small screens.

**Done when**

- [ ] Several floating consoles show at once and are driven by mouse and keyboard.
- [ ] The manual checks of the Graphic view all pass, on a desktop browser and at phone width.

## After 1.0.0

- OpenID Connect built into QemuWeb (no front end), with the directory groups mapped to roles; today Apache does it.
- Course subjects: the administrator publishes a session ZIP as a template, and each student instantiates it.
- A teacher role distinct from the administrator, limited to their groups' sessions.
- Other single sign-on systems are already supported through `--auth proxy` (see `docs/deployment.md`).

## Backlog

Things noticed with no milestone yet. Move one into a milestone when it is scheduled, delete it when done.

- Merge `docs/remote-runner-test.md` with the deployment documents once the runner choice is settled (see DOC01).

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
