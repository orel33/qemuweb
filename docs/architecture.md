# QemuWeb architecture

QemuWeb separates the Web interface, the Node.js server (the control plane), and
the runner, a separate process that creates the machines. The browser
communicates with the server, which sends commands to the runner and relays the
consoles.

## Glossary

| Term | Meaning |
| --- | --- |
| Session | A user's workspace: its nodes, its engine (`qemu` or `vbox`), and its runtime directory `<runtime>/sessions/<id>/`. Each user owns exactly one session, with a random ID, recorded as `owner` in `meta.json` next to `session.json`. A session ZIP archive and `session.json` describe it; `meta.json` (owner, creation date) belongs to the live session only and is never exported. |
| User | A login from `users.json`, or given by the authenticating front end (`X-Remote-User`, a student unless `users.json` says otherwise), or the implicit `local` user when `--no-auth`, with the role `student` or `admin`. An admin owns a session like anyone else and may also supervise, observe and clean up the others. |
| Observer | An admin's browser tab or socket reading another user's session (`X-Observe` header, Socket.IO `auth.observe`): read-only, except console input after taking control of a node. |
| Node | An element of a session: a host or a switch. API routes and Socket.IO events use `nodeId`. |
| Host | A node that is a virtual machine (QEMU or VirtualBox). |
| Switch | A node that is a VDE switch. |

![Architecture: browser, server, local and remote runners, and the hosts and VDE switch of a session](img/architecture.svg)

*Figure 1. The server never starts a virtual machine: a runner does, on this machine (Unix socket) or on another one (WebSocket opened by the runner). Inside a runner, a session is a small LAN as the Graphic view shows it: one `vde_switch` process per switch, one QEMU or VirtualBox process per host, driven through serial and monitor sockets and the guest agent channel.*

| Part | Files | Role |
| --- | --- | --- |
| Browser | `public/` | Web interface (`index.html`, `css/app.css`, ES modules started by `app.js`) and xterm.js terminals. |
| Authentication | `server/auth/` | The one place where the identity is resolved (`createAuth` in `server/auth/index.js`): the authenticating front end's `X-Remote-User`, trusted only with one of the (at most two) shared `X-Proxy-Key` values (`proxy.js`) with `--auth proxy`, the signed cookie with `--auth password`; sets `req.user` (HTTP, `/admin`, `X-Observe`) and `socket.data.user` (Socket.IO handshake, console control); the role `admin` opens the admin API. |
| Session manager | `server/session-manager.js`, `server/session.js` | Maps a login to its session (ID, owner, runner ID) and creates it on the runner chosen by `pickRunner`. |
| HTTP API and Socket.IO | `server/routes/`, `server/sockets.js` | One router per session, one command per request and archive streams; Socket.IO rooms `session:<id>`, `observers:<id>`, `node:<id>:<nodeId>`, `console:<id>:<consoleId>`. `server/ws-transports.js` keeps the registry of live connections and their transport (Connections panel of `/admin`, log line for a connection stuck on polling); `server/ws-test.js` is the admin-only `/ws-test` namespace of the Test WebSocket button. |
| Admin | `server/routes/admin.js`, `server/audit.js` | `/api/admin/*` and `/admin`: list, stop, delete, observe; `logs/admin.log` and `logs/users.log`. |
| Runner registry and gateways | `server/runner-client.js`, `server/runner-registry.js`, `server/runner-gateway.js`, `server/remote-gateway.js` | Every runner with its client; the local runner over `<runtime>/runner-<port>.sock`, a remote one over the WebSocket `/runner/connect`. |
| Runner | `runner/main.js`, `runner/service.js` | Serves every session of its machine over the runner protocol and launches QEMU, VirtualBox, `vde_switch` and `vdeterm`. |


## Main paths

