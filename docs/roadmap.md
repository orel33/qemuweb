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

## Where we are (main after 0.9.6)

| Milestone | Content | Version |
| --- | --- | --- |
| 1 to 4 | Session and node naming, modular refactoring, multi-user accounts, admin role | 0.9.0-beta.1 to beta.4 |
| 5 | Local runner as a separate process, remote runners (registration token, authenticated WebSocket, placement, grace period, administration) | 0.9.0-beta.4.1 to beta.5.1 |
| Docs, graph | PDF documentation, Graphic view rebuilt (GRA01), README and documentation split into `docs/` | 0.9.0-beta.5.2, beta.5.3 |
| CREMI | Apache and OpenID front end, `--auth proxy` (shared `X-Proxy-Key`), accounts without password, Connections panel and WebSocket test in `/admin` | 0.9.0-beta.5.4 |
| Stabilisation | File formats back to `schemaVersion` 1, demo archives rewritten, session ZIP named `qemuweb-session.zip`; remote runner validated at the CREMI (registration, placement, network cut, revocation) | **0.9.0** |
| Auth and capture | `--auth password|proxy` only (expired SSO session, two shared keys for a rotation); traffic capture: PCAP of a host interface through QEMU's `filter-dump`, a Capture button and dialog in the pane bar (Play, Stop, Download, live view inside, saved at once, discarded at close) | **0.9.1** |
| Files and dependencies | One **Load** menu (From User Files, From Server examples) and one **Save**; Load Session and Load Topology share one dialog style and always close the previous session; `examples/` (renamed from `demo/`) with `--examples`; `tcpdump` a declared dependency of the runner (`TCPDUMP` in `.env`) | **0.9.2** |
| Admin tabs, VirtualBox, engine per session | The Admin page in tabs (Sessions, Accounts, Runners, WebSocket, Logs; the tab in the URL; only the visible tab refreshes; badges); the VirtualBox engine repaired (clear start errors, a runner-wide KVM/VirtualBox exclusion that names no other session, a dialog for start failures, cleanup without `--delete`, `status.sh` showing `vbox` hosts); **Engine:** selector in the header, changeable while the session is idle; `host.json` format 2 with settings per engine (`keyword:qemu`, `keyword:vbox`); working disks per engine (`disk.qcow2`, `disk.vdi`) in the session ZIP | **0.9.3** |
| Prepare and ttyS1, runtime directory | Alpine and OpenWrt images built behind the HTTP proxy (PRP01), ttyS1 empty-console hint and `prepare.sh --list` notes (BUG10, BUG01), default runtime directory `/tmp/qw-<login>/<port>` (TOD02) | 0.9.4, 0.9.5 |
| Guest agent, prepare.sh command line | Live address with prefix of each interface in the Graphic view through the QEMU guest agent, `scripts/guest-agent.sh`, `guestAgent` profile keyword, `config.json` schema 2 (GAG01); `prepare.sh` lists by default, `--system <id\|all>` or `--all`, `--parallel[=N]`, the log path printed (PRP02, PRP03) | **0.9.6** |
| Runner model (RUN03a to f) | The local runner is a runner like the others: it connects over the WebSocket with a token file (`--local-runner`), the Unix socket is gone; one identity model (`runners.json` schema 2, no trusted flag); one directory per process (server `<port>`, runner `l-<port>`, `r-<id>`); the server touches no file of a runner; `bindings.json`, sessions restored offline at start, one grace rule, forced loss; CREMI units and upgrade procedure | main, not yet released |

Formats: from 0.9.0, every change of a format increments its number and comes with an explicit decision on
compatibility.

## Order of the work

1. **The two priority features first** (below): they are what the labs ask for, and they are independent of the rest.
2. **Reliable operation first** (milestone 6): little code, a large gain for whoever runs the server.
3. **Reliable runners before personal runners** (7): sessions that survive, forced loss, then the student's own runner.
4. **Hardening before opening** (8): personal runners, guest access and the whole class are only opened once the
   protections exist.
5. **Load at the end** (9): the 30-session test validates the whole.

Each milestone is released as a beta `1.0.0-beta.N`, with the usual rules: tasks in visible sessions, tests on the
user's order, local merge, manual test, then the tag.

| Milestone | Title | Size | Depends on |
| --- | --- | --- | --- |
| next | Priority features: traffic capture, host services | large | none (IMG01 helps) |
| 6 | Operation at the CREMI | medium | none |
| 7 | Reliable runners and personal runners | large | 6 (partly) |
| 8 | Hardening | large | 7 (validation of runners) |
| 9 | Load and quality | medium | 6, 7, 8 |
| 10 | Graphic view and finishing | medium | independent |

Sizes of tasks: S about an hour, M half a day, L a day or more.

## Priority features (next)

Two features for the labs, decided as the top of the list. They are independent of milestones 6 to 10 and can start at once.

- [ ] **PRN01** (L, **priority**) **A student registers their own runner.** A user with the role `student` can create a registration
  token and enroll a machine of theirs as a runner that **belongs to them**, without an administrator (today only an administrator
  creates tokens, in `/admin -> Runners`). Design: "Personal runners (design)" in milestone 7. What already exists helps: a
  registration token already records who created it (`by`, returned by `redeem`), and the runner registry already has an
  `ownerLogin` field (`server/runner-registry.js`, "reserved, unused"); `pickRunner(login, ...)` already receives the login and ignores it.
  - **Server**: routes open to any signed-in account (`/api/my-runner` or similar: create a token, list my runner and my pending
    tokens, revoke), the token and the runner record in `runners.json` get the owner's login, the registration route copies the creator's
    login to the new runner, the registry sets `ownerLogin`; a student sees and revokes only their own, an administrator sees
    every runner with its owner in `/admin -> Runners`.
  - **Limits**: one personal runner per user to start with, a registration token valid 15 minutes and single use, a small number of
    creations per day and per user (stored, so a restart does not reset it), at most the existing cap of pending tokens.
  - **Placement** (`pickRunner`): a **new or loaded** session of a user goes to that user's own runner when it is online, otherwise to the
    shared pool as today; an existing session stays where it is (Save then Load moves one); a personal runner accepts **only its owner's
    sessions**, never another user's (the one isolation rule, kept before any quota); a shared runner never receives a runner token
    of a student. A session whose runner is offline shows "runner offline" and comes back when it reconnects.
  - **Trust, said plainly**: in this first slice the server does not yet validate everything a student's runner sends (that is SEC03, in
    milestone 8): until then personal runners are for **trusted students** (beta), the runner only ever receives commands for its owner's
    session, and the token, the owner and every action are audited (`users.log`, `admin.log`). No quotas yet.
  - **Tests**: the routes and rights (a student can create, list and revoke only their own; an administrator sees all; a third party
    cannot use someone's token), the registration with an owner, the placement rules (own runner first, never another user's, fallback to
    the pool, existing session stays), the limits and the daily counter; the full path by hand with a second machine.
- [ ] **PRN02** (M, **priority**, after PRN01) **The "My runner" page and the offline message.** In the account menu of every signed-in user:
  create the token (shown once, with its expiry), the command to paste (`./scripts/runner.sh register --url URL --token TOKEN`, then
  `run`), the state of my runner (online, offline since, engines, memory), revoke it, and a short help text of what a personal runner is
  and what the student's machine needs (QEMU, VDE, Node, the images: until PRN03, the local `images/` built by `prepare.sh`). The session
  bar shows "Running on: my runner / the server" and "runner offline" when the runner of the session is away. Disabled with a reason when
  the server has no public URL for runners configured. English UI text, phone width, unit tests for the pure parts, the user guide and
  the install documents (a short "Run your own runner" section), a manual check with a second machine.
