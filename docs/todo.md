# QemuWeb TODO

Side tasks, features and bug fixes that are not milestones of the
[roadmap](roadmap.md). The roadmap is the plan; this list collects what comes up
along the way. Add an entry when something is noticed, remove it when it is done (the commit
message says what changed). Keep each entry to a few lines: what, why, and an idea if there is one.

## Bugs and rough edges

- **Switch consoles toggle in observation**: the user reports that the "switch consoles" button is
  not greyed out when the view is driven (Follow checked, or owner under admin control), although it
  carries the `view-control` class. Not reproduced by reading the code; find the exact case.
- **Followed Monitor view**: a `monitor` view received before the node data says Monitor is
  supported falls back to the console and is not applied again later.
- **Test harness kill fallback**: after 12 s the harness kills only `start.sh`; the server and the
  runner, in their own sessions, could survive a hung stop (`test/integration/qemuweb-client.js`).
- **Clear notes**: the lines written to the Log view by Clear have no timestamp.

- **Scripts on a custom runtime directory**: `status.sh`, `killall.sh` and `cleanall.sh` only know the
  default `runtime/` (their paths are written in several places). With `--runtime /var/lib/qemuweb`
  they do not see that directory. Add a `--runtime DIR` option to each, like `start.sh` and `stop.sh`.
- **start.sh with refused arguments**: when the server refuses its options and exits at once, the script
  must report the server's status and exit with it (read, never run): check it by hand
  (`./scripts/start.sh --session-hours 0` must exit 2 at once and leave nothing running).

- **Runner with an unreadable config.json**: it still prints `✓ config.json  0 systems` after the
  `Cannot read the system catalog` error line. It should print a ✗ and abort.
- **start.sh message**: when the server refuses its options and exits at once, it prints "The server
  exited (status 2); stopping the runner." although no runner was started.

- **Remote runner sessions after a server restart**: a restart deletes every session of a remote runner,
  because the hello of an untrusted runner is never adopted. Persisting the session-to-runner binding
  (and the VMs surviving) would fix it; it also conflicts with the roadmap line saying the VMs keep running.
- **Forcing the loss of a runner's sessions**: a revoked or lost runner keeps its sessions until the grace
  period (`--runner-grace`) ends; the admin has no way to delete them at once.
- **Local runner pause**: the paused state of the local runner is memory only (a remote runner's is in
  `runners.json`).
- **`register --runtime`**: only needed when the runner's directory differs from `runtime/` of the repository.
- **`runner-state` in the browser**: the re-selection of the console after a runner comes back is only tested
  through the socket events of `check-runner-remote`, not in a real browser.

- **`prepare.sh`: ISO host blocked by the CREMI proxy**: the Debian ISO and its `SHA512SUMS` come from the fixed URL
  `cdimage.debian.org`, which the CREMI squid has answered 503 for. Idea: a setting for the base URL
  of the ISO (or another host), or document placing the ISO and `SHA512SUMS` in `sources/debian13-legacy/` by hand.
  Also unchecked against a real log: the failure strings and phase markers of `scripts/prepare/lib/common.sh`.

- **Runtime path too long, reported late**: a `runtime/` directory of more than 49 characters (the sockets of a node
  must fit in 107 bytes) only fails when the first node is created or a session is loaded, with "move the project to a
  shorter directory". Check it at startup (`Checking configuration…`, with the `--runtime` hint), in the server and the
  runner, or shorten the node socket paths (for example a short alias directory for the sockets).

## Deployment and identity

- **OpenID: what stays open after OIDC01.** The role of administrators comes only from `users.json`
  (`scripts/user.sh add LOGIN --role admin --no-password`): `X-User-Groups` is not used by the server, so no
  group-to-role rule exists yet. A student with no entry in `users.json` cannot be listed in `/admin` (accounts) until it
  is added with `--no-password`. The key is rotated by hand (`deploy/cremi/deploy-cremi.md`, step 10). The proxy identity
  has no throttling of its own: the login throttling of milestone 6 is still to do.
- **OpenID: the SSO session expires during use.** Apache then answers an API call or a Socket.IO connection with a
  redirection to the CREMI login instead of a 401. Today the interface (`public/api.js`, `public/socket.js`) only
  redirects to `/login.html` on a 401 (and on the Socket.IO error `Authentication required.`): a redirection to another
  origin makes the `fetch` fail without a status, so an action shows its error and the Socket.IO connection shows
  `WebSocket unavailable`; the page does not reload by itself (a manual reload goes through the login again). Idea: in
  the Apache site, `OIDCUnAuthAction 401` in a `<Location>` for `/api/` and `/socket.io/`, and the interface reloading
  the page on a 401 when `/auth/me` says `via: proxy` (today a 401 leads to `/login.html`, which in `--auth proxy` is
  itself a 401). Not done: no code change in OIDC01.
- **To check on the CREMI machine** (`deploy/cremi/deploy-cremi.md`, not testable from the repository): the https relay
  must pass WebSocket (Socket.IO, `/runner/connect`), 3600 s timeouts and large bodies; `LimitRequestBody` of the site
  (1 GiB) must match what the relay accepts; the OpenID provider must be reachable from Apache without the proxy.

