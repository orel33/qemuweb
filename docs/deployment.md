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
- Deleting another user's session from an administration page comes with
  milestone 4; until then only the user can delete their own session.