- [x] **VBX01** (M, **PRIORITY: repair**) The **VirtualBox engine no longer starts a host** (reported by the user on 20 November 2026). Nothing in the engine
  code changed since 0.9.0 (`runner/engines/vbox.js` is untouched; the runner changes since then are the capture hooks and the
  TCPDUMP check, which do not run for a VirtualBox host), and the runner's start-up check still finds `VBoxManage`, so the
  interface still offers the engine: the failure is when a host starts, or in the system around it. Facts read on the user's
  machine (read-only, nothing started): `VBoxManage` 7.1.14 from Oracle's `virtualbox-7.1` package; the Ubuntu 6.1.50 package
  `virtualbox` is removed (state `rc`: configuration left behind), so VirtualBox was moved from 6.1 to 7.1 at some point; the
  `vboxdrv` module loaded is 7.1.14 and matches `VBoxManage`; `Extension Packs: 0`; the user is **not** in `vboxusers`;
  `/dev/vboxdrv` is `root:root 0600` because of `/etc/udev/rules.d/60-vboxdrv.rules` (`vboxdrvu` is 0666), so an unprivileged
  user cannot open the full driver; the KVM modules are loaded (QEMU hosts use KVM at the same time); the VDE driver of VirtualBox
  (`DrvVDE`, which loads `libvdeplug.so`) is present and `libvdeplug.so` exists. The engine's commands were written against 6.1 and
  have never been checked against 7.1. Candidate causes, to settle with the real error (the `VBoxManage` line that fails is in the
  Log view of the host): (1) the device access (group `vboxusers`, the udev rule) or VirtualBox and KVM both wanting VT-x/AMD-V,
  which is a message of `startvm`; (2) an option or a value of `modifyvm`, `storagectl`, `createmedium` or `--nicgenericdrv VDE`
  that 7.1 renamed or refuses (the NIC types, `--ostype`, the controller names, `--diffparent`, `--boot1`...); (3) the VDE driver
  failing to connect (`Failed to connect to the VDE SWITCH`, the socket path or the `[port]` syntax); (4) leftover VMs or
  media of an earlier failed run in the VirtualBox registry (`unregistervm`, `closemedium`).
  - **Step 0, diagnose**: get the exact failing command and message (the Log view, or run the sequence of
    `virtualBoxCommands` by hand for a throwaway VM in a temporary directory, with the user's authorisation to start a VirtualBox VM);
    say which candidate it is, with the evidence.
  - **Step 1, repair** the engine for VirtualBox 7.1 (and keep 6.1/7.0 working only if it costs nothing; the supported version is
    the one installed here), clean up on failure (the existing `catch` already unregisters and deletes: check it works), and fail
    with a **clear message in the host's Log and in the UI** that names the cause (for example "VirtualBox cannot open
    /dev/vboxdrv: add yourself to the group vboxusers"), not a raw `VBoxManage` error.
  - **Step 2, prevent a repeat**: a start-up check of the runner that goes further than `--version` (the user's group and
    the device access, the loaded module version against `VBoxManage`) and prints a warning line in the same table; a unit
    test with a fake `VBoxManage` for each command of the sequence and each failure message; `docs/install.md` (VirtualBox
    section: supported version, the group, the udev rule, KVM and VirtualBox together) and `docs/reference.md`; and a manual
    check sheet for a VirtualBox host (start, console, network on a switch, stop, remove) in `test/tests.md`.
  - **Done when**: a VirtualBox host (Alpine and Debian 13 Legacy) starts from the interface, its serial console works, two hosts
    ping each other through a VDE switch, stop and remove leave nothing in the VirtualBox registry, and a failure shows its cause.
- [x] **CAP01** (L) Traffic capture. Students analyse what their machines exchange: a button starts a capture on an
  interface of a host (`host/eth0`) or on a link (the "cable" between a host interface and its switch), and the result
  is a PCAP file to download and open in Wireshark. A live view runs in a terminal of the Terminals view.
  - **How to capture, per host interface.** QEMU can dump the frames of one NIC itself, with no help from the guest:
    `-object filter-dump,id=cap-ethN,netdev=<id>,file=<node dir>/capture-ethN.pcap` (the `netdev` ids already exist in
    `runner/engines/qemu.js`, one per interface). It can be added and removed while the machine runs with the monitor
    (`object_add` / `object_del` over the HMP socket the runner already drives), so a capture starts and stops without a
    reboot. The file is a standard PCAP, both directions. The "link" in the Graphic view is exactly that traffic, so a
    capture on a link is a capture on the host interface at its end. **To verify first** on the QEMU in use (11.1.3):
    `object_add filter-dump` through HMP, the direction option, and a bound on the file size (the runner must stop a
    capture that reaches its limit).
  - **Capturing a whole switch** (all ports) is different: a VDE switch only forwards a frame to the ports that need it.
    Options to study: the switch in hub mode (a mode of `vde_switch`, from its management socket) with a plug that
    writes a PCAP, or one capture per port. Second step, after the per-interface capture works.
  - **Server and runner.** Runner commands to start, stop and list the captures of a node (the file lives in the node's
    directory, removed with it), a download route that streams the file from the runner (remote runners included; same
    streaming as session archives, size-limited), and the audit log of who started what. Routes for the node's owner
    and for an administrator who took control; read-only observers can neither start nor download.
  - **Interface.** In the Graphic view, a link popover **Capture** (start, stop, download); in Host Settings > Network, a
    capture button on each interface; a recording indicator on the node and the link; a list of the captures of a
    session with their size and a **Download** button. Disabled with a reason when the host is stopped or in observation.
  - **Live console.** A new view of a console pane, next to Console (ttyS0), Console (ttyS1), Monitor and Log:
    **Capture**, that shows the packets as text while they arrive, as `tcpdump` would. The runner reads the growing PCAP
    with `tcpdump -l -n -r -` (or `tshark`) and sends the lines to the pane like any console output; an optional filter
    expression (BPF) typed by the student is passed as one argument, never through a shell, and checked for length.
    `tcpdump` (or `tshark`) becomes a prerequisite of the runner's machine, in the install documents.
  - **Guest side stays possible.** With `tcpdump` in the image (IMG01) a student can still run it in a serial console;
    CAP01 is the complement that needs nothing in the guest and delivers a file.
  - **Later.** VirtualBox hosts (`VBoxManage modifyvm --nictrace`) as the same feature for the other engine; a capture
    filter at start; limits and quotas (milestone 8: size per capture, number of captures per session).
  - Unit tests for the runner commands and the routes with a fake monitor; the real capture is checked by hand with a
    `ping` between two hosts and the file opened in Wireshark. Documents: user guide (a section "Capturing traffic"),
    `docs/json-files.md` if a capture is described in a file, runner prerequisites.
- [x] **CAP01** delivered (merged 20 November 2026, validated by the user on the demo). The user wants the capture to be more
  intuitive: see CAP02.
- [ ] **CAP02** (M) A more intuitive capture interface, from the user's feedback after trying CAP01 (to be completed with what
  was confusing). Ideas to weigh: one **Capture** control where the student already looks (the node card and the link in the
  Graphic view, the toolbar of a console pane) instead of Host Settings > Network; start and stop as one toggle with the
  recording state in place; pick the interface by what it is connected to ("eth0, to switch lan") rather than by number;
  a default start that needs no choice (the only connected interface); the capture list and the live view next to each
  other, with **Open live view** and **Download** one click away from a recording; clearer wording and one short hint on
  first use ("Capture records what this interface sends and receives; open the file in Wireshark"); a sensible file name
  with the host and interface. Keep the existing rights, limits and audit.