- **CREMI wildcard certificate renewal**: `/etc/apache2/certs/star_emi_u-bordeaux_fr.crt` and `.key` are links the CREMI
  repoints every year (the current certificate ends on 2 December 2026). Apache must be reloaded
  (`sudo systemctl reload apache2`) after a renewal: say it in the tutorial, or add a hook.

- **CREMI relay: HTTP/1.0 and no `X-Forwarded-For`** (seen in the Apache log of `v0-qemuweb`): the relay talks to Apache
  in HTTP/1.0, which cannot carry a WebSocket (consoles, `/runner/connect`) until it is set to HTTP/1.1 with the `Upgrade`
  headers; and it sends no client address, so `--trust-proxy` and the login throttling of milestone 6 only see the relay.
  Ask the CREMI for both.

- **Remove `--auth both`** (decided with the user, to do later): keep two modes, `password` (local tests, ad hoc server) and
  `proxy` (production behind the front end). `both` mixes two ways in on one port and confuses the question "who
  authenticates this request?". Cost to plan: no password login through the SSH tunnel on a production server (an
  administrator is an OpenID login listed in `users.json` with the role admin; in an incident, restart with
  `--auth password`), so the tunnel tests of consoles and runners need the server in `password` mode until the CREMI
  relay passes WebSocket. Touches server/options.js, server/auth/index.js, the unit, the tutorial, the docs and the tests.
- **Public access by password for guests outside OpenID**: not possible with Apache protecting everything (the
  password accounts are reachable only by the tunnel). Idea: `OIDCUnAuthAction pass`, `X-Proxy-Key` sent only with an
  OpenID identity, and a "CREMI login" link on the login page. Not before the quotas, the HMP allowlist and the login
  throttling of milestone 6; never an admin account.
- **CREMI relay and WebSocket**: for `qemuweb.emi.u-bordeaux.fr` the relay drops `Upgrade` (a WebSocket request to
  `/runner/connect` gets a plain `302 /login.html` from the application) while Apache directly passes it (`401`): ask
  for `proxy_http_version 1.1` and the `Upgrade`/`Connection` headers. Add `upgrade=%{Upgrade}i` to the Apache `LogFormat`
  and the check of Annex A.3 to the tutorial.

## Console and terminal

- **Clear: shell prompt detection** (`public/terminal.js`, `clearPaneConsole`). The guard that
  decides whether `stty rows N cols M` may be typed is a heuristic on the cursor line (trimmed line
  ends with `#`, `$`, `%` or `>`, cursor at the end). Not covered: prompts ending otherwise (`]`,
  `:`, `λ`, zsh symbols), long prompts wrapping over several rows (untested); false positives in
  REPLs whose prompt ends with `>` or `$` (python, sqlite, ssh). Ideas: extract a pure function with
  a unit test over many prompts; or let the guest announce its prompt (`PS1` in `prepare.sh`).
- **Disabled view controls**: no tooltip tells why a control is greyed out (view driven by the
  owner or by the controlling admin).

- **Several floating consoles in the Graphic view**: only one floating window exists (the selected node's pane, see
  `public/graphic-console.js`); a double click on another node reuses it. Idea (task `GRA02`): up to 4 overlapping
  windows, cascaded, a click brings one to the front, each movable, resizable and closable, built on the 4 existing
  panes. Or a docked panel under the graph (side by side or stacked, no overlap). To decide: the maximum number of
  windows; observer and Follow behaviour (disabled under Follow, as today); whether geometry is kept until a reload
  or saved; whether the windows stay independent of the per-user Terminals layout (as today).

## Documentation

- The user manual (`docs/bak/manual.md`, archived) is out of date: serial ports, `start.sh`,
  runner commands, Follow. The manual is now `docs/user-guide.md` (moved out of the README): bring it up to date.

- **Merge the deployment documents** (at the 0.9.0 stabilisation, once the CREMI frontend, the local or remote
  runner choice and milestone 6 are settled): `docs/deployment.md` (generic reference), `deploy/cremi/deploy-cremi.md`
  (site recipe) and `docs/remote-runner-test.md` (test sheet) repeat the systemd unit, the web server site (Apache in `deploy/cremi/`, nginx in `deployment.md`), the runner
  `register`/`run` commands, the account and package steps. Keep two documents: `deployment.md` stays the generic
  reference and points to the files of `deploy/` (unit, Apache site) instead of copying them; `deploy-cremi.md` becomes a
  short recipe that links to it; the test sheet no longer repeats the runner installation.

## Ideas

- More `config.json` warnings at startup (beyond the engine, KVM and serial port checks).
- A runner per student, on the student's machine (needs an untrusted runner model: the control plane
  validates everything it receives). See the roadmap, milestone 5.

## Graphic view

- **No IP address on the cards**: QemuWeb does not know a guest's address without a guest agent. Showing
  it would need one (or a startup-script convention that reports it).
- **Touch**: the Graphic view pans with one finger and zooms with the buttons only; there is no pinch zoom.
- **Floating console position**: its place and size are kept only until the page is reloaded (not per user, not saved).
- **Link editing and new interfaces**: a link is removed by disconnecting the interface (the interface
  stays); removing the interface itself is only in Host Settings.
