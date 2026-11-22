# Deployment behind nginx

QemuWeb always listens on `127.0.0.1`. To open it to students, put a reverse
proxy in front of it that terminates TLS and forwards HTTP and WebSocket
traffic. This page uses nginx; any proxy with the same features works.

Until per-user quotas, QEMU monitor restrictions, cross-site request checks and
the runner jail exist (milestone 8 of the roadmap), give accounts only to
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
| `--runtime` | recommended | State directory of the server (pid record, `bindings.json`, `local-runner.token`) on a persistent disk, e.g. `/var/lib/qemuweb/server`; the runner has its own (`/var/lib/qemuweb/runner`), never the same one. No length limit. Without it the default is the private `/tmp/qw-<login>/<port>`, emptied by a reboot (see [the reference](reference.md#runtime-directory)). |

## The runner process

The server does not run the machines itself: a **runner** (`runner/main.js`)
does. A runner always dials the server, over the WebSocket `/runner/connect`, with a token.
The local runner (`--local-runner` on the server, `runner.sh --port PORT` on the runner) reads the token the server wrote in
`<server runtime>/local-runner.token` (mode 0600, in a directory only the account can enter; read again at every connection
attempt, so nobody types it and it is on no command line). The server never reaches out to a runner, and the web interface only
manages runners (the **Runners** section of `/admin`). A second connection of one runner is refused (409). Runners on other machines connect over
the network with their own token: see [Remote runners](#remote-runners). A **lost token file** is recreated by the next
server start (the runner waits for it and reconnects); to **rotate** it, remove the file and restart the server; a runner
whose token the server refuses (revoked in `/admin`, or forgotten) exits with status 78 and a restart never un-revokes it.

There is one way to start it, in every environment:

- **`./scripts/start.sh`** (what `npm start`, `scripts/demo.sh` and the integration tests
  use) starts `./scripts/server.sh --listen PORT --runtime DIR --local-runner` and, once the server listens, `./scripts/runner.sh
  --port PORT --token-file DIR/local-runner.token --runtime RDIR --exit-on-disconnect`, each in its own process group, with output lines prefixed `[server]`
  and `[runner]`. `--runtime DIR` is the **server** directory (default `/tmp/qw-<login>/<port>`), `--runner-runtime RDIR` the
  **runner** one (default `/tmp/qw-<login>/l-<port>`); both are printed at start, and a `--runtime` given alone says where the runner keeps its sessions. Ctrl+C or SIGTERM stops the runner first (it stops every machine), kills what
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
  warns at startup and QEMU hosts cannot start. `tcpdump` is a dependency of the
  runner's machine like the other tools (`TCPDUMP` in `.env`, checked at startup, also searched in
  `/usr/sbin` and `/sbin`): the live view of the Capture dialog runs it there. A missing one is
  only a warning line ("the live view of captures is unavailable") and the dialog says so. The PCAP
  files of a capture are written by QEMU itself and need nothing else.
- **Startup failure:** a missing common tool or no engine at all stops the
  runner with its message (`scripts/start.sh` then ends). A server that is not up yet is no failure: the runner
  waits and retries.
- **Configuration warnings:** the runner prints one line per warning about
  `config.json` on this machine, marked with a warning icon (a system whose base
  image is missing, with the `prepare.sh` command to run; default memory or
  processors larger than the machine); without warnings, a check mark and the
  number of systems. They are also announced to the server and shown in the
  **Runners** section of `/admin`.
- **Start-time memory warning:** when a host starts and the hosts running on
  that runner (every session) would reserve more than 90 % of the machine's
  RAM, a `# Warning:` line is added to the host's Log. The host still starts.
- **Server restart with a separate runner (RUN03e):** the runner keeps its machines. At start the server reads its own
  `bindings.json` (`<runtime>/bindings.json`, mode 0600, written by the server when it opens a session; the owner
  a runner announces in its `hello` is ignored) and **restores** each binding as a session that is **offline**, for its owner:
  the user logs in again (cookies do not survive a restart) and gets "The runner of your session is offline; it comes back or
  your session is dropped after N seconds." (503), never a new empty session on another runner. When the runner reconnects (2 s
  doubling to 30 s) and its `hello` lists the session, it is **adopted**: same session, machines and consoles,
  recorded as `session-adopted` in `users.log`. This holds for every runner, local or remote. The grace period
  (`--runner-grace`) counts **from the start of the server** for restored sessions: if the runner has not come back
  by then the session is dropped (`session-deleted`, reason `runner offline too long`) and the runner, when it returns, is told to
  delete it. A session the server does not know (no binding: a lost `bindings.json`, a session that was dropped, one bound to another runner)
  is deleted on the runner; a binding whose runner is forgotten or revoked, or with `--runner-grace 0`, is dropped at once
  (`runner lost`). The server never removes a file of a runner: it only sends `session.delete`.
  To test it by hand, use two terminals, not `start.sh` (which stops the runner with the server and passes `--runner-grace 0`):
  ```bash
  ./scripts/server.sh --listen 3003 --local-runner --runner-grace 300     # terminal 1 (add your --users, --logs ...)
  ./scripts/runner.sh --port 3003                                          # terminal 2, no --exit-on-disconnect
  ```
  The server prints its directory (`/tmp/qw-<login>/3003`, with `local-runner.token`), the runner finds that token file by default and keeps
  its own directory `/tmp/qw-<login>/l-3003` (with `--runtime DIR` on the server add `--token-file DIR/local-runner.token` to the runner).
  Log in, start a machine, then press Ctrl+C in terminal 1 **only** and start the same command again. The first request of the
  user answers the offline message above (the page says "Runner offline, reconnecting…"), `/admin`, Runners, shows the seconds left, and after the
  runner's retry ("Runner local (local) connected" in the server log) the session, its machines and consoles are back and
  `logs/users.log` has a `session-adopted` line.
- **Forced loss:** an administrator who knows that a runner will not come back uses **Drop sessions** in `/admin`, Runners
  (`POST /api/admin/runners/<id>/drop-sessions`, only for an offline or revoked runner, with a confirmation): its sessions are dropped at once, without
  waiting for the grace period (`session-deleted`, reason `runner lost`; `admin.log` names the runner and the number of sessions). **Revoke** drops them at once too.
  The user of an offline session cannot delete it himself (the runner does the deleting): he waits for the runner, for the end of the grace period or for the administrator.
- **Files of the runner:** the server touches no file of any runner. Each runner owns its runtime directory: it creates
  the `users/<login>` aliases (at `session.create`, removed with the session), takes `runner.pid` (a second runner on
  the same directory refuses to start), and at its own start removes the empty `sessions/<id>` directories and the
  dangling aliases that an earlier runner left; a non-empty directory stays (it is reported in the runner's log).
  A runner killed by SIGKILL therefore leaves its directories until the next runner on that directory starts
  (`./scripts/cleanall.sh` removes them). By default the local runner's directory is `/tmp/qw-<login>/l-<port>` and a remote
  runner's `/tmp/qw-<login>/r-<6 hex digits of its id>`: the aliases are there, not in the server's directory (`/tmp/qw-<login>/<port>`, which
  holds only `server-<port>.pid`, `bindings.json` and `local-runner.token`). An old `/tmp/qw-<login>/<port>` with `sessions/` or `users/` is not used by the
  runner any more: delete it by hand.
- **Runner crash:** the server keeps running; the sessions that ran on the
  runner are closed (their machines are gone; users' pages reload into a new,
  empty session once the grace period ends, recorded as `session-deleted` with the reason `runner offline too long` (`runner lost`
  when its next `hello` no longer lists them, or with `--runner-grace 0`) in `users.log`). Nothing restarts the runner by itself: under `scripts/start.sh`
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
# /etc/systemd/system/qemuweb-server.service
[Unit]
Description=QemuWeb
After=network.target

[Service]
User=qemuweb
WorkingDirectory=/srv/qemuweb
ExecStart=/usr/bin/node server/main.js --listen 3002 --local-runner --runtime /var/lib/qemuweb/server --users /etc/qemuweb/users.json --logs /var/log/qemuweb --trust-proxy loopback
KillSignal=SIGTERM
TimeoutStopSec=30
Restart=on-failure

[Install]
WantedBy=multi-user.target

# ~qemuweb/.config/systemd/user/qemuweb-runner.service (systemd --user, loginctl enable-linger qemuweb)
[Unit]
After=qemuweb-server.service

[Service]
WorkingDirectory=/srv/qemuweb
ExecStart=/srv/qemuweb/scripts/runner.sh --port 3002 --token-file /var/lib/qemuweb/server/local-runner.token --runtime /var/lib/qemuweb/runner
KillMode=mixed
Restart=on-failure
RestartPreventExitStatus=78
```

The server is started with `--local-runner`; it creates the token file `local-runner.token` in its `--runtime` (here `/var/lib/qemuweb/server`,
state kept apart from the code, no length limit; the default is `/tmp/qw-<login>/3002`, lost at a reboot) and the runner gets its path with `--token-file`,
with its own `--runtime` directory. Both directories must exist and belong to the `qemuweb` account. `RestartPreventExitStatus=78`
keeps systemd from restarting a runner that the server refused (revoked). Restarts
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

> **Remote runners are for trusted machines.** Until milestone 8 (jail, quotas, HMP allowlist) a runner
> runs the machines under the account that starts it with no confinement, and the server relies on
> its answers. Never use a machine you do not control, and never root. A runner per student is a later idea.

**What a runner machine needs**: QEMU with VDE support (`qemu-system-x86_64 -netdev help` lists `vde`), `vde2`, `qemu-img`, `genisoimage`,
Node.js, the base images of the systems it runs (copied or built with `scripts/prepare.sh`), and **access to `/dev/kvm` for the account that
runs it** (`sudo usermod -aG kvm <account>`, then log in again; a unit needs `SupplementaryGroups=kvm`). Without it the runner connects and
VirtualBox hosts work, but QEMU hosts are disabled with a warning (diagnosis: [install.md](install.md#qemu-hosts-disabled-devkvm-missing-or-not-accessible)).

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
3. `--runner-grace SECONDS` (default 300) is how long the sessions of a runner (any runner, the local one included) that lost
   its connection, or that the server restored at its start, are kept offline; `0` drops them at once. `./scripts/start.sh` and `demo.sh` pass `--runner-grace 0` unless
   it is given, because the runner ends with the server there.

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
`<runtime>/sessions/` of the machine (`--runtime`, default `/tmp/qw-<login>/r-<6 hex digits of the runner ID>`: one directory per runner, lost at a reboot of the machine).

- **TLS:** use an `https://` URL. A server certificate signed by a private authority needs
  `--ca FILE` (the PEM file; `register` keeps it in `runner.json`), or `NODE_EXTRA_CA_CERTS=file` in the environment.
- **Unencrypted URLs:** `http://` and `ws://` are accepted only for this machine (loopback), for tests. Another host needs
  `--insecure`, which prints a warning: the token and all console traffic are then readable on the network.
- **Firewall:** nothing to open on the runner; it needs outbound access to the server's HTTPS port.
- **Network cut:** no machine stops. The runner reconnects after 2 s, then 4, 8, 16 and 30 s; the server keeps its
  sessions during `--runner-grace` and then drops them (and tells the runner to delete them if it returns). After a
  restart of the server, the sessions of `bindings.json` that the runner still reports are adopted when it reconnects.
- **Revocation:** after **Revoke** in `/admin` the server refuses the token (401): the runner stops its machines and exits
  with status 78 instead of retrying. Register it again to bring it back.

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
# A revoked runner exits with status 78 and must not loop: remove the unit, or register it again.
RestartPreventExitStatus=78
# Private certificate authority: Environment=NODE_EXTRA_CA_CERTS=%h/ca.pem

[Install]
WantedBy=default.target
```

### Administration

**Runners** in `/admin` lists the local runner and every registered one: state (online, offline since, paused, revoked),
last seen, remote address, engines, CPU and memory, systems, warnings, sessions and limit. It creates registration
tokens (the command is shown once), **pauses** a runner (drain: no new session, the running ones continue),
**revokes** it (its sessions are dropped at once), **drops the sessions** of an offline runner without waiting for the grace period (confirmation asked), shows the seconds left before an offline runner's sessions are dropped, and removes an offline revoked one. The same actions apply to every row, the local runner included.
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
| `session-adopted` | `sessionId`. The server restarted, restored the session offline from `bindings.json`, and the runner that kept its machines reconnected: the session is bound to it again. |
| `session-deleted` | `sessionId`, `by` (the user, or the admin who deleted it; `null` when the session was dropped), and `reason` when it was dropped: `runner lost` (its runner died) or `creation failed`. |
| `node-created` | `nodeId`, `kind` (`host` or `switch`). |
| `node-started`, `node-stopped`, `node-deleted` | `nodeId` (**Resume all**, **Stop all** and the removal of every node: `all`). |
| `archive-loaded`, `archive-saved` | `kind`: `session` (ZIP) or `topology`; `example`: the file name when it was loaded from the server's examples. |

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

### WebSocket check

The interface opens its Socket.IO connections over WebSocket and falls back to
HTTP long polling only when the upgrade fails. If the reverse proxy drops the
`Upgrade` header (this happened behind a relay that did not forward it),
everything still works, only slower, so nobody notices. Three places tell:

- the **Connections** panel of `/admin` lists every live connection with its
  transport and warns when one is on **polling**;
- the **Test WebSocket** button of the same panel opens a connection from your
  browser forced to WebSocket (namespace `/ws-test`, administrators only) and
  shows the round trip time, or the reason of the failure; after a failure it
  tries polling and says whether the interface runs in fallback mode;
- the server output (stderr, so `journalctl -u qemuweb-server` shows it) gets one line
  when a connection is still on polling 20 seconds after it connected, at most
  once per login every 10 minutes:
  `[sockets] alice: still on polling 20 s after connecting (no WebSocket upgrade: check that the reverse proxy forwards Upgrade and Connection)`.

If the test fails, check that the proxy forwards `Upgrade` and `Connection` (the
two `proxy_set_header` lines above, or `ProxyPass ... upgrade=websocket` and
`RewriteRule` for `ws://` in Apache), and that no intermediate relay strips
them. The browser's Network tab shows a `101 Switching Protocols` for
`/socket.io/` when it works.

## Other single sign-on systems

`--auth proxy` is not tied to OpenID: the front end does the login, and QemuWeb only reads `X-Remote-User`,
guarded by `X-Proxy-Key` (see `deploy/cremi/deploy-cremi.md` for the Apache and OpenID example). QemuWeb needs no change
for another system; only `--logout-url` differs: the logout address of the front end.

| System | Front end | `--logout-url` |
| --- | --- | --- |
| OpenID | Apache `mod_auth_openidc` | `https://HOST/.openid?logout=https://HOST/goodbye` |
| SAML | Apache `mod_shib` | the Shibboleth logout handler (`/Shibboleth.sso/Logout`) |
| CAS | Apache `mod_auth_cas` | the logout URL of the CAS server |
| OpenID, OAuth2 and similar | `oauth2-proxy` with nginx | `/oauth2/sign_out` |

The front end must remove any `X-Remote-User` sent by a browser and add `X-Proxy-Key` to every request it forwards,
WebSocket upgrades included. It must also answer an API call (`/api/`), a Socket.IO connection (`/socket.io/`) and `/auth/` without a session with a plain `401`,
not with a redirection to its login (with `mod_auth_openidc`: `OIDCUnAuthAction 401` in those `<Location>`s, see `deploy/cremi/qemuweb-site-app.conf`): the page then reloads once
and a page request goes to the login of the front end. The key file may hold two keys (one per line) so that the key can change without an interruption.

## Known limits

- Cross-site request checks (`Origin`/CSRF) and a revocable logout come with
  milestone 8; until then, keep QemuWeb on its own domain name (see above).
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
