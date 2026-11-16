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

| Variable | Value behind nginx | Why |
| --- | --- | --- |
| `PORT` | `3002` (or another local port) | Port nginx forwards to. |
| `QEMUWEB_TRUST_PROXY` | `loopback` | Trust `X-Forwarded-Proto` and `X-Forwarded-For` from nginx on the same machine, so that the login cookie gets the `Secure` attribute over HTTPS. |
| `QEMUWEB_SESSION_HOURS` | `12` (default) | Login lifetime, renewed while the user is active. |
| `QEMUWEB_USERS_FILE` | optional | Users file outside the repository, e.g. `/etc/qemuweb/users.json`. |
| `QEMUWEB_LOG_DIR` | optional | Log directory outside the repository, e.g. `/var/log/qemuweb` (see [Server logs](#server-logs)). |

Example systemd unit (`/etc/systemd/system/qemuweb.service`), assuming the
repository in `/srv/qemuweb` and a `qemuweb` account in the `kvm` group:

```ini
[Unit]
Description=QemuWeb
After=network.target

[Service]
User=qemuweb
WorkingDirectory=/srv/qemuweb
Environment=PORT=3002
Environment=QEMUWEB_TRUST_PROXY=loopback
ExecStart=/usr/bin/node server.js
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

Stopping the service stops every machine of every user and empties
`runtime/sessions/`; tell users to save a session ZIP first.

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
| `session-deleted` | `sessionId`, `by` (the user, or the admin who deleted it). |
| `node-created` | `nodeId`, `kind` (`host` or `switch`). |
| `node-started`, `node-stopped`, `node-deleted` | `nodeId` (**Stop all** and the removal of every node: `all`). |
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
