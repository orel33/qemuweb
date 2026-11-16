# Tests

Run commands from the repository root. `./scripts/run-tests.sh --list` shows the available scenarios and prints a short reminder when one starts. `npm test` selects only `test/unit/*.test.js`; the integration scripts must be run explicitly. The integration tests start their own QemuWeb server and guests, then remove the hosts and switches they created.

## Unit tests (`test/unit/`)

Command: `./scripts/run-tests.sh unit` or `npm test`.

| File | Purpose |
|---|---|
| `auth.test.js` | Check authentication: scrypt hash round trip, login character set, `users.json` validation and mode 0600, signed cookie expiry and tampering, the page/API gate, the Socket.IO handshake, `QEMUWEB_AUTH=off`, and `scripts/user.js` (add, passwd, role, remove, list, import-csv). |
| `admin.test.js` | Check the admin role without a server: `disabled` in `users.json`, the account operations shared with `scripts/user.js`, refused login/cookie/socket for a disabled account, `requireAdmin` (also with `QEMUWEB_AUTH=off`), `user.js disable`/`enable`/`list`, the log directory (`QEMUWEB_LOG_DIR`, mode 0700), the `admin.log` and `users.log` formats and mode, reading the end of a log, the routes that become `users.log` events, the login/logout events (no password, attempted login truncated), session activity, the `X-Observe` gate, the supervision summary, the per-session control lock, observer input rules, the one-line-per-observation audit, the view state module (`public/view-state.js`: `normalizeView` table of valid and invalid states, unknown and repeated nodes, `sameView`). |
| `guest-hook-filter.test.js` | Hide startup hook markers from the serial console, including split and prefixed lines. |
| `guest-media.test.js` | Validate startup files and resource paths; check that separate read-only ISOs contain the right script and resources when `genisoimage` and `isoinfo` are available. |
| `host-settings-naming.test.js` | Check automatic host names (from `public/nodes.js`) and the shared Add host/Host Settings dialog. |
| `image-hash.test.js` | Check base image hashing (`.sha256` files written by `prepare.sh`: used when not older than the image, ignored when older or malformed, asynchronous fallback) and shell quoting of logged commands. |
| `launch-settings.test.js` | Validate launch settings and QEMU options against their field limits. |
| `node-id.test.js` | Check host and switch ID format and kind. |
| `pud84-ui.test.js` | Check the position of Exit All in the host/switch toolbar. |
| `resource-metrics.test.js` | Parse CPU and memory metrics for Linux processes and VirtualBox. |
| `runner.test.js` | Drive `runner/` through its facade with an injected in-memory session and a temporary runtime directory: node layout, hostname aliases, state/log events, NIC MAC and port assignment, engine checks, catalog lookups and launch preview commands. No HTTP server is started and no process is spawned. |
| `runner-boundaries.test.js` | Check the dependency rules: `runner/` requires only `runner/`, `common/`, Node built-ins and `node-pty`; the rest of the server requires only `runner/index.js`. |
| `session-manager.test.js` | Check one session per user (random ID, `owner` in `meta.json`, `runtime/users/<login>` alias), independent runners and events, deletion, exit cleanup, pruning of empty sessions, server records, and that the owner stays out of `session.json` and archives. |
| `session-archive-validation.test.js` | Check archive validation: base image identities in the `host.json` of hosts with a working disk, older `session.json` inventories, refused or discarded stale disks, no identity needed without a disk. |
| `session-archive.test.js` | Write and read session ZIP archives; reject modified, unsafe or incomplete ones. |
| `session-log.test.js` | Check log replay, clearing and history limits. |
| `tcg09-graphic.test.js` | Build the network graph from example topologies and check links, positions and states. |
| `topology.test.js` | Parse and format example topologies; reject invalid references and directives. |
| `vbr06-ui.test.js` | Check the QEMU monitor behavior and Console/Monitor/Log views; check that `index.html` has no inline script or style. |
| `web-modules.test.js` | Check the Web UI ES modules in `public/`: syntax, size, import/export resolution and initialization from `app.js`. |

`web-ui-source.js` is a helper shared by the tests that read the Web UI sources.