- **Host console:** xterm.js exchanges characters with `server/sockets.js` over
  Socket.IO. The runner relays them through a QEMU or VirtualBox Unix serial
  socket connected to the guest's `ttyS0`. A Debian host can have a second
  serial port (`ttyS1`, QEMU's second `-serial`, `serial1.sock`): see
  [Console IDs](#console-ids).
- **Switch console:** Socket.IO connects to `node-pty`, which runs `vdeterm`.
  It uses the `vde_switch` management socket. Guest Ethernet traffic uses a
  separate VDE data socket.
- **QEMU monitor:** the Monitor view sends HTTP commands to the server; the
  runner queries QEMU's HMP socket. This controls the emulator, not the guest shell.
- **Actions and status:** each HTTP request of a session becomes one command
  to the runner over the runner protocol (see [Runner interface](#runner-interface)).
  The runner reports state, logs and serial output as events, which
  `server/sockets.js` forwards over Socket.IO to the relevant browser tabs.
- **Users and sessions:** `server/auth/` checks the signed cookie of every request
  and of the Socket.IO handshake (Origin checks are planned for milestone 8).
  `server/session-manager.js` maps the login to its workspace `{session, runner}`,
  creating it at first use; it survives logouts and closed tabs until the user
  deletes it or the server stops. Each HTTP request goes to the router of the
  user's own session, whose runner looks a node ID up only there (404 otherwise).
  Per-session events go to the room `session:<id>`, per-node events (`state`,
  `log`, `logs-reset`) to `node:<id>:<nodeId>`, and console output (`serial`,
  `serial-reset`) to `console:<id>:<consoleId>`; a socket joins them only for a
  node of its own (or observed) session.
- **Administration:** `server/main.js` mounts, in this order after authentication,
  the observation gate (`X-Observe`: admins only, `GET`/`HEAD` only, the
  observed workspace taken with `manager.get`, never `open`), the
  `/api/admin` router (first middleware: role `admin`, then 403 on any path
  for others), `DELETE /api/session`, and the middleware that opens the
  caller's own session and records its activity. An admin call therefore never
  opens a session for the admin, and an observed session never gets an
  activity mark. An observer socket (`auth.observe`) joins the observed
  session's rooms and `observers:<id>`; `server/sockets.js` refuses its `input`,
  `clear-console` and `terminal-resize`, relays what the owner's page shows
  (`owner-view`, a [view state](#view-state) validated by `normalizeView`,
  published by that page whenever it changes, never derived from console
  sockets attaching; the last one is also sent to a new observer), sends `observe-unavailable` when the login has no session, and
  lets it type only while its admin controls the session (`take-control`
  from any of that admin's observer sockets, `server/console-control.js`: one lock
  per session, held by the admin's login, released explicitly, after 10
  minutes without input, on session deletion, or when that admin's last
  observer socket on the session closes; the owner's input is then dropped on
  every node). `console-control` {admin, active} goes to every socket of the
  session, owner and observers, on each change and at connection, and the
  pages derive their banners from it only. While an admin holds
  control, the view goes the other way: the admin's page publishes
  `controller-view` (same fields and validation, accepted only from that admin
  while they hold a lock on the session, kept for a page opening meanwhile) and
  the owner's pages show it, with their own `owner-view` paused, so the two
  never drive each other at once. One driver at a time also in the browser:
  when a page's view is driven by the other side (the owner's page under
  control, or an observer with Follow checked and no control held),
  `body[data-view-driven]` disables every control that changes the view state
  (class `view-control`: pane view menu, layout menu, switch consoles, paging,
  tab selection, pane node menus), for the mouse (CSS) and the
  keyboard (`observe.js`); the banners say who drives. Nothing is hidden for an
  observer: the page has the user's exact layout, and every write action (class
  `write-action`) is shown disabled (greyed, no mouse, `aria-disabled`, keyboard
  and programmatic clicks blocked by `observe.js`; the Monitor entry of the view
  menu too, and a followed `monitor` shows the console). Taking control forces
  Follow on and applies the owner's view first, then the admin's page drives;
  while control is held the Follow box is checked and disabled. Every privileged socket
  event re-reads the account, so a disabled or removed account loses its
  sockets. `server/sockets.js` also counts each user's connected browser tabs (the
  tab's session socket carries `auth.main`), shown as online/offline in
  `/admin`. Admin actions are appended to `logs/admin.log`, the audit log of
  administrator actions (`server/audit.js`).
- **User events:** `logs/users.log` receives logins and logouts from the
  `/auth` routes, session creation and deletion from the session manager
  events (`removed` carries who asked), and the owner's explicit node and
  archive actions from one middleware of the session router
  (`server/routes/index.js`, `userEvent`), written when the response is sent.
  `/admin` reads both logs from their end (`readLogTail`).


### Console IDs

A host has one console per serial port. The **console ID** of channel 0
(`ttyS0`) is the node ID itself, so that path is unchanged; the second port
(`ttyS1`) is `<nodeId>:1` (`common/console-id.js`: `baseNodeId`,
`consoleChannel`, `consoleId`). The ID is used by `select-node`, `input`,
`clear-console`, the `console.*` commands and the `nodeId` field of the
`serial` and `serial-reset` events of channel 1. Everything else (`state`,
`log`, node lists, views) keeps plain node IDs. `select-node` joins the node
room and the console room, and leaves those of the previous selection, so a
pane shows one console at a time; the browser's `console2` pane view selects
`<nodeId>:1`. Each channel has its own connection and 256 KiB replay buffer in
the runner (`serial`/`serialBuffer`, `serial1`/`serialBuffer1`); the startup
hook marker filter applies to channel 0 only.

The serial ports of a host are the `serialPorts` key of a system profile in
`config.json`, a list of port names: `systems.default` declares `["ttyS0"]`, and
`debian13-legacy` and `debian13-cloud` replace it on QEMU with `["ttyS0",
"ttyS1"]` through `serialPorts:qemu` (VirtualBox keeps `["ttyS0"]`; a profile
without a valid list is refused). The list drives the QEMU command line: the
runner adds one `-serial unix:<node dir>/serial0.sock,server=on,wait=off` for
`ttyS0` and one `serial1.sock` for `ttyS1`, in list order, so a port that is not
listed gets no `-serial` option. `common/console-id.js` holds the allowed names
(`PORTS`) and `validatePorts`: a list must start with `ttyS0` and be a
contiguous prefix of `PORTS` (QEMU numbers `-serial` devices in order, and
`ttyS0` is the kernel console), and a host's list must also be a prefix of its
system's list. The channel index of a port is its position in the list. A host
overrides the list in `host.json` `config` (sparse, stored only when it differs
from the profile) and in its launch settings. A system without a getty on
`ttyS1` (an older image) shows an empty second console. `state` events,
`nodes-changed` and `GET /api/nodes` carry `serialPorts` (the running VM's
list while it runs), and changing it is a pending restart. The browser labels a
host's console views `Console (ttyS0)` and `Console (ttyS1)`; a switch keeps
`Console`.

## View state

What a page of the workspace shows is one plain JSON object, the view state,
defined, validated and compared in one module, `public/view-state.js` (a
classic script shared by the server and the browser: `paneCount`,
`normalizeView(raw, nodeIds)`, `sameView`):

```text
{ mode:     'terminals' | 'graphic',
  layout:   'single' | 'columns-2' | 'rows-2' | 'grid-4',
  panes:    (nodeId | null)[],   exactly paneCount(layout) entries: the node shown in each
                                 pane, in pane order; null = empty pane
  views:    ('console' | 'console2' | 'monitor' | 'log')[],
                                 parallel to panes: the view of each pane
                                 (Console ttyS0, Console ttyS1, Monitor, Log)
  switches: boolean,             switch consoles shown
  active:   nodeId | null }      the selected node (tab or graphic selection)
```

`normalizeView` returns a valid view state or null: known keys only (others
dropped), known layouts and modes, `panes` and `views` of the right length (a view state without `views` is
invalid), `views` entries among the five views, `panes` with strings or
null; node IDs not in the given list become null, and a node shown in two panes is kept in the first one; the view of a pane left
empty becomes `console`. The console page is not part
of the view: paging only decides which nodes are assigned to the panes, and
the resulting `panes` is what is published.

In the browser, `captureView()` reads the view and `applyView(view)` shows one
(layout, switch consoles, the panes' nodes through the same
assignment as the pane node menu, active node, mode), without saving it and
attaching only the consoles of panes whose node changes; then each pane's view
(`setPaneView`), only if its node allows it (Monitor needs a QEMU host, ttyS1 a
second console, else `console`; an observer is never shown the Monitor, a
followed `monitor` shows the console). `viewChanged()`, at
the end of `setPaneSessions` (so `showPage`), `focusPane` and
`setGraphicView`, publishes the view (deduplicated with `sameView`) and saves
it as `{view}` in the browser; applying a received view does
neither. The owner's page publishes `owner-view`, except while an admin
controls its session; the controlling admin's page publishes
`controller-view`. A page follows a received view by `normalizeView` against
its own nodes, then `applyView`; a node it does not know yet makes it reload
its node list first. The saved view is restored the same way once the node
list is loaded.

## Module map

The server is split into layers with one-way dependencies:

- **`runner/`** is the runner: a separate process (`runner/main.js`) that
  executes every session of the machine. It depends only on `common/`, Node
  built-ins and `node-pty`, and the control plane never requires it: they
  talk through the runner protocol (see [Runner interface](#runner-interface)).
  `runner/service.js` holds the sessions and dispatches the commands of
  `runner/commands/`; each session has its own runtime
  (`runner/session-runner.js`): a context (no module-level state), modules
  created as factories (`createCatalog(ctx)`, ...) in dependency order, and a
  resource sampling timer.
- **`server/`** is the control plane: `session-manager.js` (one session per user,
  bound to a runner), `runner-client.js`, `runner-registry.js`
  and `runner-gateway.js` (the runners and their connections), `server-instance.js`
  (server records used by the scripts) and `auth/` (authentication).
- **`server/routes/`** and **`server/sockets.js`** form the web layer: HTTP routes by area and
  Socket.IO wiring. `server/main.js` only starts (arguments and checks) and `server/serve.js` wires everything.
- **`common/`** holds code shared by the runner and the server, including the
  protocol framing.

| Module | Role |
| --- | --- |
| `server/main.js` | Entry point: command line (`common/cli.js`, table in `server/options.js`), banner, `Options`, `Checking dependencies…`, then `server/startup-checks.js` (`Checking configuration…`: `config.json`, users file, log and runtime directories); the web stack is loaded only after these pass, so `--help` and a refused option answer at once. |
| `server/serve.js` | Wiring of the web stack: runner gateway, HTTP server (opened at once; a runner connects at any time), Socket.IO, authentication, session manager and routes. |
| `server/options.js` | The server's command line table (`--listen`, `--runtime`, `--users`, `--runners`, `--logs`, `--examples`, `--session-hours`, `--runner-grace`, `--trust-proxy`, `--auth`, `--proxy-key-file`, `--logout-url`, `--no-auth`, `--ephemeral`), anything else refused with exit status 2. |
| `server/sockets.js` | Forwards each runner's events to the rooms of its session, relays console input, and handles observer sockets and console control. |
| `server/routes/admin-runners.js` | `GET /api/admin/runners`: the runners and their warnings, read-only (the Runners section of `/admin`, `public/admin-runners.js`). |
| `server/routes/admin.js` | `/admin` page, `/api/admin/*` (sessions with metrics, stop-all, delete, bulk delete, accounts), the `X-Observe` observation gate. |
| `server/routes/index.js` | Builds the router of one session from the route modules, and `handle(command, args, status)`: a route that sends one runner command. |
| `server/routes/settings.js` | General settings, system catalog and startup CD-ROM capability. |
| `server/routes/nodes.js` | Node listing, switches, start, stop, Resume all, Stop all, reboot, reset, monitor, rename and deletion. |
| `server/routes/hosts.js` | Host creation, configuration and startup CD-ROM. |
| `server/routes/topology.js` | Topology (`.topo`) preview, creation and export. |
| `server/routes/archives.js` | Session ZIP size estimate, export, base image check and import; the ZIP goes between the browser and the runner as a protocol stream (`importArchive` sends any Readable, an upload or an example file). |
| `server/examples.js`, `server/routes/examples.js` | The server's examples (`--examples`): `GET /api/examples` lists the regular `.topo` and `.zip` files (name, kind, size, description); `POST /api/examples/file` and `POST /api/examples/load` take a bare file name `{name}`, check it against a fresh listing (400 malformed, 404 unlisted), open it without following links, confirm the kind by content, then feed it to the same runner commands as an upload (`archive.import`, `topology.load`). Read only. |
| `server/routes/metrics.js` | Per-host CPU and memory metrics. |
| `server/session-manager.js` | Login → `{session, runner}`; creation at first use on `registry.pickRunner`, deletion, dropping the sessions of a lost runner, resynchronisation on a runner's `hello`. No file access. |
| `server/session.js` | The control plane's record of a session: ID, owner, creation date, runner ID, last activity (memory only) and archive lock. |
| `server/runner-client.js` | One runner connection: requests and responses, per-session handles (`request`, `input`, `events`, streams), `hello`. |
| `server/runner-registry.js` | Runners with their state (`starting`, `online`, `lost`), capabilities, `paused` flag, the display-only `runtimeRoot` and `pid` and client (no `local` or `trusted` flag); `pickRunner(login, sessionsOf)`, the single placement point. |
| `server/remote-gateway.js` | `/runner/connect`: the WebSocket upgrade of remote runners (bearer token and runner ID checked against `runners.json`, 401 / 409), the `ws` duplex stream under a protocol `Connection`, ping/pong (`common/ws-heartbeat.js`). |
| `server/runner-store.js`, `server/runner-registration.js` | `runners.json` (token hashes, 0600, revoked, paused) and the in-memory one-time registration tokens (15 min, 1 h, 24 h). |
| `server/routes/runner-register.js`, `server/routes/admin-runners.js` | `POST /api/runner/register` (unauthenticated, token in constant time, rate limited) and the admin API of the Runners panel (tokens, pause, resume, revoke, remove; audited). |
| `server/runner-gateway.js` | The runner socket `<runtime>/runner-<port>.sock`: stale-socket check, mode 0600, one runner at a time, registered as `local` with its record of `runners.json` (created at its first connection; a revoked record is refused, the connection is closed); a second connection is closed. |
| `server/server-instance.js` | `<runtime>/server-<port>.pid` (read by `scripts/stop.sh`), the only file the server keeps in its runtime directory. |
| `server/auth/` | `index.js` facade (login routes, middleware, `requireAdmin`, Socket.IO handshake, `currentUser`), `users-store.js` (`users.json` and the account operations shared by `scripts/user.js` and the admin API), `passwords.js` (scrypt), `cookie.js` (signed cookie), `proxy.js` (shared key file, identity from the authenticating front end). |
| `server/audit.js` | Log directory (`logs/` or `--logs`), `admin.log` (audit log of administrator actions) and `users.log` (user events), JSON lines, and reading their last entries. |
| `server/console-control.js` | Exclusive per-session control lock (held by an admin's login) with its 10-minute idle timer. |
| `runner/main.js` | Runner process entry point, same startup sequence as the server: command line (`common/cli.js`, tables in `runner/options.js`: the local form `--port` or `--connect`, `--runtime`, `--config`, `--exit-on-disconnect`; the `run` and `register` subcommands of a remote runner), banner, `Options`, preflight, its own configuration checks, connection and its state lines. |
| `runner/remote.js`, `runner/remote-identity.js`, `runner/remote-url.js`, `runner/config-file.js`, `runner/register.js`, `runner/register-command.js` | The remote runner: the outbound WebSocket with its backoff and ping, the runner file `runner.json` (0600), URL rules (`ws://` only for loopback unless `--insecure`), the registration request. `runner/` may require `ws` for this. |
| `runner/index.js` | Runner facade: `createRunnerService`, `serveConnection`, `resolveCommands`. |
| `runner/service.js` | Every session of the runner: `session.create`/`session.delete`, command dispatch (404 for an unknown session or node), console input, `hello` with the capabilities, `runtimeRoot` and the sessions (ID, owner, creation date), shutdown. |
| `runner/endpoint.js` | The runner side of a connection: requests in arrival order, events, console output coalescing and backpressure. |
| `runner/commands/` | Commands by area (nodes, hosts, settings, topology, archives, consoles); their results are the JSON bodies of the HTTP API. |
| `runner/runtime-tidy.js` | What the runner keeps in its directory besides sessions: `users/<login>` aliases, start-up pruning of empty session directories and dangling aliases, the `runner.pid` lock. |
| `runner/session.js` | One session as the runner holds it: engine, nodes, runtime directory, `session.json` (definition), `meta.json` (owner, creation date). |
| `runner/engine-switch.js` | Changing the session engine with hosts present: refused while a host is up or busy, then each host selects the settings (resolved from its `host.json` config) and the working disk of the new engine; nothing is deleted. |
| `runner/archive-disks.js`, `runner/media/vdi.js` | Working disks of a ZIP on load: `baseImages` identities per disk format, and the VDI header check. |
| `runner/session-runner.js` | The runtime of one session; `stopAllNodes` stops every host then every switch and keeps the nodes; `startAllNodes` starts every stopped switch then every stopped host (Resume all and the automatic start of a loaded session); both skip nodes with an action in progress. |
| `runner/context.js` | Per-session context: session, commands, paths, `hostNodes()` of every session of the runner, console flow, events. |
| `runner/archive-snapshot.js`, `runner/archive-zip.js` | What a session ZIP contains, and the ZIP format itself. |
| `runner/session-runtime.js` | Node records, runtime directories, hostname aliases, state and log publishing. |
| `runner/capture.js`, `runner/capture-live.js`, `runner/pcap.js` | Traffic capture (see [Traffic capture](#traffic-capture)): `filter-dump` through the monitor, the size watcher and the capture records; the live view (`tcpdump`); whole packets of a growing PCAP. `common/capture.js` holds the limits, the capture ID rules and the filter validation. |
| `server/routes/captures.js`, `server/capture-live.js`, `server/capture-lease.js` | Capture routes (owner or control-lock admin), the download stream, the relay of the live view to the page's socket, and the capture leases (a capture lives only as long as the dialog of the tab that started it). |
| `runner/node-lifecycle.js` | Host start, stop, reboot, reset and deletion. |
| `runner/catalog.js`, `runner/host-config.js` | System catalog and `host.json`. |
| `runner/launch-preview.js` | Settings, storage paths and commands a host would use, without starting it. |
| `runner/engines/` | QEMU, QEMU monitor (HMP), VirtualBox, child process exit. |
| `runner/network/` | NIC MAC and port assignment; VDE switch and its `vdeterm` terminal. |
| `runner/console/` | Guest serial consoles (one per channel) and startup hook marker filtering. |
| `common/console-id.js` | Console IDs (node ID, `:1` for the second serial port); also served to the browser at `/console-id.js`. |
| `runner/media/` | Working disks, startup ISO, startup files and base image hashes. |
| `runner/preflight.js`, `runner/resources.js`, `runner/metrics.js` | Executable checks; CPU and memory sampling. |
| `common/` | Runner protocol framing (`runner-protocol.js`), `.topo` parsing (`topology.js`), IDs, launch settings, `config.json` validation, JSON writes, shell quoting. |

### Web interface

`public/index.html` contains only the page structure. `public/css/app.css`
holds the styles. The script is split into native ES modules (no framework or
bundler) loaded from `public/app.js`, which runs their initialization in a fixed
order. State that several modules reassign lives on the `store` object of
`state.js`. `monitor-terminal.js`, `session-log.js`, `network-node-icons.js`, `view-state.js` and
`topology-graphic.js` (layout, link routing and SVG drawing of the Graphic view) remain classic scripts, also loaded by unit tests.
`login.html` and its module `login.js` form the separate login page;
`admin.html` and `admin.js` the Admin page `/admin`, served to admins only, one tab at a time (`admin-tabs.js` for the tab bar, the refresh rules and the badges; `admin-tabs-rules.js` for the pure rules). Only the visible tab polls, none while the browser tab is hidden.

| Module | Role |
| --- | --- |
| `app.js` | Entry point: initializes the other modules. |
| `account.js` | User name (and display name from the front end), Admin link (admins), Delete session and Log out in the header; authentication-disabled warning. |
| `state.js` | Nodes, shared state, view and general settings in `localStorage`. |
| `api.js` | HTTP helpers: node URLs, JSON requests, launch preview URL, session-expiry handling on 401 (`session-expiry.js`: login page, or one reload for an identity from the front end), `X-Observe` header in an observation tab. |
| `socket.js` | Per-pane console sockets and the shared notification socket. |
| `terminal.js` | Console panes, menus, font size and Console (ttyS0)/Console (ttyS1)/Monitor/Log views. |
| `host-console-settings.js` | Console tab of Host Settings: read-only console (`serial0.sock`, `serial1.sock`) and monitor sockets. |
| `workspace.js` | Pane layout, paging, node tabs, state badges and metrics. |
| `nodes.js` | Node model, server synchronization and lifecycle actions. |
| `node-dialogs.js` | Add switch and Clone dialogs. |
| `host-settings.js` | Host Settings dialog, also used to add a host. |
| `startup-media.js` | Startup tab: `start.sh` template, startup disk and extra files. |
| `general-settings.js` | General Settings dialog (naming scheme, console font). |
| `engine-select.js` | The **Engine** select of the header: the pure rules (value, disabled, reason), live freeze while a host is up or busy, change request, notes of Host Settings. |
| `topology.js` | The Load Topology dialog (same structure as Load Session) and the `.topo` download, and the start of the saved view. |
| `load-menu.js`, `load-steps.js`, `file-kinds.js` | The Load button's upward menu (From User Files, From Server (Examples) with its small dialog) and the check of a chosen file by extension and content; the steps list and the Close step (which removes the previous session with `removeAllNodes` of `nodes.js`, once, when Load is pressed after the file was read and checked) shared by the Load Session and Load Topology dialogs; and the pure rules (kind and routing of a file, the Save status line, the warning, the timing of the closing, menu item states). |
| `graphic-view.js` | Graphic view: drawing, pan and zoom (a world-to-screen viewport, so node positions do not depend on the zoom and have no edge), node dragging, selection, hover details, Terminals/Graphic switch. |
| `captures.js`, `capture-dialog.js`, `capture-button.js`, `capture-live.js` | Traffic capture: the captures of each node (from the `captures` event and the list routes), the reasons, the interface labels, the preselection, the pane button state and the rules of ownership, saving and cleanup. `capture-dialog.js` is the Capture dialog (interface, live filter, Start/Stop, automatic save, live area), `capture-button.js` the pane bar button, and the link popover opens the dialog. `capture-live.js` is the live text area of the dialog (the last 2000 lines); there is no Capture view of a pane. |
| `graphic-console.js` | Floating console of the Graphic view: the console workspace shown as a movable, resizable window over the graph, with the selected node's pane only. |
| `graphic-edit.js` | Editing in the Graphic view: add a node where clicked, connect a host interface to a switch, remove a link (`PUT /api/nodes/:nodeId/config`). |
| `archive.js` | The Save dialog (one status line and one Download button; session ZIP, or only the topology with a checkbox) and the Load Session dialog (review and load of a session ZIP). |
| `observe.js` | Observation tab (`/?observe=<login>`): target, socket options, banner and navigation, console control on both sides, following received view states. |
| `view-state.js` | Classic script, also required by `server/sockets.js`: the view state (`paneCount`, `normalizeView`, `sameView`). |

## Traffic capture

A student can record the frames of a host interface into a PCAP file, and watch them as text.

### Design

QEMU has a network filter object, `filter-dump`, that sits between a NIC and its netdev inside the
QEMU process and writes every frame to a file by itself. Nothing runs in the guest and no program of
ours writes the file. The runner adds it **while the host runs**, through the HMP monitor it already
drives (`runner/engines/qemu-monitor.js`, the `mon.sock` of the node):

```text
object_add filter-dump,id=cap-<capture id>,netdev=lan<N>,file=<node dir>/captures/<capture id>.pcap,queue=all
object_del cap-<capture id>
```

`lan<N>` is the netdev id of interface N (`-netdev vde,id=lan<N>`, `runner/engines/qemu.js`);
`queue=all` records both directions; `maxlen` is left at its default (whole packets). The capture ID
is also the file name, built by the runner, never taken from a user: `eth<N>-<UTC time>[-<n>]`
(`common/capture.js`).

- **Data path.** Browser → server route (`server/routes/captures.js`, one runner command each) →
  runner (`runner/capture.js`) → monitor. The server never reads the file: a download is a runner
  stream (`capture.download`, same credit flow control as session archives, so local and remote
  runners share one code path) relayed to the HTTP response, refused above the limit plus 64 MB.
  The runner lists the files itself and serves only those; it validates the node and interface,
  builds every path, and refuses a second capture on an interface being captured.
- **Records and lifetime.** The capture records (`recording`/`stopped`, reason, size) live in the
  runner's memory with the session; the files live in `<node dir>/captures/` and go with the node
  or the session. A capture is not part of the session ZIP. The `captures` event
  (`{nodeId, captures}`) goes to the session's room on each change; the size of a recording capture
  is not pushed (the browser asks again every 2 s while it displays one).
- **Lease.** A capture lasts only while the Capture dialog of the tab that started it is open. The tab
  *leases* the capture on its session socket (`capture-lease`, `server/capture-lease.js`; the leases of
  a session are shared by its sockets); when that socket closes (tab closed, reload, crash, lost
  network) the server tells the runner to stop the capture and delete its file, like the live view
  that dies with its socket. Other tabs read the leases (`capture-leased`) to show such a capture
  read-only and to leave it alone; they never take or release a lease. The dialog saves the PCAP
  through the browser's download when a capture ends while it is open, and deletes the captures it
  started when it closes; opening it deletes the finished files nobody leases. An administrator's
  discard at disconnect is audited as `capture-discarded` (`admin.log`).
- **Limits** (`common/capture.js`, one place; placeholders for the quotas of milestone 8): 100 MB
  per capture file and 4 capture files per node. A 500 ms watcher polls the size of the recording
  files and removes the filter at the limit (state "stopped: size limit reached"); a burst can
  overshoot by what QEMU writes between two looks. A capture also ends when the QEMU process exits
  (`host-stopped`), whatever the cause.
- **Verification after `object_add`.** QEMU's monitor says nothing when the filter cannot be made
  (unknown netdev, unwritable path): the runner checks that the file exists afterwards. A comma in
  the runtime path is doubled for QEMU; a path with whitespace or quotes is refused.
- **Download of a live capture.** `runner/pcap.js` walks the packet records and cuts the file after
  the last whole packet, so Wireshark never opens a half packet.
- **Rights.** The owner, and an administrator who holds the console-control lock of the observed
  session (the observation gate's one exception: only POST and DELETE on the node capture routes
  and the capture GETs, only while `controlHeld`), may start, stop, list, download, delete and
  watch. Any other observer gets 403 on every capture route, the list and the download included.
  Starts, stops, deletes and downloads go to `users.log` (`capture-started`, `capture-stopped`,
  `capture-deleted`, `capture-downloaded`: node, capture ID, interface) or, for an administrator, to
  `admin.log` with the owner's login; a live view started by an administrator is logged as
  `capture-viewed`. Packet contents are never logged.
- **Not covered.** VirtualBox hosts (disabled with the reason), a stopped host (QEMU does not
  exist), the capture of a whole switch, and a capture filter at start (the BPF filter belongs to the
  live view only).

### Live view

The only place where an external program runs. `capture.live.start` spawns `tcpdump -l -n -r -
[-- <filter>]` on the runner's machine **with an argument array, never a shell**, and
`runner/capture-live.js` feeds its standard input with the capture file from the first byte, then
as the file grows while the capture records. Its output goes to the browser as `capture-live`
events ({liveId, data}, 32 KB at most each, 50 ms coalescing), which the server relays to the socket that asked: the page's session socket, the Capture dialog having no pane
(`capture-live` → `capture-live-data` / `capture-live-end`, `server/capture-live.js`).
The view ends by itself when the capture is stopped and read to its end (`End of the capture.`),
when tcpdump fails or is missing (an immediate error for a missing one), when the dialog stops it or closes
(`capture-live-stop`), when its socket closes, when the node is
removed, and when the control connection closes; every case kills the tcpdump process (SIGTERM,
then SIGKILL after 2 s). At most 4 views per session; output waits while the connection is
congested (`ctx.flow`, as for consoles). `tcpdump` is the command the start-up check resolved
(`ctx.commands.TCPDUMP`, `runner/preflight.js`: the runner's `PATH`, then the `sbin` directories).

The optional filter is **one** argument, after `--`: at most 200 characters, only
`A-Za-z0-9`, space and `. : / _ - ( ) [ ] & | ! < > = + * % ^ ,`, not starting with `-`
(`validateFilter` in `common/capture.js`, checked in the browser's input, by the server and again by
the runner). A syntax error of the expression is tcpdump's own message, shown in the pane.

### Spike (QEMU 11.1.3, two Alpine guests on one `vde_switch`)

Checked on the QEMU of `.env.local` before writing the code:

- `object_add filter-dump,...,queue=all` and `object_del <id>` work on the **running** machine
  through HMP. A duplicate id answers `Error: attempt to add duplicate property`; an unknown netdev
  or an unwritable path fails **silently** (empty reply, no file), hence the check above.
- The PCAP is valid (`tcpdump -r`, `tshark -r`) and holds both directions (ARP, ICMP request and
  reply, DHCP). `queue=rx` alone holds one direction only. Packet times are QEMU's clock, not the
  wall clock.
- The file is readable while it grows and `tail -c +1 -f F | tcpdump -l -n -r -` prints each packet
  as it arrives: QEMU does not buffer (a few milliseconds).
- QEMU **truncates** an existing file when the filter is created, also a file another running
  filter writes (it corrupted the first capture): a file name is never reused. After `object_del`
  or when QEMU exits, the file stays complete and valid.
- `maxlen=64` works (snapshot length 64 in the header, `caplen` 64, real `len`); not used.
- For later tasks: `set_link <netdev id> off|on` works with the **netdev id** (`lan0`), as seen by
  the other host (100% loss). A NIC can be added at runtime with `netdev_add vde,...`, but on `q35`
  `device_add` fails with `Bus 'pcie.0' does not support hotplugging`, and a `pcie-root-port` cannot
  be added at runtime either: hot-adding NICs needs free root ports declared at boot.

## Guest agent (live addresses)

A running host shows the addresses it reports in the Graphic view. Nothing is installed by hand and nothing
goes through the guest's network: QEMU exposes a **virtio-serial channel** to the guest agent as a Unix socket
of the node directory. Measurements, safety analysis and the alternatives: [guest-agent.md](guest-agent.md).

- **Channel.** For a system whose profile has `guestAgent:qemu` true, `runner/engines/qemu.js` adds
  `-chardev socket,id=qga,path=<node dir>/qga.sock,server=on,wait=off -device virtio-serial-pci -device
  virtserialport,chardev=qga,name=org.qemu.guest_agent.0` (the channel must exist at boot on q35) and makes
  the node directory 0700. `qga.sock` is a `NODE_FILES` entry of `common/runtime-dir.js`, so the 107-byte
  budget covers it; QEMU removes it when it exits and the runner removes a leftover.
- **Poller** (`runner/guest-agent.js`). Started when a host starts (`watch`), stopped when it stops, is reset
  or removed (`unwatch`). One call at a time per host: connect, `guest-sync-delimited` with a fresh id, then the
  single command `guest-network-get-interfaces`; 2 s deadline, 64 KB cap on what is read (a hostile guest can
  write about 900 MB/s), the connection is dropped on any violation. Every 5 s after an answer; without an
  answer 2 s, then x1.5 up to 10 s, so a guest without an agent costs one failed call per 10 s. After two failed
  polls in a row, and when the host stops, the addresses are cleared.
- **Allowlist.** The runner can send only `guest-ping`, `guest-info` and `guest-network-get-interfaces`: no
  route, event or setting takes a command name. The images add a second wall, `/etc/qemu/qemu-ga.conf` with
  `allow-rpcs=` the same commands (`scripts/prepare/resources/qemu-ga.conf`); the host cannot enforce it
  (root in the guest owns the agent), so the runner never trusts a reply.
- **Validation** (`common/guest-addresses.js`). Strict patterns for addresses (IPv4 dotted quad, IPv6, prefix
  range), interface names and MACs; at most 16 interfaces, 8 addresses each, 4 kept per NIC; loopback and
  link-local dropped. An interface is matched to the NIC of the node by MAC (the runner chose it), else by the
  name `ethN`. The result, `node.guestAddresses = {"<nic index>": ["192.168.0.1/24"]}`, is informational
  only, never used for routing or any decision.
- **Data path.** Runner event `guest-info` `{nodeId, addresses}` (only when the value changes; `{}` when the
  host stops), forwarded by `server/sockets.js` to the session room (observers too); `GET /api/nodes` carries
  the same `addresses` for a page that loads late. The browser keeps `machine.addresses` and
  `public/topology-graphic.js` draws the text at the host end of the link (`addressesOf`, `addressText`).
- **VirtualBox.** `runner/engines/vbox-guest.js` reads the Guest Additions properties
  (`/VirtualBox/GuestInfo/Net/*`) into the same shape; it is inert (`guestAgent:vbox` is false everywhere)
  and was never run against VirtualBox.

## Images and the session

[`config.json`](../config.json) defines system profiles and base image paths.
`scripts/prepare.sh` downloads and prepares those images in `images/`: RAW for
QEMU and VDI for VirtualBox. At runtime, each host gets its own working disk
PER ENGINE under `<runtime>/sessions/<id>/<host>/` without changing the base image:
QEMU uses `disk.qcow2` (QCOW2 backed by RAW), VirtualBox `disk.vdi` (a differencing
VDI). Both may coexist in a node directory and each engine uses only its own
(`runner/media/disks.js`). Each is created at the first start under its engine and kept
across stops (QEMU reuses the file; the VirtualBox machine stays registered and the
start is a `startvm`); a disk loaded from a ZIP has no registered VirtualBox machine,
so the first start creates the machine around it (`ensureVirtualBoxMachine`). `session.json`,
`host.json`, `switch.json`, startup scripts, and sockets also live in `<runtime>/`.
The JSON files are specified in [json-files.md](json-files.md).
`<runtime>/users/<login>` (made by the runner) links to the user's session directory. The session ID
stays random and never contains the login, which keeps socket paths short and
logins out of archives.

Stopping a host keeps its working disk for a later start. Resetting recreates
the disk of the current engine from the base image (the other engine's disk is kept). Removing a node or stopping the server cleans
up its temporary files. A ZIP export can preserve a session explicitly; a
`.topo` file describes only hosts, switches, and their connections.

## Runner interface

The runner executes sessions; the control plane (web server) never touches a
node process, a node record or a runtime file. They talk through one
connection carrying a small message protocol, the same for the local runner
(a separate process on a Unix socket) and for remote runners (WebSocket over
TLS, milestone 5c). Unit tests run the same protocol over an in-memory stream
pair (`test/unit/runner-pair.js`).

### Ownership

| Data | Owner |
| --- | --- |
| Node records (configuration, runtime state, run log, serial buffer, disks, startup files, launch settings, NIC assignment) | Runner (source of truth) |
| `<runtime>/sessions/<id>/`: `session.json`, `meta.json`, `host.json`, `switch.json`, `startup/`, working disks, sockets, hostname aliases | Runner |
| Session engine (`qemu`/`vbox`), changed by `session.setEngine` (409 while a host is up or busy; answer and `session.settings` list `unavailableHosts`) | Runner (in `session.json`) |
| Settings of a host for both engines (`config` keys `keyword`, `keyword:qemu`, `keyword:vbox`) | Runner (in `host.json`) |
| System catalog (`config.json`), executables, `/dev/kvm`, resource sampling | Runner |
| Login → session ID, owner, creation date, last activity, archive lock, HTTP routers, Socket.IO rooms, console control, view states, audit logs | Control plane |
| `<runtime>/users/<login>` alias, `<runtime>/runner.pid` | Runner |
| `<runtime>/server-<port>.pid` | Control plane |

The control plane keeps no copy of node records. Everything that reads or
changes a node (validation of a host configuration, topology loading, archive
installation, start/stop ordering) runs in the runner, as one command. A route
of `server/routes/` becomes: parse the HTTP request, send one command, map the result
or the error to the HTTP response. The runner's answers are exactly the JSON
bodies the routes return today.

### Transport and framing

One bidirectional byte stream: a Unix stream socket for the local runner. The
control plane listens on `<runtime>/runner-<port>.sock` (mode 0600) and the
runner connects to it, the same direction as a remote runner dialling out in
5c. Frames are length-prefixed:

```text
uint32 BE  length of what follows (1 + payload), at most 16 MiB
uint8      type: 0x4a 'J' = JSON message (UTF-8), 0x42 'B' = binary stream chunk
payload    J: one JSON object
           B: uint32 BE stream ID, then raw bytes (at most 1 MiB)
```

Length prefixes instead of newline-delimited JSON, because archives carry
binary data (QCOW2 disks up to 64 GiB): base64 in JSON would cost a third
more and a JSON parse per chunk. Each frame maps one-to-one to a WebSocket
text or binary message, so 5c changes the transport, not the protocol. No new
dependency: the codec is about 60 lines over `net`.

Console data stays JSON text: the runner already decodes serial and `vdeterm`
output as UTF-8 (`StringDecoder`), and browsers receive strings.

### Messages

```text
hello     runner -> CP, first message of every connection
          {type:'hello', protocol:1, pid, engines:['qemu'|'vbox'...], kvm,
           cpus, memoryBytes, images:{<system>:{raw?, vdi?}} (each {size, sha256|null}),
           warnings:[<sentence>...] (config.json against this machine, max 20),
           runtimeRoot (the runner's runtime directory: display text in /admin, never used),
           limits:{maxSessions} (optional, from the runner file),
           sessions:[{sessionId, engine, owner, createdAt, nodes:[<listNodes entry>...]}]}
request   CP -> runner  {type:'request', id, command, sessionId?, args}
response  runner -> CP  {type:'response', id, result}
                        {type:'response', id, error:{message, status?}}
event     runner -> CP  {type:'event', sessionId, event, payload}
input     CP -> runner  {type:'input', sessionId, nodeId, data}   no response
stream    either way    {type:'stream', id, op:'end'|'error'|'credit', message?, bytes?}
```

- `id` is a positive integer chosen by the sender of the request, unique on the
  connection; responses may arrive in any order. A request pending when the
  connection closes fails with "Runner connection lost.".
- `error.message` is the user-facing message the API returns today; `status`
  is the HTTP status when the runner decided it (unknown node 404, busy or
  non-empty session 409, start error 400/500); otherwise the route's default
  status applies.
- Every per-session command and event carries `sessionId`: one runner process
  serves every session of the machine (resource rules such as "no
  VirtualBox next to QEMU/KVM" and the 5c capacity limits span sessions).
- `input` (console keystrokes, at most 4096 characters, already checked by
  `server/sockets.js`) has no response, to keep typing latency at one write. Messages
  on one connection are handled in order, so input, resize and clear keep
  their order, and so do the events of a node.

### Commands

Session: `session.create {sessionId, owner, createdAt}` (directory,
`session.json`, `meta.json`), `session.delete` (destroy every node, remove the
directory), `session.settings` / `session.setEngine {engine}`,
`session.summary` (counts, running nodes, reserved RAM and CPU, for `/admin`),
`runner.shutdown` (every session, used at server stop).

Nodes (args mirror the HTTP bodies and queries): `nodes.list`,
`nodes.metrics`, `nodes.stopAll`, `nodes.startAll`, `nodes.deleteAll`,
`node.preview`, `node.start {nodeId, engine?, imageId?}`, `node.stop`,
`node.reboot`, `node.reset`, `node.monitor {command}`, `node.rename {name}`,
`node.delete`, `switch.create {id, name, autostart}`, `host.create {...}`,
`host.config` / `host.configure {...}`, `host.guestMedia` /
`host.setGuestMedia`, `host.buildGuestCdrom`, `host.attachGuestCdrom`.

Catalog and files: `catalog.systems`, `topology.preview {text, engine}`,
`topology.load {text, engine, autostart}`, `topology.export`,
`archive.estimate {includeDisks}` (answer: `workingDisks {qemu, vbox}`), `archive.check {baseImages}` (`{system: {raw?, vdi?}}`),
`archive.export {includeDisks}` (result `{stream, size}`, then the ZIP on that
stream), `archive.import {stream, query, contentType, declaredBytes}`
(the CP sends the uploaded ZIP on that stream as it arrives, with the HTTP
query options, type and declared size; the result is the import response).
Commands whose HTTP route takes a JSON body receive it as `body`
(`host.create`, `host.configure`, `session.setEngine`, `topology.*`, ...).

Traffic capture (see [Traffic capture](#traffic-capture)): `captures.list {nodeId?}`,
`capture.start {nodeId, interface}`, `capture.stop {nodeId, captureId}`, `capture.delete {nodeId, captureId}`,
`capture.download {nodeId, captureId}` (result `{stream, size, name}`, then the PCAP on that stream),
`capture.live.start {nodeId, captureId, liveId, filter?}`, `capture.live.stop {liveId}`.

Consoles (`nodeId` of the console commands is a [console ID](#console-ids)):
`console.attach {nodeId}` (the `node-snapshot` content: state, logs, serial
buffer of that console), `console.resize {nodeId, cols, rows}`, `console.clear {nodeId,
line, column}`, and `input` messages.

### Events

`state`, `log`, `logs-reset`, `serial`, `serial-reset`, `nodes-removed`,
`nodes-changed`, `node-renamed`, `general-settings-changed`, `guest-info` `{nodeId, addresses}`, `captures` `{nodeId, captures}` and `capture-live` `{liveId, data}` or `{liveId, end}`, with today's
Socket.IO payloads; `server/sockets.js` forwards them to the rooms of `sessionId`
(the last three were emitted by routes, they now come from the runner like the
others).

### Streams and backpressure

Archive transfers use binary frames on a stream ID allocated by the sender of
the request (`archive.import`) or by the runner (`archive.export`). Credit
flow control: a sender keeps at most 4 MiB unacknowledged per stream, the
receiver returns `credit` messages as it writes the bytes to disk or to the
HTTP response; `end` closes the stream, `error` aborts it, and so does the
connection loss. A receiver that gives up sends `cancel`: the sender's stream
ends with that error and no answer; late frames for a finished stream are
ignored, and no stream ever raises an unhandled `error` event. A transfer therefore never buffers more than 4 MiB in memory,
whatever the archive size.

Console output is coalesced per node and flushed once per event-loop turn. If
the connection's write buffer exceeds 8 MiB (a guest flooding its console),
the runner pauses the serial sockets and `vdeterm` terminals until the buffer
drains: the guest blocks on its UART instead of growing the server's memory.
Order is kept since nothing is dropped.

### Runners in the control plane

`server/runner-registry.js` holds every runner the control plane knows, each
with its own client (`server/runner-client.js`, one instance per connection,
never a global): `id`, `state` (`starting`, `online`, `lost`), the
capabilities from `hello` (engines, images, capacity, warnings), its
`paused`, `address` and `ownerLogin` (null for a shared runner; reserved for
a runner owned by one student, unused). The entry `local` is the
runner of this machine, which dialled the Unix-socket gateway; a remote runner has
the ID given at registration (`r-xxxxxxxx`) and stays in the registry, state `lost`, while offline.
Every runner has a record in `runners.json` (schema 2; the record `local` is created at the first connection and has no token
hash). Nobody is trusted by transport: there is no `trusted` or `local` flag, a `hello` is untrusted input and what a runner may do
is decided by its record (paused, revoked). The server performs **no filesystem action on a runner's directories**: session directory
removal (at `session.delete`), `users/` aliases and pruning are the runner's (`runner/runtime-tidy.js`).

The session manager binds each session ID to a runner ID. The control plane
assigns session IDs (the runner never invents one) and chooses the runner in
one place, `pickRunner(login, sessionsOf)`, called once when a session is created: among the runners
that are online, not paused, have an engine and are under their `maxSessions` (declared in the
runner file, announced in `hello`), the one with the smallest sessions / `maxSessions` ratio (the plain
count without a limit); a tie goes to the local runner, then to the earliest registered. With no
candidate the user gets 503 "No runner is available" and the log gives the reasons. A session stays on its
runner for life. Resource rules that
span sessions (QEMU/KVM next to VirtualBox, metrics, later capacity) are
evaluated by each runner over its own sessions.

### Connection lifecycle

A runner always dials the server; the server never connects out, and never
starts or supervises a runner. A runner is a process of its own, started by
`./scripts/runner.sh` (`runner/main.js --port PORT`): by `./scripts/start.sh`,
which runs the server and a runner as two commands (development, tests, demo),
by hand, or as a systemd service. The server only listens; a runner dials in at
any time, and the server serves browsers without waiting for it. Session
routes answer 503 until one is online.

1. The server (`server/runner-gateway.js`) listens on `<runtime>/runner-<port>.sock`
   (mode 0600). It accepts one connection when no runner is registered or the
   registered one is lost, and closes any other at once.
2. The runner resolves its executables (`runner/preflight.js`), prints its
   configuration warnings, connects and sends `hello`. A runner that cannot
   start (an executable missing) prints its message and exits.
3. On `hello`, the control plane resynchronises (`SessionManager.resync`): a
   session bound to that runner but absent from `hello` is dropped (as below).
   A session reported by the runner that the control plane does not know is
   **adopted** when its `sessionId` matches the ID pattern, the server's own
   binding (`<runtime>/bindings.json`, `server/session-bindings.js`, written before `session.create`) says that it belongs
   to this runner, and the owner of the binding has no workspace yet: the server creates the workspace for that owner
   (same path as opening a session: router, sockets, `session-adopted` in `users.log`). The `owner` and `createdAt` a `hello`
   announces are ignored. Otherwise (no binding, a binding to another runner, another session for the same owner, an invalid ID)
   it is deleted with `session.delete`; a binding of this runner that the `hello` does not report is dropped. The browsers log in
   again after a server restart and `select-node` re-attaches their consoles;
   the `lastActivity` of an adopted session is unknown, so it counts from its
   creation date. No runner ever chooses an owner: adoption follows the server's bindings.
4. Server stop (SIGINT, SIGTERM, `./scripts/stop.sh`): the server only closes
   the socket and exits; it removes the socket. What happens to the machines
   is the runner's choice (next point). `scripts/start.sh` stops its runner
   first (SIGTERM: the runner destroys every node of every session and removes
   `<runtime>/sessions/<id>/`), kills what is left of its process group, then
   stops the server.
5. `--exit-on-disconnect` is a choice of whoever starts the runner, not part
   of the protocol. `scripts/start.sh` uses it: the loss of the control
   connection is then the end of the runner's life (it destroys every node,
   removes its session directories and exits), so a server killed with
   SIGKILL leaves no VM behind. A runner started without it (the systemd
   service) keeps its VMs, retries every 2 s and resynchronises with `hello`
   (adoption above). Its console shows "Waiting for the server", "Connected",
   "The server refused the connection" (a runner is already connected) and
   "Connection to the server lost".
6. The server touches no file of a runner. The runner takes `<runtime>/runner.pid` (a live runner on
   the directory makes a second one refuse to start), removes at its own start the empty session
   directories and the dangling `users/<login>` aliases of an earlier runner (non-empty directories stay),
   creates the alias at `session.create` and removes it with the session at `session.delete`.

**Process groups in `scripts/start.sh`.** The script starts the server and the
runner each with `setsid`, so a terminal Ctrl+C reaches the script only. When the
runner ends for any reason, including SIGKILL, the script sends SIGKILL to
what is left of its group (QEMU, `vde_switch`) and stops the server. On Ctrl+C
or SIGTERM it stops the runner (bounded wait), then its group, then the server,
and exits 0; when the server or the runner dies by itself it exits with its
status. It never restarts anything: restarts are systemd's job
(`docs/deployment.md`).

**Runner loss.** The server never exits because a runner died. When a
runner's connection drops or its process exits, the registry marks it `lost`:

1. the control plane drops every session bound to it like a deleted session
   (users.log `session-deleted` with the reason `runner lost`; browsers get
   `session-deleted` and reload into a new, empty session): the VMs died with
   the runner, so there is nothing to keep. The server removes no directory: what the dead runner
   left is pruned (empty) or kept (non-empty) by the next runner on that directory, at its start;
2. nothing restarts the runner. Under `scripts/start.sh` the script kills the
   runner's process group (QEMU and `vde_switch` are in it; `vdeterm` ends with
   its pseudo-terminal) and stops the server; in a deployment systemd restarts
   the runner service. Requests reaching a session while no runner is online
   answer 503.

In manual mode the sessions are dropped the same way, but nothing is killed or
respawned: the runner is the user's to restart, and machines of a dead runner
may stay in its process group (`scripts/killall.sh` stops them).

VirtualBox VMs run under VBoxSVC, outside the process group: after a runner
crash they stay registered, as after a server crash today.

### User-land runners

A runner is an ordinary unprivileged process, never root, possibly on a
student's lab machine (roadmap, "Personal runners").

- It assumes no root, no capability, no dedicated system account, and writes
  nothing to `/etc` or `/var`. Every path is a parameter of `runner/main.js`:
  `--connect <socket>` (control connection), `--runtime <dir>` (sessions,
  default `/tmp/qw-<login>/<port>` (common/runtime-dir.js), shared with the server), `--config <file>` (system catalog,
  default the project's `config.json`). `--port PORT` is `--connect <this
  project>/…/runner-<n>.sock` (in the runtime directory). `scripts/runner.sh` gets no `--runtime`: it derives the same directory from `--port`.
  The 5c configuration (`~/.config/qemuweb-runner/runner.json`, systemd
  `--user` unit) is out of scope here.
- The control socket is created by the control plane with mode 0600 in
  `<runtime>/`, a directory the same user owns.
- QEMU and VDE run unprivileged; only `/dev/kvm` needs the `kvm` group. The
  runner announces what it can do in `hello` instead of failing late:
  `engines` (QEMU needs its emulator and disk tool, VirtualBox `VBoxManage`;
  a runner may have only one), `kvm` (true when `/dev/kvm` is readable and writable),
  `cpus`, `memoryBytes`, and `images` (per system of its catalog: the RAW
  and VDI images present, with size and SHA-256 when known from
  `<image>.sha256` or the cache, never computed at connection time), and
  `warnings`: sentences from `runner/config-warnings.js` about `config.json`
  on this machine (a system whose base image is missing, default memory or
  processors above what the machine has). The runner prints them itself at
  startup, under "Checking configuration…", with a warning icon (with a `[runner]`
  prefix under `scripts/start.sh`); the registry keeps them in the runner's
  capabilities and `/admin` shows them. Starting a host adds a `# Warning:`
  line to its Log when the hosts of the runner would reserve more than 90 % of
  the RAM (`memoryWarning`, never blocking).
- Nothing in the protocol relies on a shared user, uid or filesystem: paths
  never cross the connection as data the other side opens (archives travel as
  streams, the launch preview shows paths for display only), and a session
  is named by its ID only.

### Remote runners (5c)

A remote runner is the same protocol over a WebSocket (`/runner/connect`, `ws` duplex stream under a
`Connection`), dialled **by the runner**, which authenticates with `Authorization: Bearer <authToken>` and
`X-Runner-Id`. The server keeps only a sha256 of each token (`runners.json`) and compares it in constant
time; unknown or revoked is 401 (the runner stops), a second live connection of an ID is 409. A runner gets its
identity once by redeeming a single-use, time-limited **registration token** created by an admin
(`POST /api/runner/register`, the one unauthenticated route). Nobody is trusted by transport.

Both ends ping every 15 s and terminate a connection that misses a pong; the runner reconnects after 2 s doubling to
30 s and keeps its machines meanwhile. On a loss of a runner the session manager keeps its sessions for
`--runner-grace` seconds (0: drop at once): the handle (`client.session(id)`) is
a stable object, routes answer 503 (`manager.available`), and pages get `runner-state {online: false}`. When the
runner returns (same ID) and its `hello` lists a session, the new client **adopts** the handle (`RunnerClient.adopt`):
routers, Socket.IO rooms and event subscribers keep working, `runner-state {online: true}` makes the pages select
their consoles again (the runner kept the output); a session the hello no longer lists is dropped, one the server
no longer knows (grace expired) is deleted on the runner. A session of a runner that the server's `bindings.json` does not list is never adopted.

### Multiple runners and untrusted runners

The 5a/5b choices hold for N runners: one client per runner, sessions bound
to a runner, `pickRunner` as the single placement point, per-runner
accounting. A runner on a student's own machine (owned by that student) flips
the trust model of the local runner: the control plane must not trust it.

- Everything from a runner is checked: an event or a response is accepted
  only for a session ID bound to that runner, frames and payloads have size
  limits, and payloads are validated before they reach a browser (console data
  is untrusted text, as it already is for guests).
- A runner provides no identity or authorization: logins, roles, console
  control and audit stay in the control plane, and a runner only ever receives
  commands for its own sessions.
- Later (6, no code now; the remote runners of 5c are for trusted machines): runner tokens bound to a user (`ownerLogin`),
  placement restricted to the owner's runners, quotas enforced by the control
  plane as well as by the runner, and archive streams size-limited on both
  sides.

### Runner model (RUN03, design study)

Decided (22 November 2026), not yet implemented: option C: the local runner becomes a runner like the others: same WebSocket path and token as a remote runner
(no Unix socket), own directory, no file shared with the server, one adoption rule from a persisted binding. The study, the options and the decision list are in
[runner-model.md](runner-model.md). Until the user validates it, the sections above describe the code as it is.

### Testing

- Unit: the frame codec (split and merged chunks, size limits, binary
  frames), the client (request/response matching, errors with status,
  connection loss failing pending requests, events), the dispatcher (unknown
  command, unknown session or node), stream credit; client and dispatcher
  connected through an in-memory duplex pair, no process. The existing runner
  unit tests drive the runner service directly.
- Boundaries: `runner/` requires only `runner/`, `common/`, built-ins and
  `node-pty`; the control plane reaches the runner only through the client
  (`server/runner-client.js`) and never requires `runner/`.
- Integration: every scenario starts QemuWeb through `scripts/start.sh`, the real
  launch sequence. `check-runner` (VDE only) checks that sequence: the server and
  runner processes under `start.sh`, a switch session through it, the effect of
  SIGKILL on the runner, and that no `vde_switch`/`qemu-system` process nor
  `<runtime>/sessions/<id>` remains after a stop.
  `check-runner-manual` runs the server alone (`node server/main.js`): a runner started
  by hand survives a SIGKILL of the server, reconnects to a new one and its session is
  adopted.
