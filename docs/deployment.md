# Deployment behind nginx

QemuWeb always listens on `127.0.0.1`. To open it to students, put a reverse
proxy in front of it that terminates TLS and forwards HTTP and WebSocket
traffic. This page uses nginx; any proxy with the same features works.

Until per-user quotas, QEMU monitor restrictions, cross-site request checks and
the runner jail exist (milestone 6 of the roadmap), give accounts only to
trusted users.

**Give QemuWeb its own domain name** (for example `qemuweb.example.org`), never
a sub-domain or a site shared with pages that students can publish (for
example `~login` pages or `students.example.org/...`). QemuWeb does not check
the `Origin` of requests yet: the `SameSite=Lax` login cookie is then the only
protection against requests forged by another site, and it does not separate
pages of the same site.

## 1. Accounts

Create the accounts before opening the service (see the README, section
*Users and sessions*):

```sh
./scripts/user.sh import-csv class.csv      # login,password[,role] per line
./scripts/user.sh list
```

Keep `users.json` readable only by the account that runs QemuWeb (the script
writes it with mode 0600). Do not set `QEMUWEB_AUTH=off` on an exposed server.

## 2. Environment of the QemuWeb service

| Setting | Value behind nginx | Why |
| --- | --- | --- |
| `--listen` (option of `server/main.js`) | `3002` (default, or another local port) | Port nginx forwards to. |
| `QEMUWEB_TRUST_PROXY` | `loopback` | Trust `X-Forwarded-Proto` and `X-Forwarded-For` from nginx on the same machine, so that the login cookie gets the `Secure` attribute over HTTPS. |
| `QEMUWEB_SESSION_HOURS` | `12` (default) | Login lifetime, renewed while the user is active. |
| `QEMUWEB_USERS_FILE` | optional | Users file outside the repository, e.g. `/etc/qemuweb/users.json`. |
| `QEMUWEB_LOG_DIR` | optional | Log directory outside the repository, e.g. `/var/log/qemuweb` (see [Server logs](#server-logs)). |

QemuWeb always runs as two processes: the server and a runner (the process that runs
the machines). `./scripts/start.sh` (`npm start`) starts both for development and for tests; a
deployment runs them as two systemd services of the same machine, so that restarting the
server (an upgrade, a crash) leaves the machines running. See "The two services" below.

## The runner process

The server does not run the machines itself: a **runner** (`runner/main.js`)
does. A runner always dials the server, on the Unix socket
`runtime/runner-<port>.sock` of the project (mode 0600, so only the server's own account can
connect). The server never reaches out to a runner, and the web interface only
*displays* runners (the **Runners** section of `/admin`): it registers none.
One runner is accepted for now; a second connection is refused. Runners on
other machines, with tokens and TLS, come with a later milestone.

There is one way to start it, in every environment:

- **`./scripts/start.sh`** (what `npm start`, `scripts/demo.sh` and the integration tests
  use) starts `./scripts/server.sh --listen N` and, once the socket exists, `./scripts/runner.sh
  --port N --exit-on-disconnect`, each in its own process group, with output lines prefixed `[server]`
  and `[runner]`. Ctrl+C or SIGTERM stops the runner first (it stops every machine), kills what
  is left of its group (QEMU, `vde_switch`), then stops the server, and exits 0. When the runner
  ends for any reason (even SIGKILL), what is left of its group is killed at once and the
  server is stopped; when the server dies, the runner ends with it. In both cases the script
  exits with the status of the process that ended. Nothing is restarted.
- **`./scripts/server.sh` and `./scripts/runner.sh` by themselves** (two terminals, or the two
  services below): the server opens HTTP at once and prints "No runner connected. Start one
  with ./scripts/runner.sh, or run ./scripts/start.sh for the server and a runner". Until a
  runner connects, session routes answer 503 ("No runner is connected."). `--listen <n>` selects
  the server's port (default 3002; the runner then needs `--port <n>`). Without `--exit-on-disconnect` the runner keeps its
  machines if the server restarts and reconnects within 2 seconds of the server being back.

The runner runs under a normal account, never root (`scripts/runner.sh` refuses
root); it needs the `kvm` group for `/dev/kvm`. It prints its own checks on its
console: "Checking dependencies…", "Checking configuration…" and the state of
the connection (waiting for the server, connected, refused, lost). Under
`scripts/start.sh` they carry the `[runner]` prefix.

- **Engines:** a runner needs VDE, `genisoimage`, Node.js and Python, and at
  least one engine. QEMU (with its disk tool) and VirtualBox are checked
  separately: a missing one only disables the hosts of that engine (a line
  marked `-` in "Checking dependencies…"), because `config.json` is shared by
  runners that do not all have both. A new session uses the first engine the
  runner has. QEMU also needs `/dev/kvm`: when it is not accessible the runner
  warns at startup and QEMU hosts cannot start.
- **Startup failure:** a missing common tool or no engine at all stops the
  runner with its message (`scripts/start.sh` then ends). Another server already using the socket of
  the same port is refused.
- **Configuration warnings:** the runner prints one line per warning about
  `config.json` on this machine, marked with a warning icon (a system whose base
  image is missing, with the `prepare.sh` command to run; default memory or
  processors larger than the machine); without warnings, a check mark and the
  number of systems. They are also announced to the server and shown in the
  **Runners** section of `/admin`.
- **Start-time memory warning:** when a host starts and the hosts running on
  that runner (every session) would reserve more than 90 % of the machine's
  RAM, a `# Warning:` line is added to the host's Log. The host still starts.
- **Server restart with a separate runner:** the runner keeps its machines. When
  it reconnects, the server **adopts** each of its sessions for its owner (the
  login recorded in the session's `meta.json`): the user logs in again (cookies
  do not survive a restart) and finds the same session, machines and consoles,
  recorded as `session-adopted` in `users.log`. Only the trusted runner of this machine is
  adopted. A session whose owner is invalid, or already has a session, is
  deleted on the runner. Sessions the server no longer knows are never kept.
- **Files shared with the runner:** the server touches the runner's files only
  when it shares `runtime/` with it, that is when the runner's `runtimeRoot`
  (announced in `hello`) is the server's own `runtime/` (the default of `--runtime`). Then, when a runner connects, the server prunes the empty
  `runtime/sessions/<id>` directories left by earlier servers (sparing the
  sessions that `hello` reports and those of other live servers), creates the
  `runtime/users/<login>` aliases, and removes the session directories of a runner
  that is lost (a runner killed by SIGKILL cannot). A runner started with another
  `--runtime` is never touched: only a local runner (today, the same `runtimeRoot` in
  `hello`) is cleaned by the server.
- **Runner crash:** the server keeps running; the sessions that ran on the
  runner are closed (their machines are gone; users' pages reload into a new,
  empty session, recorded as `session-deleted` with the reason `runner lost` in
  `users.log`). Nothing restarts the runner by itself: under `scripts/start.sh`
  the script kills what is left of the runner's process group (QEMU belongs to
  it) and stops the server, and systemd's `Restart=` policy restarts the
  services in a deployment. A runner killed outside `start.sh` may leave
  machines running: `scripts/killall.sh` stops them.
- **Server crash:** a runner started with `--exit-on-disconnect` (as by
  `scripts/start.sh`) notices the closed connection, stops every machine,
  removes the session directories and exits. Without that option the runner
  keeps everything and reconnects.
- **What to check:** `./scripts/status.sh` shows each server, then each runner
  with the machines below it, as "Runner" while a server runs on its port, or
  "Runner (waiting for a server)". `ps -o pid,pgid,args -C node` shows
  `runner/main.js --port 3002 ...`.
  `scripts/stop.sh` stops the server only. `scripts/killall.sh` also stops
  runner processes. VirtualBox VMs run under VBoxSVC, outside the runner's
  group: after a runner crash, `scripts/killall.sh` cleans them up.

### The two services

Both are systemd services of the same machine, so that restarting the server
(an upgrade) leaves the machines running. The runner is a user service (never
root), here for an account `qemuweb` that also runs the server, assuming the
repository in `/srv/qemuweb` and `qemuweb` in the `kvm` group:

```ini
# /etc/systemd/system/qemuweb.service
[Unit]
Description=QemuWeb
After=network.target

[Service]
User=qemuweb
WorkingDirectory=/srv/qemuweb
Environment=QEMUWEB_TRUST_PROXY=loopback
ExecStart=/usr/bin/node server/main.js --listen 3002
KillSignal=SIGTERM
TimeoutStopSec=30
Restart=on-failure

[Install]
WantedBy=multi-user.target

# ~qemuweb/.config/systemd/user/qemuweb-runner.service (systemd --user, loginctl enable-linger qemuweb)
[Service]
WorkingDirectory=/srv/qemuweb
ExecStart=/srv/qemuweb/scripts/runner.sh --port 3002
KillMode=mixed
Restart=on-failure
```

Both must share `/srv/qemuweb/runtime` (the runner socket is in it). Restarts
are systemd's job (`Restart=`): QemuWeb never restarts a process itself.
`KillMode=mixed` sends SIGTERM to the runner only, which stops its machines in
order; SIGKILL goes to every remaining process of the unit (QEMU, `vde_switch`)
only after the stop timeout. Stopping the runner service stops its machines;
tell users to save a session ZIP first. Stopping the server service leaves them
running, and the sessions are adopted again when the server is back.

## Server logs

The server writes two logs, as JSON lines, in the log directory: `logs/` at the
repository root (ignored by Git; `QEMUWEB_LOG_DIR` selects another directory),
which the server creates at startup with mode 0700 if it is missing. Both files
are created with mode 0600. The **Logs** panel of `/admin` shows their last 200
entries and downloads them. `scripts/cleanall.sh` does not touch them. A write
failure is reported on the server output and never fails the request.

### Admin log

`admin.log` is the audit log of administrator actions. Every administration
action appends one line:

```json
{"time":"2026-11-16T09:12:03.120Z","admin":"prof","action":"control-start","target":{"login":"alice"},"result":"ok"}
```

| Action | Target |
| --- | --- |
| `observe` | `login`: written when an admin's first console connection to that session opens (one line per admin and session while it stays open). |
| `control-start`, `control-end` | `login` (control covers the whole session); `control-end` adds `reason` (`released`, `disconnected`: the admin's last page on the session closed, `idle`, `session deleted`). |
| `stop-all`, `delete-session` | `login`. |
| `bulk-delete` | `logins`. |
| `create-account` | `login`, `role`. |
| `reset-password`, `disable-account`, `enable-account` | `login`. |
| `set-role` | `login`, `role`. |
| `remove-account` | `login`, `session` (whether it had a session, deleted with it). |

`result` is `ok` or `error: <message>`. Passwords and typed console text are
never written; reading the session list or the logs is not logged.

### Users log

`users.log` records user events, one line each:

```json
{"time":"2026-11-16T09:15:41.002Z","user":"alice","event":"node-started","target":{"nodeId":"h-0123456789abcdef"},"result":"ok"}
```

| Event | Target |
| --- | --- |
| `login`, `logout` | none. |
| `login-failed` | none; `user` is the login name that was tried (control characters removed, at most 64 characters), whether or not the account exists. |
| `session-created` | `sessionId`. |
| `session-adopted` | `sessionId`. The server restarted and a runner that kept its machines reconnected: its session was taken over for its owner. |
| `session-deleted` | `sessionId`, `by` (the user, or the admin who deleted it; `null` when the session was dropped), and `reason` when it was dropped: `runner lost` (its runner died) or `creation failed`. |
| `node-created` | `nodeId`, `kind` (`host` or `switch`). |
| `node-started`, `node-stopped`, `node-deleted` | `nodeId` (**Resume all**, **Stop all** and the removal of every node: `all`). |
| `archive-loaded`, `archive-saved` | `kind`: `session` (ZIP) or `topology`. |

Node and archive events come from the user's own explicit requests, with
`result` `ok` or `error: HTTP <status>`; nodes started by a topology load or at
creation are not listed one by one. Never logged: passwords, typed console
text, file contents, IP addresses, polling and console traffic, and anything an
admin does while observing (that goes to `admin.log`).

Both files grow without limit: rotate them with `logrotate` (`copytruncate`)
if needed.

## 3. nginx

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name qemuweb.example.org;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name qemuweb.example.org;

    ssl_certificate     /etc/letsencrypt/live/qemuweb.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/qemuweb.example.org/privkey.pem;

    # Session ZIP imports can reach 4 GiB.
    client_max_body_size 4100m;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;

        # WebSocket upgrade for Socket.IO consoles.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # QemuWeb uses X-Forwarded-Proto to mark the cookie Secure.
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;

        # Consoles stay open for hours; large archives take time to upload,
        # check and download.
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        # Stream uploads and downloads instead of buffering gigabytes on disk.
        proxy_request_buffering off;
        proxy_buffering off;
    }
}
```

Check the result:

- `https://qemuweb.example.org/` redirects to the login page;
- after logging in, the browser's developer tools show the `qemuweb_session`
  cookie with `HttpOnly`, `Secure` and `SameSite=Lax`;
- consoles connect over `wss://` (the Network tab shows a `101 Switching
  Protocols` response for `/socket.io/`).

## Known limits

- Cross-site request checks (`Origin`/CSRF) and a revocable logout come with
  milestone 6; until then, keep QemuWeb on its own domain name (see above).
- Log out only clears the cookie in the browser: a copied cookie stays valid
  until it expires (`QEMUWEB_SESSION_HOURS`). Removing the account, or restarting
  the server (every start draws a new cookie signing key, which logs everybody out),
  revokes it.
- A user removed with `scripts/user.sh remove` can no longer log in, but their
  running session stays on the server until it is deleted or the server
  restarts. Adding the same login again while the server is running gives that
  account the old session back.
- An account disabled with `scripts/user.sh disable` loses its cookie at once;
  its already open consoles are closed at their next action. Disabling it from
  `/admin` closes them immediately.
