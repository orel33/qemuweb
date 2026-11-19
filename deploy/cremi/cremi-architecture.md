# QemuWeb at the CREMI: network architecture

How a browser, a runner and the machines of the CREMI reach QemuWeb, which equipment sits on each path, and the
settings each one needs, WebSocket above all. The installation steps are in [deploy-cremi.md](deploy-cremi.md); the
generic reference is [docs/deployment.md](../../docs/deployment.md).

## Overview

```text
 browser (students, admin)                    runner on another machine (token)
        |  HTTPS                                      |  HTTPS + WebSocket /runner/connect
        v                                             v
  qemuweb.emi.u-bordeaux.fr  = alias of the inbound relay "httpsproxy"  (nginx, 10.252.0.222)
        |  HTTPS, HTTP/1.1, Upgrade, X-Forwarded-For
        v
  v0-qemuweb.emi.u-bordeaux.fr  (10.252.0.117, the QemuWeb machine)
   Apache2: TLS (CREMI wildcard certificate), OpenID (mod_auth_openidc), X-Remote-User + X-Proxy-Key
        |  HTTP and WebSocket on 127.0.0.1:3002
        v
   qemuweb-server  --auth proxy        <--- Unix socket, no network --->        qemuweb-runner (local)
                                                                                 QEMU, VDE

  v0-qemuweb  --->  outbound proxy "proxy" (squid, http://proxy:3128/)  --->  Internet (apt, npm, ISO, images)
```

| Equipment | Name and address | Role | Who maintains it |
| --- | --- | --- | --- |
| Inbound relay | `httpsproxy` (nginx), `10.252.0.222` and `2001:660:6101:800:252::222`; `qemuweb.emi.u-bordeaux.fr` is an alias | Public HTTPS entrance of every CREMI web service; forwards to the right machine | CREMI administrators |
| QemuWeb machine | `v0-qemuweb.emi.u-bordeaux.fr`, `10.252.0.117` | Apache, QemuWeb server, local runner | the QemuWeb administrator (root on the machine) |
| OpenID provider | the CREMI one (client `CREMIOIDC_SERVICES`) | Signs users in; group `cremi-active` required | CREMI administrators |
| Outbound proxy | `proxy.emi.u-bordeaux.fr`, `http://proxy:3128/` (squid), `10.0.220.42` and `2001:660:6101:800:220::42` | The only way out to the Internet from the CREMI machines | CREMI administrators |

The relay and the proxies belong to the CREMI: what QemuWeb needs from them is listed below and in "What to ask the CREMI".

## Inbound path: browser to QemuWeb