- [x] **CAP02** delivered (merged 20 November 2026): Capture button in the pane bar, Capture dialog, the double scrollbar fixed (BUG09).
- [x] **CAP03** (M) Delivered (0.9.1): simplify the capture dialog (user feedback after trying CAP02). A capture is saved at once or lost: no
  "All captures" tab and no kept list. **Stop** downloads the PCAP through the browser (its download manager keeps it);
  closing the dialog deletes the host's leftover capture files (stopping and downloading first if one is still recording, so
  nothing is lost). The **live view moves into the dialog**, under the controls (a read-only text area with an optional
  filter), and the fifth "Capture" view of the console panes is removed: it is no longer an extra console.
- [ ] **HSV01** (L) Host services. A **Services** tab in Host Settings lists the services a host can run (DHCP, DNS,
  web server, FTP, telnet...) as checkboxes; the chosen ones start at the next boot (the interface offers **Apply and
  reboot**).
  - **What can be chosen.** Only services that exist in the image: a catalog per system in `config.json`
    (`services`: unit name, label, package, a short description), the units installed but disabled in the image, so
    the checkbox list is the same for every host of that system and no arbitrary unit name can be typed. The image
    must therefore carry the packages (`isc-dhcp-server` or `dnsmasq`, `bind9`, `apache2`, `vsftpd`, a telnet server...)
    **installed and disabled**: this is a choice to make together with IMG01 (a lighter image against more services
    available; a variant "network services" image is the alternative).
  - **How it is stored and applied.** `host.json` gets a list of the enabled unit names (a new field, so `schemaVersion`
    stays 1 only if the field is optional with a default of empty: decide and write the compatibility decision per
    `docs/json-files.md`). At start, the startup disk (the ISO the runner already builds from `start.sh`) carries a file
    with the list, and the guest's `qemuweb-start.service` runs `systemctl enable --now` on each listed unit before the
    user's script; the host then has them whether or not the lab script also configures them. The startup disk must be
    enabled for the host: the tab says so, or turns it on.
  - **The lab still configures the service.** The tab starts the daemon; its configuration (a `dhcpd.conf`, the DNS zone,
    the web pages) comes from the startup script and its extra files, which exist already. A short guide section shows
    one example per service.
  - **Interface.** The tab shows the services of the host's system with their state at the last boot (from the Log
    view: started or failed), a checkbox each, **Apply and reboot** that saves then reboots, and a disabled state with a
    reason while the host is running without reboot allowed or in observation. Services of a **switch** are out of scope.
  - **Scope.** The Debian images (`debian13-legacy`, `debian13-cloud`, systemd). Alpine (OpenRC) and OpenWrt need their
    own mechanism and are not part of the first delivery.
  - Unit tests for the catalog validation (unknown unit names rejected), the host file, and the startup-disk content;
    the boot with a service enabled is checked by hand (a DHCP server answering another host, a web server answering
    `curl`).
- **Done when**
  - [x] A student starts a capture on a host interface, runs a `ping` and downloads a PCAP that Wireshark opens and that
    shows the ping.
  - [x] The capture dialog shows the packets live.
  - [ ] A host started with the DHCP service checked answers a DHCP request from another host without the student
    installing or enabling anything.

## Milestone 6: operation at the CREMI

What separates a deployment that works from one you can operate calmly.

- [x] **AUT01** (M) Authentication. Delivered (merged 20 November 2026, tested on the CREMI server in part: the expired-session reload and the key rotation were not exercised by hand); the group-to-role rule is left open in the Backlog.
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
- [x] **PRP01** (S) `prepare.sh`.
  - The Debian ISO and its `SHA512SUMS` come from `cdimage.debian.org`, which the CREMI squid has answered 503 for:
    a setting for the base URL (or another host), or document placing both in `sources/debian13-legacy/` by hand.
  - Alpine and OpenWrt builds do not use the proxy yet.
  - The failure strings and phase markers of `scripts/prepare/lib/common.sh` are still unchecked against a real log.

- [ ] **RNR01** (M, **to decide, context saved on 23-24 November 2026**) Simpler command line of `scripts/runner.sh`
  (local and remote runners). **Not started: the user is not sure of the choice yet**; this entry keeps the whole reasoning so that it can be resumed.
  - **Today** (main, after RUN03 and LST01): `runner.sh [options]` without a command = the LOCAL runner (`--port`, `--host`, `--token-file`,
    `--runtime`, `--exit-on-disconnect`); `runner.sh register --url U --token T [--name N] [--insecure] [--ca F] [--runner-config F]` once,
    then `runner.sh run --url U [--insecure] [--runner-config F]` for a REMOTE runner. `--help` now starts with a Commands block (commit 17fe234).
    The two typical scenarios (server and local runner on one machine; server on `prout` and remote runner on `tralala`) are on one page:
    [run-commands.md](run-commands.md).
  - **The user's proposal** (verbatim idea): `runner.sh local [options]` = register and run implicit in local (`--bind 127.0.0.1` by default,
    `--token-file` option); `runner.sh remote [options]` = register and run implicit in remote (`--bind 0.0.0.0` by default, `--token` option).
  - **Assessment** (orchestrator): coherent for two explicit commands, and `remote` doing register-then-run in one command; BUT `--bind` is the
    address a **server listens on**, and a runner listens on nothing (it dials out, no inbound port): the equivalent for a runner is the address of
    the **server to reach**: `local`: `--host ADDRESS` (default 127.0.0.1) and `--port` (default 3002), as today; `remote`: **`--url` required**
    (no default; `0.0.0.0` is a wildcard, not a destination). Adjustments proposed: (1) `remote` registers only if there is no runner file (then
    `--url` and a token are required), otherwise it just runs; a token given while the runner file exists is an explicit error (single use);
    (2) `remote --register-only` (register and exit) so that the CREMI can register once by hand and let a systemd unit run it; (3) the
    registration token must not stay on the command line (visible in `ps` for its validity): `--token-file` or standard input (decision Q12 of
    [runner-model.md](runner-model.md)); (4) `register` and `run` disappear (beta rules: no old command kept), so `start.sh`
    (`runner.sh --port ...` becomes `runner.sh local --port ...`), `deploy/cremi/qemuweb-runner.service` and the remote unit example,
    `remote-runner-test.md`, `deployment.md`, `reference.md` (tables tested word for word against `--help`), `install.md`, `run-commands.md`,
    the tests and the `--help` text must follow; (5) `runner.sh` with no command prints the help instead of starting the local runner (a typo must
    start nothing).
  - **Open questions for the user**: keep `register` / `run` as they are (and only improve the help, already done), or the two commands `local` /
    `remote`? Keep `register-only` as a flag or a separate command? What bothers him today: the number of commands, the token on the command line,
    `--insecure`, or the vocabulary?
  - **Acceptance if done**: `runner.sh local` and `runner.sh remote --url ... --token ...` start a runner; the second start of `remote` needs
    no token; a wrong combination gives a clear message (exit 2); the token never appears in `ps` when given by file or stdin; `--help` of each
    command lists only its options; the CREMI units and the tutorial are updated in the same task.
- [ ] **LST02** (M, idea, **not started**) HTTPS served directly by the server, the follow-up of LST01 (`--bind`). Design proposed by the LST01 session:
  `--tls-cert FILE` and `--tls-key FILE` (https and wss on the same port; Socket.IO and `/runner/connect` unchanged; an unreadable certificate or a
  key that is not mode 0600 is refused at start-up), a helper `scripts/make-cert.sh` (openssl: a local certificate authority and a server
  certificate whose subject alternative names are the IP addresses and names of the machine, key 0600), `runner.sh --ca FILE` (already exists) so
  that `--insecure` is no longer needed on a LAN, the session cookie `Secure` directly (`req.secure`), `--no-auth` still refused off loopback,
  proxy mode unchanged, `/admin` showing https commands with `--ca`, and the warning for a non-loopback bind replaced by one about a self-signed
  certificate. Docs: deployment (TLS directly or behind nginx) and a variant D of [remote-runner-test.md](remote-runner-test.md); tests for the
  options, the https banner and the derived URLs (the local runner over https/wss with `--ca`). Remaining risk: certificate lifetime and renewal
  are the administrator's job; nginx/Apache in front stay the recommended production setup (the CREMI).

