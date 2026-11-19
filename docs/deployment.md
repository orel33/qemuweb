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

Create the accounts before opening the service (see the [user guide](user-guide.md#users-and-sessions), section
*Users and sessions*):

```sh
./scripts/user.sh import-csv class.csv      # login,password[,role] per line
./scripts/user.sh list
```

Keep `users.json` readable only by the account that runs QemuWeb (the script
writes it with mode 0600). Do not use `--no-auth` on an exposed server.

## 2. Options of the QemuWeb service

The server reads no environment variable: its options are on the command line of the systemd unit
(see [The two services](#the-two-services)).

| Option | Value behind nginx | Why |
| --- | --- | --- |
| `--listen` | `3002` (default, or another local port) | Port nginx forwards to. |
| `--trust-proxy` | `loopback` | Trust `X-Forwarded-Proto` and `X-Forwarded-For` from nginx on the same machine, so that the login cookie gets the `Secure` attribute over HTTPS. |
| `--session-hours` | `12` (default) | Login lifetime, renewed while the user is active. |
| `--users` | optional | Users file outside the repository, e.g. `/etc/qemuweb/users.json`. |
| `--logs` | optional | Log directory outside the repository, e.g. `/var/log/qemuweb` (see [Server logs](#server-logs)). |
| `--runtime` | optional | State directory outside the repository, e.g. `/var/lib/qemuweb` (give the runner the same one). |

## The runner process

The server does not run the machines itself: a **runner** (`runner/main.js`)
does. A runner always dials the server, on the Unix socket
`<runtime>/runner-<port>.sock` (mode 0600, so only the server's own account can
connect). The server never reaches out to a runner, and the web interface only
manages runners (the **Runners** section of `/admin`). One local runner is accepted on the
Unix socket; a second connection is refused. Runners on other machines connect over
the network with their own token: see [Remote runners](#remote-runners).

There is one way to start it, in every environment:

- **`./scripts/start.sh`** (what `npm start`, `scripts/demo.sh` and the integration tests
  use) starts `./scripts/server.sh --listen PORT --runtime DIR` and, once the socket exists, `./scripts/runner.sh
  --port PORT --runtime DIR --exit-on-disconnect`, each in its own process group, with output lines prefixed `[server]`
  and `[runner]`. Ctrl+C or SIGTERM stops the runner first (it stops every machine), kills what
  is left of its group (QEMU, `vde_switch`), then stops the server, and exits 0. When the runner
  ends for any reason (even SIGKILL), what is left of its group is killed at once and the
  server is stopped; when the server dies, the runner ends with it. In both cases the script
  exits with the status of the process that ended. Nothing is restarted.
- **`./scripts/server.sh` and `./scripts/runner.sh` by themselves** (two terminals, or the two
  services below): the server opens HTTP at once and prints "No runner connected. Start one
  with ./scripts/runner.sh, or run ./scripts/start.sh for the server and a runner". Until a
  runner connects, session routes answer 503 ("No runner is available."). `--listen PORT` selects
  the server's port (default 3002; the runner then needs `--port PORT`). Without `--exit-on-disconnect` the runner keeps its
  machines if the server restarts and reconnects within 2 seconds of the server being back.

The runner runs under a normal account, never root (`scripts/runner.sh` refuses
root); it needs the `kvm` group for `/dev/kvm`. Both programs print, in this order, a
banner (`QemuWeb <version> server|runner`), their `Options` (value and source of every
option), "Checking dependencies…" (the server shows the Node.js it runs on and checks its version, since it runs no external program) and
"Checking configuration…"; the runner then prints the state of the connection (waiting for the
server, connected, refused, lost). A refused option ends either program with status 2 and a
`<program>: <message>` line; a failed check ends it with status 1 ("Startup aborted"). Under
`scripts/start.sh` the lines carry the `[server]` and `[runner]` prefixes. See
[the command line](reference.md#server-and-runner-command-line).

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
  for the **local runner** (the one on the Unix socket, never a remote one), and only when it shares its runtime directory
  with the server, that is when the runner's `runtimeRoot`
  (announced in `hello`) is the server's own `--runtime` (`runtime/` of the project by
  default, for both; there is no environment variable for it). Then, when a runner connects, the
  server prunes the empty `sessions/<id>` directories left by earlier servers (sparing the
  sessions that `hello` reports and those of other live servers), creates the
  `users/<login>` aliases, and removes the session directories of a runner
  that is lost (a runner killed by SIGKILL cannot). A runner whose `hello` announces another
  runtime directory is never touched, and a remote runner is never touched whatever its `hello` says.
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
ExecStart=/usr/bin/node server/main.js --listen 3002 --runtime /var/lib/qemuweb --users /etc/qemuweb/users.json --logs /var/log/qemuweb --trust-proxy loopback
KillSignal=SIGTERM
TimeoutStopSec=30
Restart=on-failure

[Install]
WantedBy=multi-user.target

# ~qemuweb/.config/systemd/user/qemuweb-runner.service (systemd --user, loginctl enable-linger qemuweb)
[Service]
WorkingDirectory=/srv/qemuweb
ExecStart=/srv/qemuweb/scripts/runner.sh --port 3002 --runtime /var/lib/qemuweb
KillMode=mixed
Restart=on-failure
```

Both are given the same `--runtime` (here `/var/lib/qemuweb`, state kept apart from the code;
the default is `/srv/qemuweb/runtime`): the runner socket `runner-<port>.sock` is in it, and it
is what lets the server manage the runner's sessions. The directory must exist and belong to the
`qemuweb` account. Restarts
are systemd's job (`Restart=`): QemuWeb never restarts a process itself.
`KillMode=mixed` sends SIGTERM to the runner only, which stops its machines in
order; SIGKILL goes to every remaining process of the unit (QEMU, `vde_switch`)
only after the stop timeout. Stopping the runner service stops its machines;
tell users to save a session ZIP first. Stopping the server service leaves them
running, and the sessions are adopted again when the server is back.

## Remote runners

A runner can run on another machine (or another account) and connect to the server over the
network. It dials **out**: there is no inbound port, so it works behind a NAT or a lab firewall.
The frame protocol of the local runner runs unchanged over a WebSocket on the path
`/runner/connect` of the web server; nginx terminates TLS and passes the upgrade.

> **Remote runners are for trusted machines.** Until milestone 6 (jail, quotas, HMP allowlist) a runner
> runs the machines under the account that starts it with no confinement, and the server relies on
> its answers. Never use a machine you do not control, and never root. A runner per student is a later idea.

A step-by-step sheet for testing one remote runner (diagram, every option spelled out, expected results,
troubleshooting) is in [remote-runner-test.md](remote-runner-test.md) (PDF: [pdf/remote-runner-test.pdf](pdf/remote-runner-test.pdf)).

### On the server

1. The server keeps the registered runners in `runners.json` (`--runners FILE`, mode 0600, only a hash of each token). The
   startup line `Checking configuration…` shows how many are registered.
2. Add two locations to the nginx `server` block of [section 3](#3-nginx), before `location /`:

```nginx
    # Remote runners: a long-lived WebSocket, outbound from the runner.
    location = /runner/connect {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    # One-time registration of a runner (rate limited by the server).
    location = /api/runner/register {
        proxy_pass http://127.0.0.1:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 8k;
    }
```

   (The generic `location /` of section 3 already passes both; the point of these blocks is the long
   `proxy_read_timeout` and the small body limit.) Both ends also ping every 15 seconds and drop a dead
   connection, so the timeout only needs to exceed that. Start the server with `--trust-proxy loopback`
   so that the registration command and the runner's address use the public name.
3. `--runner-grace SECONDS` (default 300) is how long the sessions of a remote runner that lost
   its connection are kept; `0` drops them at once, like the local runner.

### On the runner machine

Needs the repository (or a copy of `runner/`, `common/`, `scripts/`, `config.json`, `.env`),
Node.js, QEMU, VDE and the images prepared by `./scripts/prepare.sh` **on that machine**; a
system whose image is missing is not offered for the sessions placed there. As an unprivileged account (in
the `kvm` group for `/dev/kvm`):

```sh
# the administrator creates a registration token in /admin/runners and copies the command
./scripts/runner.sh register --url https://qemuweb.example.org --token <registration token> --name salle-12
./scripts/runner.sh run
```

`register` writes `~/.config/qemuweb-runner/runner.json` (or the file given with `--runner-config`,
directory 0700, file 0600): the server URL, the runner ID, the runner's own token, its name, and optionally
the `runtime` and `ca` given to `register` and hand-written `limits` (`maxSessions`, `memoryBytes`, `cpus`). A
registration token is single use and expires (15 minutes, 1 hour or 24 hours, chosen in `/admin`). Sessions live in
`<runtime>/sessions/` of the machine (`--runtime`, default `runtime/` of the repository).

- **TLS:** use an `https://` URL. A server certificate signed by a private authority needs
  `--ca FILE` (the PEM file; `register` keeps it in `runner.json`), or `NODE_EXTRA_CA_CERTS=file` in the environment.
- **Unencrypted URLs:** `http://` and `ws://` are accepted only for this machine (loopback), for tests. Another host needs
  `--insecure`, which prints a warning: the token and all console traffic are then readable on the network.
- **Firewall:** nothing to open on the runner; it needs outbound access to the server's HTTPS port.
- **Network cut:** no machine stops. The runner reconnects after 2 s, then 4, 8, 16 and 30 s; the server keeps its
  sessions during `--runner-grace` and then drops them (and tells the runner to delete them if it returns). A
  restart of the server does not adopt a remote runner's sessions: they are deleted when it reconnects.
- **Revocation:** after **Revoke** in `/admin` the server refuses the token (401): the runner stops its machines and exits
  with status 1 instead of retrying. Register it again to bring it back.

A `systemd --user` unit (run `loginctl enable-linger` for the account so that it starts at boot):

```ini
# ~/.config/systemd/user/qemuweb-runner.service
[Unit]
Description=QemuWeb remote runner
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=%h/qemuweb
ExecStart=%h/qemuweb/scripts/runner.sh run
KillMode=mixed
Restart=on-failure
# A revoked runner exits with status 1 and must not loop: remove the unit, or register it again.
RestartPreventExitStatus=1
# Private certificate authority: Environment=NODE_EXTRA_CA_CERTS=%h/ca.pem

[Install]
WantedBy=default.target
```

### Administration

**Runners** in `/admin` lists the local runner and every registered one: state (online, offline since, paused, revoked),
last seen, remote address, engines, CPU and memory, systems, warnings, sessions and limit. It creates registration
tokens (the command is shown once), **pauses** a runner (drain: no new session, the running ones continue),
**revokes** it, and removes an offline revoked one. The local runner can be paused but not revoked or removed.
Every action is in `logs/admin.log`; a token is never logged. A new session goes to the least loaded online runner
that is not paused and is under its `maxSessions`; when there is none the user gets 503 "No runner is available" and the
server log gives the reasons.

## Server logs

The server writes two logs, as JSON lines, in the log directory: `logs/` at the
repository root (ignored by Git; `--logs` selects another directory),
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
| `login`, `logout` | `via`: `password` or `proxy` (the CREMI deployment, with OpenID: see [deploy/cremi/deploy-cremi.md](../deploy/cremi/deploy-cremi.md) . |
| `proxy-refused` | `reason`: `wrong proxy key`, `invalid login` or `account disabled`. A request that carries a wrong `X-Proxy-Key` is also answered with 403. |
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

## Other single sign-on systems

`--auth proxy` (or `both`) is not tied to OpenID: the front end does the login, and QemuWeb only reads `X-Remote-User`,
guarded by `X-Proxy-Key` (see `deploy/cremi/deploy-cremi.md` for the Apache and OpenID example). QemuWeb needs no change
for another system; only `--logout-url` differs: the logout address of the front end.

| System | Front end | `--logout-url` |
| --- | --- | --- |
| OpenID | Apache `mod_auth_openidc` | `https://HOST/.openid?logout=https://HOST/goodbye` |
| SAML | Apache `mod_shib` | the Shibboleth logout handler (`/Shibboleth.sso/Logout`) |
| CAS | Apache `mod_auth_cas` | the logout URL of the CAS server |
| OpenID, OAuth2 and similar | `oauth2-proxy` with nginx | `/oauth2/sign_out` |

The front end must remove any `X-Remote-User` sent by a browser and add `X-Proxy-Key` to every request it forwards,
WebSocket upgrades included.

## Known limits

- Cross-site request checks (`Origin`/CSRF) and a revocable logout come with
  milestone 6; until then, keep QemuWeb on its own domain name (see above).
- Log out only clears the cookie in the browser: a copied cookie stays valid
  until it expires (`--session-hours`). Removing the account, or restarting
  the server (every start draws a new cookie signing key, which logs everybody out),
  revokes it.
- A user removed with `scripts/user.sh remove` can no longer log in, but their
  running session stays on the server until it is deleted or the server
  restarts. Adding the same login again while the server is running gives that
  account the old session back.
- An account disabled with `scripts/user.sh disable` loses its cookie at once;
  its already open consoles are closed at their next action. Disabling it from
  `/admin` closes them immediately.