1. The browser opens `https://qemuweb.emi.u-bordeaux.fr/`. The relay presents its own certificate and forwards the request
   over HTTPS to `v0-qemuweb` (the relay's `proxy_pass`), keeping the public name in `Host`.
2. Apache answers with the CREMI wildcard certificate (`/etc/apache2/certs/star_emi_u-bordeaux_fr.*`, which ends on
   2 December 2026: reload Apache after the renewal). It redirects an unauthenticated visitor to the OpenID login.
3. After the login, Apache removes any `X-Remote-User` and `X-User-*` sent by the browser, sets `X-Remote-User` to the
   login and `X-Proxy-Key` to the secret shared with QemuWeb, and forwards to `127.0.0.1:3002` (HTTP and WebSocket).
   It also sends `X-Forwarded-Proto: https`.
4. QemuWeb (`--auth proxy --trust-proxy loopback`) trusts `X-Remote-User` only on a request that carries the key. Its
   address for the client comes from `X-Forwarded-For`, which the relay now sends.

Two paths skip OpenID, because a runner has no browser: `/runner/connect` (WebSocket) and `/api/runner/register`. They
use the runner's own token, and Apache gives them `AuthType None`.

## Outbound path: the machine to the Internet

Everything that leaves `v0-qemuweb` goes through the squid proxy `http://proxy:3128/`: `apt`, `npm`, `curl`, and the downloads
of `scripts/prepare.sh`.

- `/etc/apt/apt.conf.d/95proxy` and `/etc/profile.d/proxy.sh` carry it (`http_proxy`, `https_proxy`, and `no_proxy` for the
  CREMI names), see step 0 of the tutorial.
- `prepare.sh` reads `https_proxy` and `http_proxy`, or `--proxy URL`, and gives it to the build VM (Debian installer or
  cloud-init), which cannot see the environment. The short name `proxy` is resolved on the host and the VM receives the address.
- The build VM goes out over IPv4. The proxy first accepted only the IPv6 address of the machine (`403 ERR_ACCESS_DENIED`
  over IPv4): `prepare.sh -6` was the workaround. **The IPv4 of `v0-qemuweb` is authorised since 19 November 2026**, so
  it is no longer needed on this machine.
- Debian's ISO host `cdimage.debian.org` has been answered `503` by the proxy; place the ISO and its `SHA512SUMS` in
  `sources/debian13-legacy/` by hand when it happens (see the roadmap, PRP01).

## WebSocket: what every stage must do

WebSocket carries the consoles of the machines (Socket.IO on `/socket.io/`) and the connection of a remote runner
(`/runner/connect`). It needs the `Upgrade` header end to end, HTTP/1.1, and timeouts longer than the default.

| Stage | Setting |
| --- | --- |
| Inbound relay (nginx, in the `location` of the site) | `proxy_http_version 1.1;` `proxy_set_header Upgrade $http_upgrade;` `proxy_set_header Connection $connection_upgrade;` `proxy_read_timeout 3600s;` `proxy_send_timeout 3600s;` `proxy_buffering off;` `proxy_request_buffering off;` `client_max_body_size 1g;` `proxy_set_header Host $host;` `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`; and, once in the `http` section, the `map` below |
| Apache (`qemuweb-3-app.conf`) | `ProxyPass / http://127.0.0.1:3002/ upgrade=websocket timeout=3600` (Apache 2.4.47 or later, modules `proxy`, `proxy_http`, `proxy_wstunnel`), `ProxyTimeout 3600`, `LimitRequestBody 1073741824` |
| QemuWeb | `--trust-proxy loopback` (only Apache talks to it) |

The relay's configuration, as the CREMI applies it for this site:

```nginx
# once, in the http section: "upgrade" for a WebSocket request, "close" for an ordinary one
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

location / {
  proxy_pass "https://v0-qemuweb.emi.u-bordeaux.fr";
  proxy_set_header Host $host;                                   # keep the public name
  proxy_set_header X-Real-IP $remote_addr;                       # the client's address
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # same, in the form QemuWeb reads
  proxy_http_version 1.1;                                        # required for WebSocket
  proxy_set_header Upgrade $http_upgrade;                        # forward the WebSocket request
  proxy_set_header Connection $connection_upgrade;               # "upgrade" or "close"
  client_max_body_size 1g;                                       # a session ZIP upload (nginx defaults to 1 MB: 413)
  proxy_request_buffering off;                                   # the upload goes through without a temporary file
  proxy_buffering off;                                           # same for downloads (session export)
  proxy_read_timeout 3600s;                                      # a long operation or an idle console is not cut
  proxy_send_timeout 3600s;
}
```

The `map` is needed because `$connection_upgrade` is a variable it defines: without it nginx refuses the configuration.
Writing `Connection "upgrade"` instead would work for WebSocket but would ask every request to switch protocol.

### Checks

```sh
# From any machine, through the public name: a WebSocket request must reach QemuWeb.
# 401 (Server: nginx, no X-Powered-By) = the relay forwards Upgrade. 302 to /login.html = it drops it.
curl -sS -i --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" https://qemuweb.emi.u-bordeaux.fr/runner/connect | head -4

# On v0-qemuweb, directly to Apache (bypasses the relay): 401 too means Apache and the application are right.
curl -sS -i --http1.1 --noproxy '*' -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 \
  https://v0-qemuweb.emi.u-bordeaux.fr/runner/connect | head -4

# The relay's body size limit: a 5 MB body must not answer 413 from nginx
head -c 5000000 /dev/zero > /tmp/five-mb.bin
curl -sS -o /dev/null -D - -X POST --data-binary @/tmp/five-mb.bin https://qemuweb.emi.u-bordeaux.fr/runner/connect | head -3
rm /tmp/five-mb.bin

# On v0-qemuweb: Socket.IO connections that really upgraded show "upgrade=websocket" and status 101
sudo grep "transport=websocket" /var/log/apache2/qemuweb-access.log | tail -3
```

The `/admin` page, tab Connections and the **Test WebSocket** button, tells whether each browser uses a real WebSocket or
the polling fallback, and measures the round trip.

## Remote runners and lab workstations

A runner on another machine dials **out** to `https://qemuweb.emi.u-bordeaux.fr/runner/connect` with its token: it needs
no inbound port, only HTTPS to the public name (through the CREMI network, or the outbound proxy from outside it if
the runner's machine uses one). The relay and Apache pass the WebSocket as above. The local runner never uses the
network: it talks to the server on a Unix socket under `/var/lib/qemuweb`.

## Symptoms and causes

| Symptom | Likely cause |
| --- | --- |
| A WebSocket request through the public name answers `302` to `/login.html` | The relay drops `Upgrade` (HTTP/1.0 or the headers missing) |
| `413 Request Entity Too Large` from nginx on a session upload | `client_max_body_size` of the relay is below the file size |
| The consoles freeze after some minutes, or the runner reconnects often | A timeout on the path shorter than 3600 s (relay or Apache) |
| The page works but `/admin` shows connections on `polling` | A stage forwards HTTP but not the `Upgrade` of the WebSocket |
| `502` or the maintenance page | `qemuweb-server` is stopped, or Apache is in maintenance mode |
| The address of the client is `-` in the Apache log | The relay sends no `X-Forwarded-For` |
| `403 ERR_ACCESS_DENIED` from `proxy` during `prepare.sh` | The proxy refuses this address family: `-6`, or ask for the address to be authorised |
| `apt` or `curl` hangs on the machine | No proxy configured for that tool (step 0 of the tutorial) |

## What to ask the CREMI

- On the inbound relay, for `qemuweb.emi.u-bordeaux.fr`: the `location` above (HTTP/1.1, `Upgrade`, timeouts of 3600 s, no
  buffering, 1 GB bodies, `X-Forwarded-For`) and the `map` in its `http` section. Done on 19 November 2026.
- On the outbound proxy: the IPv4 and IPv6 addresses of `v0-qemuweb` authorised, and access to the Debian mirrors
  (`deb.debian.org`, `security.debian.org`, `cdimage.debian.org`), to the NodeSource repository and to the npm registry.
- The OpenID client for the site, with the group `cremi-active`; the renewal of the wildcard certificate each year.