**Done when**

- [x] `--auth` has only `password` and `proxy`, and the CREMI server runs in `proxy`.
- [ ] An expired SSO session sends the user back to the login, with no obscure error.
- [ ] The server and a remote runner start at boot and their logs rotate.
- [ ] One documented installation path, with no copy to keep in two places.
- [ ] A Debian image builds behind the CREMI proxy without a special option.

## Milestone 7: reliable runners and personal runners

- **RUN02** (robust runners) is **merged into PST01** below: one site on the persistence of the sessions of the server and
  of the runners. Its points are kept there, as items of the study.
- [x] **RUN03** (L, design first, **next architecture step, prepared now**) The **local runner becomes a runner like the others**: same relation to the server as a
  remote runner, only the transport differs (a Unix socket instead of a WebSocket with a token). Today it differs in
  one respect that matters: the server **shares files** with it (`docs/deployment.md`, "Files shared with the
  runner"), and only with the local runner, only when its `hello` announces the server's own runtime directory:
  `runtime/users/<login>` aliases created and removed by the server, the session directories removed by the server
  when a runner is lost, the empty `sessions/<id>` directories pruned at start-up, and the **adoption** of its sessions
  after a server restart (`entry.trusted`, in `server/session-manager.js` and `server/runner-gateway.js`). The default
  runtime directory (TOD02) is therefore one directory per port, shared by the server and its local runner.
  - **Goal.** The runner owns its directory (for example `/tmp/qw-<login>/runner-<id>`, or the one given with
    `--runtime`), the server owns its own (`users.json`-side data, `runners.json`, logs), and **the server never writes
    in the runner's files**: everything passes through runner commands. One code path for every runner, so what is
    tested for a remote runner (PST01, SEC03) is what runs at the CREMI. A server and a runner can then be on two
    machines, or in two containers, with no shared disk.
  - **Move to the runner** what the server does through files today: the `users/<login>` aliases (a runner command,
    or dropped: they only help administrators; if kept, the runner creates them under its directory and `/admin` shows
    the path), the removal of the sessions of a lost runner (a `session.delete` command when it returns, as for a remote
    one), the pruning of empty session directories (the runner does it for its own directory), and the adoption of the
    sessions after a restart of the server (the same persisted session-to-runner binding as PST01 (former RUN02): it must work for
    any runner that proves its identity, the local one included, with the trust decided by the registration and no
    longer by "the Unix socket").
  - **Identity and trust.** The local runner is still the only one allowed on the Unix socket and still has the
    admin-given `local` identifier, but "trusted" stops being a property of the transport: decide what the hello of a
    runner may claim (its sessions, its owners) and how the server verifies it (a token or a socket credential,
    `SO_PEERCRED`), so that a student's runner (PRN01, SEC03) is never trusted by accident and the local one needs no
    special case in the placement.
  - **Runner identifier in the directory name.** A remote runner has no port: its default directory must be unique per
    runner (not the word `runner` alone, which two runners of the same account would share), for example derived from
    its identifier, within the 107-byte budget of TOD02 (`common/runtime-dir.js` computes it from the real layout).
  - **Scripts and tools.** `start.sh`, `stop.sh`, `status.sh`, `killall.sh` and `cleanall.sh` work per runtime
    directory: they must handle the server's directory and the runner's directory as two things; the integration tests
    `check-runner`, `check-runner-manual`, `check-load-start`, `admin` assume the shared directory and are rewritten.
  - **Order.** RUN03 comes **first**: it fixes who owns which files, which PST01 (persistence of the sessions, with the
    former RUN02) then builds on; both describe the same link between a session and its runner. Deliverable of the
    design step: a written decision in `docs/architecture.md` validated by the user (what the server may still read,
    how the aliases are served, the trust model, the migration of the tests), then implementation tasks. No code
    before the decision.
- [ ] **PST01** (L, study first, **includes the former RUN02**) Persistence of the sessions of the server and of the runners:
  what survives a hard reboot, a power cut, a network cut, a crash of the server or of a runner. **Nothing is decided
  yet**: the study proposes several policies (below) and the user chooses. It follows RUN03, which fixes who owns which
  files. A **design study** whose deliverable is a written document (a new section of
  `docs/architecture.md`) with a recommendation and the options below, validated by the user **before any code**.
  - **Inventory today.** For each event, what is kept and what is lost: server restart (local runner adopted again,
    remote runner dropped), runner crash or restart (machines gone, session deleted as `runner lost`), reboot of the
    whole machine (QEMU and VDE dead; disks, `session.json` and `meta.json` stay under `runtime/`, nothing reads them
    back), network cut between a remote runner and the server (`--runner-grace`), loss of the browser (the session
    survives). Check by reading and by a measured, authorised test on a throwaway runtime directory: what is left on
    disk after a SIGKILL of the runner and after a machine reboot, and whether a session can be rebuilt from it.
  - **What can be persisted**, from cheap to costly: the session description only (nodes, links, settings: it is
    already a ZIP-like state in `session.json` and `host.json`); plus the working disks as they are (a hard stop of a
    guest is a power cut for its filesystem: ext4 journal replay, possible data loss); plus the **memory and device
    state** of a running guest (QEMU `savevm` / `migrate` to a file: a true resume, large and slow, only on request).
  - **Policies for the runner** at start-up, to compare: *discard* (today: the sessions on disk are cleaned);
    *keep, restart nothing* (the session reappears stopped, with its disks, and the user presses Resume all);
    *auto-resume* (the hosts that were running start again, in the order of their switches, with a cap on the number
    and the memory to avoid a boot storm); *per-session choice* (a setting "restore on restart" kept in the session).
    Include the **periodic autosave** of the session description (and optionally of the disks' state) so that a
    hard cut loses little, the disk cost per session and a quota for it, and the interaction with the observation
    rules and with the paused state of the runner.
  - **Policies for the server**: where the session-to-runner binding is kept (`runners.json` or a new file, shared
    with the former RUN02 items), what happens to a session whose runner does not come back (grace period, then *keep as stopped data*
    or *delete*), the order of the events when both restart together (a reboot), `--runner-grace` per kind of runner
    (a lab workstation that sleeps is not a crashed server), what the user sees (a banner "session restored, machines
    stopped", an explicit Resume) and what the administrator sees in `/admin` (restorable sessions, a Discard button).
  - **Remote and personal runners** (PRN01): a student's workstation that reboots or sleeps must not cost the
    session; decide whether the data is kept on the workstation, uploaded to the server (a periodic ZIP, size and
    privacy limits) or lost, and what happens when the user opens the session elsewhere.
  - **Consistency and cleanup**: stale sockets and VDE directories after a hard cut (see TOD02: sockets in a short
    private directory are recreated), PID and lock files, the VirtualBox machines left registered (remove by exact
    name only), disk space reclaimed from abandoned sessions, a retention time.
  - **Items of the former RUN02**, to settle in the same study: persist the session-to-runner binding (a restart deletes
    every session of a remote runner today although its VMs could keep running, as for the local runner; the hello of
    an untrusted runner is never adopted); let the administrator **force the loss** of the sessions of a revoked or lost
    runner without waiting for `--runner-grace`; keep the paused state of the local runner (a remote runner's is in
    `runners.json`); test the re-selection of the console after a runner comes back (`runner-state`) in a real browser
    (only the socket events of `check-runner-remote` are tested today); restrict `/runner/connect` and
    `/api/runner/register` by address when the runners are known.
  - **Output**: a table "event x policy" with the user-visible result of each, the recommended default policy for the
    CREMI server (a trusted local runner) and for a student's runner, the data format changes it implies (schema
    versions, with the explicit compatibility decision), and the split into implementation tasks (for example the
    autosave, the restore at start, the binding, the `/admin` controls, `SVC01`'s boot recovery). Related: RUN03 (first),
    SVC01, PRN01, NET02 (checkpoints), HSV01.
- **PRN01** and **PRN02** (personal runners: server side, and the "My runner" page) are **priority features**: see the top of the roadmap. The design below applies to them.
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

- [x] **FIL01** (M) Delivered (0.9.2). **One Load and one Save** for topologies and sessions, with the server's examples (the `demo/` directory becomes `examples/`). Today the bottom-left
  toolbar has four buttons for files: **Load topology**, **Save topology**, **Load session ZIP** and **Save session ZIP**,
  and loading only opens a file of the user's own computer, so the shipped examples (`examples/*.topo`, `examples/*.zip`: `lan`,
  `gw0`, `gw1`, `dmz`, `dmz0`, `dmz1`) must be fetched from the repository first. Wanted (user proposal): **two buttons that keep
  the icons of Load session and Save session**, and the two topology buttons go away.
  - **Load.** One dialog with a file picker that accepts `.topo` and `.zip`, and under it a list **Examples** of the
    files of the examples directory (name, size, a one-line description if the file has one). The kind is told by the extension and
    checked on the content (a ZIP starts with `PK`, a topology is text): a mismatch is refused with a clear message. A `.zip`
    goes on into the existing review dialog (summary, warnings about changed base images, **Start hosts and switches after
    loading**, **Discard working disks**); a `.topo` goes through the existing topology load. A click on a server file loads it exactly
    as an uploaded one (same validation, same warnings, same placement on a runner). Keep the rule that a session can only be
    loaded into an empty one, and say it in the dialog (with a shortcut to the reset of UXS02 once it exists).
  - **Save.** One dialog with the checkbox **Save only the topology (.topo)**, unchecked by default. Unchecked: the existing session
    ZIP options (include working disks, the size estimate, the progress) and `qemuweb-session.zip`. Checked: the disk options
    disappear and the topology text file is downloaded. The last choice may be remembered in the browser.
  - **Server.** `GET /api/examples` lists the regular files with the extensions `.topo` and `.zip` of the directory, sorted, and a
    load route takes only a **file name** (no path), checks it against that listing and feeds the file to the existing
    load pipeline from disk instead of an upload; the remote runner path streams it as now. The directory is `examples/` of the
    repository by default (renamed from `demo/`: *demo* names a demonstration, and `scripts/demo.sh` keeps its name), and an option `--examples DIR` (documented in `docs/reference.md`) lets an administrator point it
    elsewhere, for example a shared folder where a teacher puts the subjects of a lab (a first step of the "course subjects" idea
    of the section after 1.0.0).
  - **Safety.** File names only (no `/`, no `..`, no hidden files), no symlinks, regular files, the same size limits as an upload,
    the listing read again at each request (no cache of paths), read-only for the user, and the load is the user's own so the
    rights and the audit are those of a normal load. A missing directory means an empty list, not an error.
  - **Interface.** The examples list appears only when it has files. The toolbar loses two buttons; the tooltips, the documents and
    the tests that name the four old buttons follow. Do it before UXS03 (the grouping of the actions), which then puts Load and
    Save in the **Session** group.
  - **Tests.** The listing and its filters, the name validation (traversal, symlink, odd characters), the kind detection by content,
    the route rights, the loading from disk through the existing pipeline; the dialogs by hand. Documents: user guide,
    reference (`--examples`).
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
- [x] **ADM01** (M) Tabs in the Admin (Supervision) page. `/admin` (`public/admin.html`, `admin.js`,
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
- [ ] **NET01** (S) **Cut and restore a cable** on a running host. QEMU's monitor has `set_link <name> off|on`, so a link goes
  down and up under the guest (the kernel logs "link down" then "link up"), without a reboot and without losing anything.
  A **Disconnect cable** / **Reconnect cable** pair on the link popover and in Host Settings > Network, distinct from
  *Remove link* (which unplugs the interface from its switch for good); a broken link is drawn dashed and red. The state is
  runtime only: a started host has its cables plugged. **Verified in the CAP01 spike (QEMU 11.1.3): `set_link <netdev id> off|on`
  works with the netdev id (`lan0`...), and the host on the other side of the cable then sees 100% loss.** Natural companion of CAP01 (same monitor plumbing, same buttons); lab use: a link
  failure and the reconvergence of a routing protocol.
- [ ] **NET02** (L) **Restore points** for a host or a session: `savevm`, `loadvm` and `delvm` of the monitor store and
  restore the whole state of a machine (memory, devices, disk) inside its `qcow2` working disk, so a student returns to
  the state before a mistake in one click. To study: compatibility with the NICs and the consoles after a restore (the
  VDE switch is not part of a machine's saved state), the disk space of a snapshot and its place in the quotas of
  milestone 8, whether a session-wide restore point is the sum of its hosts', and the interaction with the ZIP archive of
  a session (snapshots probably stay out of it).
- [ ] **NET03** (M) **Add or remove an interface while the host runs**: `netdev_add` plus `device_add` (and the reverse)
  connect a host to another switch with no restart, instead of today's "interface changes apply at the next start".
  **Verified in the CAP01 spike**: `netdev_add` works at runtime, but `device_add` fails with "Bus 'pcie.0' does not support hotplugging"
  and a `pcie-root-port` cannot be added at runtime either, so free `pcie-root-port` devices must be declared at boot (a few per host).
  Host Settings > Network then applies live when the host runs; the guest kernel must handle the hot-plug (Debian does).
- [x] **GAG01** (L, **study then feature, extended 21 November 2026**: live address with prefix on the Graphic view, QEMU) **Feasibility of showing the IP addresses of running hosts (and more) with the QEMU guest agent.** Today QemuWeb knows
  nothing of what runs inside a guest (the cards of the Graphic view show no address, see GRA03). The QEMU guest agent
  (`qemu-ga`, Debian/Ubuntu package `qemu-guest-agent`) answers the host over a **virtio-serial channel** named
  `org.qemu.guest_agent.0`, which QEMU exposes as a Unix socket (`-chardev socket,id=qga,path=<node dir>/qga.sock,server=on,wait=off`,
  `-device virtio-serial`, `-device virtserialport,chardev=qga,name=org.qemu.guest_agent.0`); no network traffic is involved, so it fits
  IMG01 (a silent network) and the shared-folder style of channels (SHR01). Read-only commands that matter: `guest-network-get-interfaces`
  (names, MACs, IPv4/IPv6 addresses, statistics: the IP of each interface), `guest-get-host-name`, `guest-get-osinfo`, `guest-get-time`,
  `guest-get-fsinfo`, `guest-get-vcpus`, `guest-get-memory-blocks`, `guest-info` (the supported commands), `guest-ping`; commands to
  **never** expose: `guest-exec`, `guest-file-*`, `guest-set-user-password`, anything that writes (a student has root in the guest and
  the host must not become a way into it, or the reverse).
  - **Questions the study answers, with evidence from a throwaway prototype** (a QEMU machine in a temporary directory, an overlay of
    a COPY of an image, never a file of `images/` as a parent):
    1. What must be added to the QEMU command line, at launch (the channel cannot be hot-added on q35 without a free hotplug port,
       see NET03) and what does it cost (memory, boot time, one more socket per host)?
    2. Which images can carry the agent: `debian13-legacy` and `debian13-cloud` (package and systemd unit; `debian13-cloud` may already
       have it), Alpine (`qemu-guest-agent` and the OpenRC service), OpenWrt (`qemu-ga`); the size, the boot-time effect, how `prepare.sh` installs
       and enables it, and what happens on a guest that has no agent (the call times out: how fast do we know, and how do we show "unknown").
    3. Which replies are reliable at which moment (the agent starts late in the boot; an address appears after DHCP or a manual
       `ip addr`): the polling rate, the timeouts, the state "agent not ready".
    4. **Trust and safety**: the guest is untrusted. An allowlist of commands in the runner (only the read-only ones above), the
       agent's own blocklist in the image (`BLACKLIST_RPC`) as a second wall, reply size caps, validation of every address and name before
       it goes to a browser (text only, no markup), a per-host rate limit, and the agent socket never reachable by the user.
    5. **Alternatives without any software in the guest**, to compare honestly: learning addresses passively from the traffic on a host's
       interface (ARP and DHCP seen by the same `filter-dump` of CAP01; works for every guest, Alpine and OpenWrt included, but shows only
       what has been said on the wire); a command typed on the serial console (rejected: fragile and invasive); the startup script reporting
       (needs the lab to do it). Where does each win, and could the two be combined (agent first, wire as a fallback)?
    6. **What to show**: IPv4 and IPv6 per interface on the node card and its hover (the Graphic view), in Host Settings, the host name,
       the OS, uptime; later in Admin (an administrator observing a student). Which of these are worth the cost.
    7. VirtualBox hosts: the equivalent is the Guest Additions property store (`VBoxManage guestproperty`), out of scope here, say so.
  - **Deliverable**: a written feasibility note in `docs/` (or a section of `docs/architecture.md`) with the measurements, a go or no-go
    and a proposed design with its tasks (a follow-up `GAG02`: the QEMU arguments, the runner module, the server route and event, the image
    changes in `prepare.sh`, the UI), and the throwaway spike script kept out of the repository. No product code in this task, except
    what the spike strictly needs outside the repository.
- [ ] **GAG02** (M) **VirtualBox symmetric of GAG01: the Guest Additions.** GAG01 (extended on 21 November 2026 from a study to the whole
  feature for QEMU) shows the live address with its prefix on the Graphic view through the qemu-guest-agent, and carries the
  `guestAgent:qemu|vbox` profile keyword and an **inert** VirtualBox reader. GAG02 makes the VirtualBox side real: read
  `VBoxManage guestproperty enumerate <vm> --patterns '/VirtualBox/GuestInfo/Net/*'` (V4/IP, V4/Netmask converted to a prefix length,
  MAC, Name, Status, Net/Count) with `guestproperty wait` or a slow poll, publish the same `addresses` field as the QEMU engine, so the
  browser code is unchanged. Needs the **Guest Additions in the images** (`virtualbox-guest-utils` for Debian; Alpine and OpenWrt
  probably not: measure and say), set `guestAgent:vbox` true only where the VDI really has them, and a **measurement under VirtualBox**
  on a machine free of KVM guests (user authorisation, throwaway copy of the VDI, exact-path cleanup, never `--delete`
  outside the node's own directory). Same trust rules as GAG01 (guest data untrusted, strict validation, caps, informative only).
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
- [ ] **GRA05** (S) Rectilinear links in the Graphic view. A button next to the zoom buttons switches the links between the
  current Bézier curves and **rectilinear polylines** (horizontal and vertical segments only, one or two bends, the
  usual network-diagram look). A display preference of this browser, kept in `localStorage`, curves by default; it does not
  go through the view state, so Follow and observation are unaffected (an observer may use it). Only the path changes: the
  attachment points, the interface and port labels, the addresses, selection, hover, recording colour and the hit area stay.
  Unit test for the pure routing function.
- [ ] **GRA03** (M) Remaining points.
  - No IP address on the cards: see the feasibility study GAG01 (QEMU guest agent, or addresses learned from the traffic).
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

### More guests (later)

A system is declared in the catalog (`config.json`: label, memory, image, disk interface, network model, serial ports) and
built by a script of `scripts/prepare/`; the console of a host is its serial port. The current systems are Alpine, OpenWrt
and Debian 13 (legacy and cloud). Two directions widen the choice. The contract an image must satisfy (serial login as
root on `ttyS0`, the startup service that reads the startup disk, the file layout) was written in the archived
`docs/bak/image-contract.md`; recover it with `git log -p -- docs/bak/image-contract.md` and bring it back into
`docs/architecture.md` as part of the first task below.

- [ ] **GST01** (M per system) **More Linux-like and Unix systems with a serial console** ("xterm mode", like today's
  hosts). Candidates, to pick by what a network lab needs, with the cost of each:
  - **Tiny Core Linux** (about 20 MB, boots in seconds, runs from RAM, no systemd): the lightest possible host, good for
    many cheap machines; its extension system and BusyBox tools are unusual for students.
  - **A router image with an actual routing suite**: Alpine with FRRouting (OSPF, BGP, RIP) or **VyOS** (Debian based),
    since routing labs are the strongest use of a virtual network.
  - **FreeBSD, OpenBSD, NetBSD**: another TCP/IP stack and the `pf` firewall, a good contrast in a network course; they
    boot on a serial console and take a VDE interface through the usual models.
  - **Another Debian-family or RPM system** (Ubuntu or Fedora/Rocky cloud images, as the `debian13-cloud` pattern): useful
    for package and service administration labs; heavier.
  - Less likely: SliTaz or Damn Small Linux (small but old), Buildroot or a custom minimal kernel (the leanest of all,
    at the cost of building and maintaining it), MikroTik RouterOS CHR (licence terms to read first).
  First step, shared: write the image contract back into the documentation, and add one prototype (my suggestion: Tiny Core
  as the lightest, and Alpine with FRRouting as the routing host) to test the process; then each system is a `prepare`
  script, a catalog entry and a check that it joins VDE, shows a serial login and runs a startup script.
- [ ] **DSP01** (L) **A graphical display for a node**, in the browser, for machines that have a screen. Two uses: Linux
  desktops, and the Windows systems below. QEMU already offers VNC (`-vnc`) and SPICE (`-spice`); the web client for VNC is
  **noVNC** (a JavaScript client; check its licence and the build into the project, which has no bundler), and spice-html5 for
  SPICE (less maintained). Design:
  - **A new kind of view** in a pane (next to Console, Monitor and Log): **Display**, a canvas with keyboard and mouse,
    resize, clipboard if the protocol allows it, and a "view only" mode for observers (the administrator's observation
    stays read-only, control is the explicit takeover that exists).
  - **Transport**: no TCP port opened on the runner. QEMU listens on a Unix socket in the node directory (`-vnc unix:...`
    with a password), the runner relays the stream as a binary channel of its protocol (like console streams, but binary
    and with backpressure), the server relays it to the browser through Socket.IO or a WebSocket under its own
    authentication. Bandwidth and latency through the CREMI relay and Apache are the risk: measure with one machine
    before anything else.
  - **Headless and graphic are both valid**: a host without display keeps `-display none` as today, a host with a graphical
    system starts with a display and a video adapter; the catalog says which (`display: "vnc"`). Without a display, a
    Windows host can still be reached by its network (RDP, OpenSSH, PowerShell) from another machine of the lab, or on
    the **Special Administration Console** over the serial port for the server editions.
  - **Cost** (to put in front of the user): a graphical guest uses much more memory and CPU than a serial Linux one and its
    disk is tens of gigabytes; the 30-session sizing of milestone 9 does not hold for them. Per-user quotas (milestone 8)
    must say how many such machines a student may start, and the pool may need dedicated runners (the placement can filter
    on a runner capability `display`).
  - Security: the stream is authenticated like the consoles, one password per machine start, never exposed on the network;
    the observer rules and the admin takeover apply to the display as they do to the consoles.
- [ ] **WIN01** (L) **Windows guests** (XP, 10, 11...), on top of DSP01. A system whose image the user supplies, **QemuWeb
  never distributes one**: Microsoft licences apply to every machine, including a classroom one; confirm with the CREMI which
  licences exist (academic agreements) before any work. Technical points to settle: **Windows 11** needs UEFI (OVMF), a TPM
  (`swtpm`) and secure boot, **Windows 10 and XP** boot with BIOS; the network adapter on VDE (`e1000` or `rtl8139` work
  without drivers, `virtio` needs the virtio-win drivers on an ISO); the **startup script** mechanism (`start.sh` on an
  ISO read by a systemd service) has no direct equivalent: a first-boot batch or PowerShell script on the startup disk, or
  nothing; **no serial console**, so a host of this kind lives by DSP01 or by its network; memory (4 GB or more per machine)
  and disk (tens of GB, working disks as qcow2 on the base image) make them unfit for 30 simultaneous students. Likely
  scope: a few shared machines used by an instructor or a small group, not one per student.

### Data exchange between host and guest (later)

- [ ] **SHR01** (L) A **shared folder** between a node and QemuWeb, so a student can move files in and out of a machine
  without a network between them. Today the only channels are the startup disk (an ISO read at boot, in one direction,
  built from `start.sh` and its extra files) and the serial console (typing, no files).
  - **Mechanism, first choice: 9p over virtio.** QEMU shares a directory of the runner's machine with `-fsdev local` and
    `-device virtio-9p-pci,mount_tag=...` (or `-virtfs`), and the guest mounts it with
    `mount -t 9p -o trans=virtio TAG /mnt/share`. It needs no daemon and no guest software, only the 9p kernel modules,
    which Debian kernels have (to verify on `debian13-legacy` and `debian13-cloud`). Alternatives to weigh: **virtiofs**
    (faster, but needs a `virtiofsd` process per share and shared memory), a **second small disk image** swapped between
    boots (simple and isolated, but not live), SMB or NFS over a management network (extra network, defeats the lab),
    and file transfer over the serial line (slow, fragile).
  - **Where the folder lives.** One directory per node in the session (`<node dir>/share/`), created on first use,
    mounted at boot by a line the startup mechanism writes, and removed with the node. Optionally a **session-wide** folder
    that several hosts mount, to exchange files between guests: useful, but it bypasses the network the lab is about, so
    it would be off by default.
  - **Interface.** A **Files** tab in Host Settings (or a pane action) lists the folder with a size, lets the student
    **upload** files and **download** one or all (a ZIP), and delete. The same upload and download streams as the session
    archives, size-limited, through the runner interface so a remote runner works. Whether the folder goes in the session
    ZIP (probably as an option, size aware).
  - **Uses.** Lab files delivered to a host (instead of rebuilding the startup ISO), results and logs collected from a guest,
    a capture file made inside the guest, and the PCAP of CAP01 next to the machine that produced it.
  - **Security, to settle before building.** The guest can write into a host directory: confine the share to the node's
    own directory, choose the 9p security model (`mapped-xattr` or `none` with a squash), forbid anything but regular files
    and directories, cap the total size and the number of files (a full disk of the runner must not follow), offer a
    **read-only** share, and treat a bug in the 9p server as a possible escape: it belongs with the jail of milestone 8
    (the runner's own account and a locked-down directory). Not for untrusted users before that.
  - Study first on the engines: QEMU only; VirtualBox has shared folders of its own (guest additions required), out of scope.
  - Unit tests for the folder handling, the size limits and the routes; a manual check that a file written by the guest
    appears in the download and a file uploaded appears in the guest.

### Engines and guests (later)

Today a host is a QEMU machine (or a VirtualBox one) running one of the prepared images, and the runner announces which
engines it has (`runner/engines/`, the hello capabilities). Three larger ideas widen what a node can be. None is a
condition of 1.0.0; each starts with a study that decides whether it is worth building.

- [ ] **ENG01** (L) A **Docker engine**: a node that is a container, connected to the VDE network like a host. The
  container gets a network interface wired to the session's VDE switch (a `vde_plug` on a tap device or a veth pair moved
  into the container's network namespace), a console through `docker attach` or `exec`, and start, stop and remove like a
  host. To study first: wiring a container to VDE needs privileges (creating a tap or moving an interface into a
  namespace needs `CAP_NET_ADMIN` or root), which conflicts with the unprivileged runner and the jail of milestone 8:
  decide whether the runner uses a small privileged helper, rootless Podman or a sidecar; what a container shares with
  the machine (the kernel) and what that means when the user is untrusted; how images are chosen (an allowlist per
  system in `config.json`, never a free image name); persistence and the ZIP archive of a container node (probably none).
  New engine capability in the runner's hello, a `container` kind of node in `host.json`, and a new mode of the
  placement (only runners that announce Docker).
- [ ] **ENG02** (L) **Docker images as virtual machines through b2c** (boot2container): a tiny kernel and initramfs boot
  a container image as the whole userspace of a QEMU machine, so a Docker image runs as a **real VM**, with its own
  kernel, a real network interface on VDE and a serial console. This avoids the privilege and trust problems of ENG01,
  since the guest is a normal QEMU machine, at the price of a boot (fast) and a kernel per node. Study: the b2c version to
  use and how it is fed (image, command line, the registry access through the outbound proxy), serial consoles, how to
  describe such a host in the catalog (a system whose image is a container reference rather than a disk), and caching of
  the pulled layers on the runner. To verify on the actual project (I have not run it here).
- [ ] **ENG03** (L) **macOS virtual machines** under QEMU/KVM. Technically possible with a recognised boot loader and
  suitable virtual hardware (a Penryn-like CPU model, OVMF, a supported disk and network adapter), with no VDE-specific
  obstacle. **Licence first**: the macOS licence allows macOS in a virtual machine only on Apple-branded hardware, so
  QemuWeb can neither distribute an image nor run it on the CREMI's servers; the feature, if it exists, would be an
  option that a runner on a Mac (or a user holding a licence on a Mac) enables, with an image the user supplies. Decide with
  the CREMI whether this is acceptable at all before any technical work; if not, drop it.

- OpenID Connect built into QemuWeb (no front end), with the directory groups mapped to roles; today Apache does it.
- Course subjects: the administrator publishes a session ZIP as a template, and each student instantiates it.
- A teacher role distinct from the administrator, limited to their groups' sessions.
- Other single sign-on systems are already supported through `--auth proxy` (see `docs/deployment.md`).

## Annex: minor independent tasks

Small tasks that belong to no milestone and depend on nothing. Take one when there is a gap, between two large tasks or
along with a related one. Sizes are S (about an hour) unless noted. Tick a line when it is delivered; keep the code in the
commit message.

### BUGFIX

- [x] **BUG01** `prepare.sh --hash --system ID` reports nothing and exits 0 when the system is not built yet. In
  `write_image_hashes` (`scripts/prepare.sh`), `if [[ ! -s "$image" ]]; then continue; fi` skips a missing or empty image
  silently, so the command can succeed having recorded nothing. Print `ID.raw: no image` (and `ID.vdi`) and exit non-zero
  when a targeted system has no image at all (only one of the two formats is a warning); with no `--system`, list the
  systems not built as skipped, and exit non-zero only if no image was found anywhere. A test of the status and messages.
- [x] **BUG10** (**priority**, reported by the user on 20 November 2026) **The second serial console (ttyS1) no longer works.** Debian hosts have two
  serial ports (`serialPorts:qemu: ["ttyS0", "ttyS1"]` in `config.json` for `debian13-legacy` and `debian13-cloud`); the pane view
  "Console (ttyS1)" (`data-view="console2"`, console id by `public/console-id.js`) and the socket `serial1.sock` come from the second
  `-serial unix:<node dir>/serial1.sock` that `runner/engines/qemu.js` adds only when `node.launchSettings.serialPorts.length >= 2`.
  Facts checked by reading, before any analysis of the symptom: the four pane view buttons are all still in `public/index.html`
  (`console`, `console2`, `monitor`, `log`, four times each); since 0.9.2 the code that can matter was touched by VBX01 (the engine
  exclusion and start path in `runner/node-lifecycle.js`) and by VBX02 (the engine selector, `host.json` format 2 with
  `serialPorts`, `serialPorts:qemu`, `serialPorts:vbox` resolved per engine by `resolveHostConfig` in `common/system-config.js`, the
  engine switch in `runner/engine-switch.js`, `launchSettingsFor`), and earlier by CAP01/CAP03/CAP02 (the pane views and their
  buttons, `public/terminal.js`, `workspace.js`, `view-state.js`). Hypotheses to settle with evidence: (1) the resolution of
  `serialPorts` for the QEMU engine now returns only ttyS0 (an unsuffixed `serialPorts` in a loaded or rewritten host.json, the
  `examples/*.zip` rewrite, a host created while the session engine was VirtualBox and then switched, the engine switch not
  re-resolving `launchSettings`), so QEMU is started with one `-serial` only; (2) the runner starts both serial ports but the
  console for ttyS1 is not attached (the second socket, the rooms/events `serial1`, `public/console-id.js`, the pane `serial-reset`);
  (3) the UI view for ttyS1 is hidden or falls back to the console (`usablePaneView` in `public/terminal.js`: "a ttyS1 console its node
  lacks") because the node data no longer says the host has two ports (the node's `serialPorts`/`consoles` field in the state events
  or `/api/nodes`); (4) the guest side: the image has no login on ttyS1 (the project says images prepared before that feature need
  `prepare.sh` again). Task: reproduce by reading (the full path from `config.json` through host.json, launch settings, the QEMU
  arguments, the console sockets, the Socket.IO rooms, to the pane), find the commit that broke it (`git log -S` / `git bisect` by
  reading), fix the cause, and add a test that would have caught it (the launch settings of every Debian system under QEMU give two
  ports; a host loaded from each example and switched between engines and back still gives two; the QEMU arguments contain two
  `-serial`; the console id of ttyS1 resolves). Ask the user for: which system and engine, what he sees (empty pane, no prompt, an error,
  the view missing), whether it also fails on a freshly added host and on an example loaded from the menu, and the "Console" tab of
  Host Settings (it lists `serial0.sock`, `serial1.sock` and the monitor socket).
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
- [x] **BUG08** `docs/user-guide.md` still says the CREMI runs `--auth both`; it is `--auth proxy`. (Disappears with AUT01.)

- [x] **BUG09** A console pane shows **two scrollbars**: the project's own slider (`input.terminal-scroll`, `public/css/app.css`
  line ~370, driven by `public/terminal.js`) and the scrollbar that xterm.js 6.0.0 draws itself
  (`.xterm-scrollable-element > .scrollbar`, a custom element of the library, which replaced the native viewport scrollbar of
  xterm 5). The CSS only hides the old native one (`.terminal .xterm-viewport { scrollbar-width: none; ::-webkit-scrollbar }`).
  Probable fix: hide the library's scrollbar too (`.terminal .xterm-scrollable-element > .scrollbar { display: none }`); the wheel
  and the keyboard keep scrolling, and the slider stays the one control. Check the Log, Monitor and Capture views and the
  floating console, and that the slider still follows the scroll position.

### TODO

- [ ] **TOD01** `status.sh`, `killall.sh` and `cleanall.sh` only know the default `runtime/`: add `--runtime DIR` to each, as
  `start.sh` and `stop.sh` have.
- [x] **TOD02** Report a `runtime/` path longer than 49 characters at startup (the sockets of a node must fit in 107 bytes),
  in the server and the runner, with the `--runtime` hint; today it only fails when the first node is created. Or shorten
  the node socket paths with a short alias directory. (M)
- [ ] **EXA01** (S) The example topologies and sessions (`examples/*.topo` and `examples/*.zip`, hence the demo of
  `scripts/demo.sh`) use the system `debian13-cloud` instead of `debian13-legacy`, which should be faster. Every host of the
  three `.topo` files and of the five archives changes system; the documents and tests that name the example system follow,
  and the documents say that the demo needs the `debian13-cloud` image (`prepare.sh --system debian13-cloud`).
- [ ] **TOD03** More `config.json` warnings at startup, beyond the engine, KVM and serial port checks.
- [ ] **TOD04** A tooltip on a disabled view control saying why (view driven by the owner or by the controlling admin).
- [ ] **TOD05** A `--version` option for `server/main.js` and `runner/main.js`, so the administrator can compare the versions of
  the two processes after an update.
- [ ] **TOD06** At startup the server could compare its version with the runner's hello and say "restart the runner" instead
  of letting an archive fail with `Invalid session.json in archive.` after a format change.
- [ ] **TOD07** `register --runtime` is only needed when the runner's directory differs from `runtime/` of the repository:
  say it in the registration output.
- [ ] **TOD08** `scripts/status.sh` (`scripts/status.js`) shows how many **threads** each process uses. A QEMU machine has several even
  with one virtual processor (the main loop, `CPU n/KVM`, `call_rcu`, an I/O worker), so a tool like `htop` shows more lines than
  there are machines and the count surprises. Read it from `/proc/<pid>/status` (`Threads:`) next to the CPU and memory of each
  QEMU, `vde_switch`, runner and server line; add the total of a session and of a server; with `--details` also list the thread
  names of each QEMU (`/proc/<pid>/task/*/comm`, grouped: `CPU 0/KVM`, `call_rcu`, `worker`...). Same idea in a short form for the
  `machines:` line of `deploy/cremi/qwctl.sh status` (`4 qemu, 16 threads`). Read-only, no new dependency; update the `--help`
  text, `docs/reference.md` and the unit test of the status output if there is one.

## Backlog

Things noticed with no milestone yet. Move one into a milestone when it is scheduled, delete it when done.

- Merge `docs/remote-runner-test.md` with the deployment documents once the runner choice is settled (see DOC01).
- Group to role (left over from AUT01): administrators come from `users.json` only and `X-User-Groups` is unused. Decide whether a
  directory group may grant the admin role, and how to list a student in `/admin` without a prior `--no-password` entry.
- Standalone local terminals (`CLI01`, size L, independent of the web interface): run machines on the user's own computer
  without a server and open `xterm` windows or `tmux` panes on their consoles. The runner already exposes `serial0.sock`,
  `serial1.sock` and `mon.sock` per node, and everything goes through `runner/index.js`. To settle: a mode with no server
  at all, or terminals attached to the machines of a runner that the server also manages; the local computer only, or
  a remote runner too (needs a tunnel for the sockets). Not a condition of 1.0.0.

## Decisions made

| Question | Decision |
| --- | --- |
| Authentication | Two modes, `password` and `proxy` (identity from the front end through `X-Remote-User`, guarded by `X-Proxy-Key`); `both` is removed in AUT01 |
| Server restart | Local runner: sessions adopted again. Remote runner: sessions dropped today, the binding will be persisted (PST01) |
| Inactive sessions | No expiry: the administrator cleans up by hand from `/admin` |
| Sessions per user | One, for good; a session lives on the runner that created it and moves by Save then Load ZIP |
| Personal runners | Created by the user from "My runner"; a new or loaded session goes there when it is online, else to the pool |
| Administrator console | Read-only; writing only after an explicit takeover (exclusive lock, visible to the student, logged) |
| Session identifier | Random; the login is in `owner`; link `runtime/users/<login>` |
| Security | Milestone 8; until then, trusted users only |
| `schemaVersion` | At 1 since 0.9.0; any format change increments it with an explicit compatibility decision |
| VirtualBox | Kept, outside the jail and the cgroup quotas; QEMU first |
| Target size | About 30 simultaneous sessions (a switch and 5 nodes each) |