## Integration tests (`test/integration/`)

Every scenario logs in for real: `qemuweb-client.js` writes a temporary users file with random passwords, starts the server with `QEMUWEB_USERS_FILE`, and drives it with an HTTP and Socket.IO client that keeps the session cookie like a browser. The server has no test backdoor.

These scenarios require QEMU and prepared RAW images. The two-hosts, four-hosts and check-network scenarios require a QEMU build with VDE support, the VDE tools and QEMU/KVM (`/dev/kvm`).

| Command | Script | Purpose |
|---|---|---|
| `./scripts/run-tests.sh two-users-isolation` | `two-users-isolation.js` | Two users logged in at once: each lists only its own nodes; every cross-session node route answers 404 and changes nothing; Socket.IO cannot select, type into, clear or resize the other user's consoles; no event of one session reaches the other; anonymous requests and sockets are refused; deleting one session leaves the other intact; logging out stops nothing. Needs only the VDE tools (no image, no KVM). |
| `./scripts/run-tests.sh admin` | `admin.js` | Admin role with an admin and students: every `/api/admin` route (even an invented one) and `/admin` answer 403 to a student; the admin lists the sessions without opening one; observation of a student's switch console is live and read-only (input, Clear, resize and every non-GET request refused); connected browser tabs are counted (observers and console sockets excluded); only the owner's published view (`owner-view`: a full view state, unknown fields such as `page` dropped, invalid states refused, unknown or repeated pane nodes emptied) is relayed to observers, never a console attachment or an observer's own view, and a new observer starts from the last one; an offline user can be observed, and a login without a session gets `observe-unavailable`; take control (from any admin socket, no node needed) blocks the student's input on every node, lets the admin type into any node, survives pane sockets closing and opening, reaches every socket of the session with `console-control` (also at connection), relays the controller's view (`controller-view`) to the student's pages only while control lasts, and ends with the admin's last socket on the session or an explicit release; stop-all keeps the nodes; bulk deletion removes the sessions, their `vde_switch`/`vdeterm` processes and `runtime/sessions/<id>/`; accounts are created, reset, disabled (also directly in `users.json` while connected) and removed (session and processes freed), and such an account loses its cookie and sockets; the log panel API returns the end of each log and the raw file; `admin.log`, in a log directory the server creates (`QEMUWEB_LOG_DIR`), has one line per action and no password or typed text; `users.log` has the logins, failed logins, sessions and nodes, nothing from observation, and no password or typed text. Needs only the VDE tools (no image, no KVM). |
| `./scripts/run-tests.sh session-reconnect` | `session-reconnect.js` | Start a VDE switch (and a Debian 13 Legacy host when its image and KVM are available), type into the consoles, close every socket and log out, then log in again: same session, nodes still running, console and log history replayed by `node-snapshot`, input works. `RECONNECT_HOST=0` skips the host. |
| `./scripts/run-tests.sh two-hosts` | `two-hosts-ping.js` | Boot two Debian 13 Legacy guests on one VDE switch; verify distinct ports and MACs, serial login, static IPs, bidirectional ping, and Stop/Resume. Requires `images/debian13-legacy.raw`. |
| `./scripts/run-tests.sh four-hosts-startup` | `four-hosts-startup.js` | Boot four Debian 13 Legacy guests on one VDE switch with automatic startup ISOs. Verify the default `start.sh` keeps `@HOSTNAME@`, `@IFNAME0@` and `@SWPORT0@`, each guest receives `192.168.0.<its VDE port>/24` without serial configuration, and all 12 directed ping paths work. Requires `images/debian13-legacy.raw` and about 4 GiB of guest memory. |
| `./scripts/run-tests.sh two-hosts-startup-media` | `two-hosts-ping.js` | Extend the two-hosts scenario with a per-host startup ISO, companion resource, guest script output, persistent disk state, and edited media after Reboot. |
| `./scripts/run-tests.sh startup-media-profiles` | `startup-media-profiles.js` | Check startup ISO execution, resources, Reboot and Stop/Resume on Alpine, Debian Cloud and OpenWrt; also check concurrent OpenWrt isolation and missing-media/script errors. Requires their three prepared RAW images. |
| `./scripts/run-tests.sh check-network-debian13-legacy` | `check-network.js` | Two Debian 13 Legacy hosts on one VDE switch: distinct VDE ports and MACs, passwordless root login, `eth0`, startup and interactive `hostname`, `ping` and `tcpdump` installed, static addresses, ping both ways and `tcpdump` request/reply capture on both hosts. Requires `images/debian13-legacy.raw`. |
| `./scripts/run-tests.sh check-network-debian13-cloud` | `check-network.js` | Two Debian 13 Cloud hosts on one VDE switch: distinct VDE ports and MACs, passwordless root login, `eth0`, startup and interactive `hostname`, `ping` and `tcpdump` installed, static addresses, ping both ways and `tcpdump` request/reply capture on both hosts. Requires `images/debian13-cloud.raw`. |
| `./scripts/run-tests.sh check-network-alpine` | `check-network.js` | Two Alpine hosts on one VDE switch: distinct VDE ports and MACs, passwordless root login, `eth0`, startup and interactive `hostname`, `ping` and `tcpdump` installed, static addresses, ping both ways and `tcpdump` request/reply capture on both hosts. Requires `images/alpine.raw`. |
| `./scripts/run-tests.sh check-network-openwrt` | `check-network.js` | Two OpenWrt hosts on one VDE switch: distinct VDE ports and MACs, passwordless root login, `eth0` as a direct LAN without `br-lan`, startup and interactive `hostname`, `ping` and `tcpdump` installed, static addresses, ping both ways and `tcpdump` request/reply capture on both hosts. Requires `images/openwrt.raw`. |

To run the profile scenario for Debian Legacy alone, use `STARTUP_MEDIA_PROFILES=debian13-legacy npm run test:startup-media-profiles`. To keep a live two-hosts log, use `./scripts/run-tests.sh two-hosts 2>&1 | tee two-hosts.log`.

To keep the four-hosts guest commands and replies, use `./scripts/run-tests.sh four-hosts-startup 2>&1 | tee four-hosts-startup.log`. Set `FOUR_HOSTS_TIMEOUT_MS` for slower boots. The scenario starts an isolated test server and removes its hosts and switch when finished; it does not rebuild the base image.

The four check-network scenarios run `check-network.js` with `GUEST_NETWORK_PROFILES` set to their one system. They print each serial command and a per-check summary, and exit nonzero when a check fails. Set `GUEST_NETWORK_TIMEOUT_MS` for slower boots. Keep the command and guest output with `./scripts/run-tests.sh check-network-openwrt 2>&1 | tee check-network-openwrt.log`. These tests use only temporary working disks and an isolated test server; they do not rebuild or overwrite the base images.

## Manual tests of the Web interface

`./scripts/run-tests.sh web` starts the application on port 3003 (`PORT` overrides it) for manual tests in a browser. It never reads or changes the repository's `users.json`: it writes a separate, temporary users file (`QEMUWEB_USERS_FILE`) with three accounts, and deletes it when the application stops (Ctrl+C):

| Login | Password | Role | Session at start |
|---|---|---|---|
| `admin` | `admin` | admin | empty |
| `toto` | `toto` | student | `demo/lan.zip` loaded |
| `tutu` | `tutu` | student | `demo/lan.zip` loaded |

Passwords equal to logins exist only in this test mode. After the server is up, `test/manual/web-setup.js` logs in as `toto` and `tutu` and loads `demo/lan.zip` through the normal session load route (nodes not started). The scenario stops with a message before starting the server when the archive or a base image it needs (`images/debian13-legacy.raw`) is missing. Logs go to `logs/` as usual.

Check isolation by logging in as `toto` and `tutu` in two browsers (or a private window). For the admin role, log in as a student in one browser and as `admin` in another: open **Supervision**, **Observe** the student, check that the banner, the follow-node behaviour and **Take control** work on both sides, then try **Stop all**, **Delete** and the account actions, and read the **Logs** panel (`logs/admin.log`, `logs/users.log`).
