# QemuWeb at the CREMI

Debian 13 (trixie), Apache2 and OpenID, on `v0-qemuweb`. The files to copy are in `deploy/cremi/`.

| File | Use |
|---|---|
| `qemuweb-maintenance.conf` | Apache site of stage 1 (maintenance page, no OpenID); also the maintenance switch |
| `qemuweb-2-oidc.conf` | Apache site of stage 2 (a page behind OpenID) |
| `qemuweb-3-app.conf` | Apache site of stage 3 (QemuWeb behind OpenID): the final site |
| `qemuweb-oidc.inc.example` | model of the OpenID secrets file (kept on the server only) |
| `qemuweb-proxykey.inc.example` | model of the file with the key shared by Apache and QemuWeb (kept on the server only) |
| `maintenance.html`, `whoami.html`, `goodbye.html` | static pages: maintenance and error page, OpenID attributes of the user, logout |
| `qemuweb-server.service`, `qemuweb-runner.service` | systemd units: server, local runner |
| `cremi-architecture.md` | the network at the CREMI: inbound relay, Apache, outbound proxy, the WebSocket settings of every stage, checks and symptoms |
| `qwctl.sh` | one command to start, stop, restart and inspect the two services (`status`, `restart`, `logs`) |

**Network.** `qemuweb.emi.u-bordeaux.fr` is an alias of the CREMI https relay (`httpsproxy`, 10.252.0.222), which forwards
to this machine, `v0-qemuweb.emi.u-bordeaux.fr` (10.252.0.117). Apache answers to `v0-qemuweb.emi.u-bordeaux.fr` (aliases
`v0-qemuweb` and `qemuweb.emi.u-bordeaux.fr`), with the CREMI wildcard certificate already on the machine
(`/etc/apache2/certs/star_emi_u-bordeaux_fr.*`). OpenID needs Apache2 (`mod_auth_openidc`); QemuWeb listens on
`127.0.0.1:3002` only.

**Plan.** Part 1 as root (`ssh qemuweb`), part 2 as `qemuweb` (`ssh qemuweb-app`, SSH agent forwarded to reach the git
mirror; `qemuweb` is a sudoer). Part 2 has three stages, each ending with one check in a browser:

1. **Stage 1**: a static maintenance page over HTTP and HTTPS, no OpenID.
2. **Stage 2**: a static page behind OpenID that shows who you are.
3. **Stage 3**: QemuWeb behind Apache.

Then the runner: **A** on this machine (local), **B** on another machine (remote). Each stage has its own site file,
installed as `/etc/apache2/sites-available/qemuweb.conf`. The `curl` commands that locate a failure are in Annex A. The
ssh aliases `qemuweb` (root) and `qemuweb-app` (user `qemuweb`, `ForwardAgent yes`) are in the workstation's
`~/.ssh/config`, both through the CREMI jump host. See also `docs/deployment.md` and `docs/remote-runner-test.md`.

## Server, part 1: root (`ssh qemuweb`)

```sh
# 0. proxy (3128); /etc/profile.d is read by the login shells of qemuweb
export http_proxy=http://proxy:3128/ https_proxy=http://proxy:3128/ no_proxy=localhost,127.0.0.1,qemuweb.emi.u-bordeaux.fr,v0-qemuweb.emi.u-bordeaux.fr
echo 'export http_proxy=http://proxy:3128/ https_proxy=http://proxy:3128/ no_proxy=localhost,127.0.0.1,qemuweb.emi.u-bordeaux.fr,v0-qemuweb.emi.u-bordeaux.fr' > /etc/profile.d/proxy.sh
# apt run by sudo keeps no proxy variable: give the proxy to apt itself
printf 'Acquire::http::Proxy "http://proxy:3128/";\nAcquire::https::Proxy "http://proxy:3128/";\n' > /etc/apt/apt.conf.d/95proxy

# 1. packages (build-essential, python3: node-pty is compiled by npm ci; apache2 and its OpenID module: the front end)
apt update && apt full-upgrade -y
apt install -y bash build-essential coreutils findutils grep gzip curl git python3 ca-certificates gnupg sudo apache2 libapache2-mod-auth-openidc
apt autoremove -y

# 2. Node.js 24 (Ubuntu's is too old)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
node --version                                    # v24.x

# 3. standard account (home /home/qemuweb, apart from the code; adduser copies /etc/skel and gives a normal UID)
adduser --disabled-password --gecos '' --home /home/qemuweb --shell /bin/bash qemuweb
# the same .bashrc (and prompt) as root's; check that it holds no secret and nothing specific to root first
install -o qemuweb -g qemuweb -m 0644 /root/.bashrc /home/qemuweb/.bashrc
# directories: code, runtime (sessions, sockets), configuration (users.json, runners.json), logs
install -d -o qemuweb -g qemuweb /srv/qemuweb
install -d -o qemuweb -g qemuweb -m 0750 /var/lib/qemuweb /etc/qemuweb /var/log/qemuweb
# ssh for qemuweb: a copy of root's (authorized_keys: same people may log in; known_hosts)
cp -a /root/.ssh /home/qemuweb/.ssh
chown -R qemuweb:qemuweb /home/qemuweb/.ssh && chmod 700 /home/qemuweb/.ssh
# qemuweb is a full sudoer, without password (its password is locked); see the security note below
echo 'qemuweb ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/qemuweb
chmod 440 /etc/sudoers.d/qemuweb && visudo -c
```

> **Security note.** `qemuweb` is root-equivalent (full `sudo`, and it accepts every key of `/root/.ssh/authorized_keys`):
> acceptable only for trusted users, until milestone 8. Then remove `/etc/sudoers.d/qemuweb` and restrict `authorized_keys`.

Apache is configured with `sudo` in part 2: run `sudo apache2ctl configtest` before every restart.

## Server, part 2: `qemuweb` (`ssh qemuweb-app`)

```sh
ssh-add -l                                        # on the server: your identity must be listed

# 4. code, from the mirror
git clone git@gitub.u-bordeaux.fr:info/qemuweb.git /srv/qemuweb
cd /srv/qemuweb && git checkout main && npm ci
git describe --tags
```

### Stage 1: static page over HTTP and HTTPS, without OpenID

```sh
# 5. before touching Apache: its version (2.4.47 or later is needed for stage 3), and who holds 80 and 443
apache2 -v | head -1                              # Server version: Apache/2.4.x
sudo ss -ltnp | grep -E ':(80|443)\s'            # nothing but apache2 (443 is empty until step 6): stop anything else first

# 6. the maintenance page and the site of stage 1
sudo a2enmod ssl rewrite                          # TLS; rewrite: the 503 of every other path
# the Debian default site answers unknown names (and the bare IP) with its "It works" page: off
sudo a2dissite 000-default
# the global name of the server (otherwise apache2ctl warns AH00558)
echo 'ServerName v0-qemuweb.emi.u-bordeaux.fr' | sudo tee /etc/apache2/conf-available/servername.conf
sudo a2enconf servername
sudo install -d /var/www/qemuweb
sudo install -m 0644 deploy/cremi/maintenance.html /var/www/qemuweb/maintenance.html
sudo install -m 0644 deploy/cremi/qemuweb-maintenance.conf /etc/apache2/sites-available/qemuweb-maintenance.conf
sudo a2ensite qemuweb-maintenance
sudo apache2ctl configtest                        # Syntax OK (restart only if it is)
sudo systemctl enable apache2 && sudo systemctl restart apache2    # restart: mod_ssl adds port 443
sudo systemctl is-active apache2                  # active
```

**Check (stage 1)**, in a browser: `https://qemuweb.emi.u-bordeaux.fr/maintenance.html` shows **QemuWeb is under
maintenance**, with the padlock; any other path shows it too (status 503). Failure: Annex A.1.

### Stage 2: the same site behind OpenID

The OpenID client is the one of the reference site. Its secrets are never in the repository: they live in
`/etc/apache2/qemuweb-oidc.inc` on this server (root, mode 0600).

```sh
# 8. the secrets file, by hand. First, on the machine that serves the reference site (v0-progsys for
#    progsys.emi.u-bordeaux.fr), as root: the file of that site that holds the client (prints no secret)
#      grep -l OIDCClientSecret /etc/apache2/sites-enabled/*
#    Open it there and keep it visible: you will copy OIDCClientID, OIDCClientSecret and OIDCCryptoPassphrase.
#    Then, on this machine: a root-only copy of the model, then replace the three CHANGE_ME in it
sudo install -m 0600 -o root -g root deploy/cremi/qemuweb-oidc.inc.example /etc/apache2/qemuweb-oidc.inc
sudoedit /etc/apache2/qemuweb-oidc.inc
sudo ls -l /etc/apache2/qemuweb-oidc.inc          # -rw------- 1 root root
sudo grep -c CHANGE_ME /etc/apache2/qemuweb-oidc.inc    # 0 (and exit status 1: nothing is left to replace)

# 9. the OpenID module, and the site of stage 2
dpkg -l libapache2-mod-auth-openidc | tail -1     # ii: installed at step 1 (if not: sudo apt install -y libapache2-mod-auth-openidc)
sudo a2enmod auth_openidc headers include         # OpenID; headers: RequestHeader (identity for the application); include: SSI of whoami.html
sudo install -m 0644 deploy/cremi/goodbye.html /var/www/qemuweb/goodbye.html
sudo install -m 0644 deploy/cremi/whoami.html /var/www/qemuweb/whoami.html
sudo install -m 0644 deploy/cremi/qemuweb-2-oidc.conf /etc/apache2/sites-available/qemuweb.conf
# the OpenID site takes the place of the maintenance site (both use the same names: never enable the two)
sudo a2dissite qemuweb-maintenance && sudo a2ensite qemuweb
sudo apache2ctl configtest                        # Syntax OK (restart only if it is)
sudo systemctl restart apache2                    # restart: a new module is loaded
sudo systemctl is-active apache2                  # active
```

**Check (stage 2)**, in a **private window** (an old cookie breaks the login): `https://qemuweb.emi.u-bordeaux.fr/whoami.html`
sends you to the CREMI login, then shows **You are signed in** (login, name, email, groups). Without the group
`cremi-active`: `403`. `sudo tail -n 5 /var/log/apache2/qemuweb-access.log` shows `user=<your login>` on the line of
`/whoami.html`. Failure: Annex A.2.

Notes:
- `whoami.html` is filled by server side includes (module `include`) from the claims `OIDC_CLAIM_<name>`. To show another
  attribute, add a row with its claim name (listed at https://services.emi.u-bordeaux.fr/intranet/mesinfos/info.php).
- The site sets `X-Remote-User` from `preferred_username`, after removing any `X-Remote-User` and `X-User-*` sent by a
  browser. It is the identity QemuWeb will trust in stage 3, together with the shared key.
- In the log, the second field is the address of the client (`X-Forwarded-For`, sent by the relay).
- Logout, to test again: `https://qemuweb.emi.u-bordeaux.fr/.openid?logout=https://qemuweb.emi.u-bordeaux.fr/goodbye`.

### Stage 3: QemuWeb behind Apache

QemuWeb trusts the identity given by Apache: no QemuWeb login at all (`--auth proxy`: the identity comes from the front end,
here Apache with `mod_auth_openidc`, through the header `X-Remote-User`). Apache adds the header `X-Proxy-Key` (a secret
shared with QemuWeb) to every request it forwards, WebSocket included; QemuWeb believes `X-Remote-User` only on a request
that carries that key. Without the key, a request has no identity (`401`); with a wrong key it is refused (`403`). A CREMI
login that is not in `users.json` is a **student**; the **administrators** are listed in `users.json` (their CREMI login,
no QemuWeb password). The SSH tunnel to port 3002 therefore no longer gives a login page: administer through the public
name, and see "Emergency: password mode" if OpenID is down. A header without the key is ignored, whatever its address.

```sh
# 10. the key shared by Apache and QemuWeb: one random value, in two root-readable places, never in the repository
KEY=$(openssl rand -hex 32)
sudo install -m 0600 -o qemuweb -g qemuweb /dev/null /etc/qemuweb/proxy-key
echo "$KEY" | sudo tee /etc/qemuweb/proxy-key > /dev/null
sudo install -m 0600 -o root -g root deploy/cremi/qemuweb-proxykey.inc.example /etc/apache2/qemuweb-proxykey.inc
sudo sed -i "s/CHANGE_ME/$KEY/" /etc/apache2/qemuweb-proxykey.inc
unset KEY
sudo ls -l /etc/qemuweb/proxy-key /etc/apache2/qemuweb-proxykey.inc   # -rw------- qemuweb qemuweb, and -rw------- root root
sudo grep -c CHANGE_ME /etc/apache2/qemuweb-proxykey.inc              # 0 (and exit status 1: nothing is left to replace)

# 11. administrators (users.json is 0600). Students need no account. LOGIN is your CREMI login (edit it): recognised as
#     administrator through OpenID, without a QemuWeb password (add one login per administrator)
LOGIN="..."                                       # your CREMI login, between the quotes
U='./scripts/user.sh --users /etc/qemuweb/users.json'
$U add "$LOGIN" --role admin --no-password
$U list

# 12. service (QemuWeb on 127.0.0.1:3002; port 3002 is never opened in the firewall)
sudo install -m 0644 deploy/cremi/qemuweb-server.service /etc/systemd/system/qemuweb-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now qemuweb-server
sudo journalctl -u qemuweb-server --since "2 min ago" --no-pager | tail -n 25    # "QemuWeb is ready." "No runner connected."

# 13. the proxy modules and the site of stage 3 (the maintenance page is already in place)
sudo a2enmod proxy proxy_http proxy_wstunnel      # reverse proxy, WebSocket (Apache 2.4.47 or later: upgrade=websocket)
sudo install -m 0644 deploy/cremi/qemuweb-3-app.conf /etc/apache2/sites-available/qemuweb.conf
sudo apache2ctl configtest                        # Syntax OK (restart only if it is)
sudo systemctl restart apache2                    # restart: new modules are loaded
sudo systemctl is-active apache2                  # active
```

**Check (stage 3)**, in a **private window**: `https://qemuweb.emi.u-bordeaux.fr/` sends you to the CREMI login, then
straight to the interface (no QemuWeb login page): the header shows your login, and **Log out** returns to the CREMI
logout page. Without a runner it says that no runner is available: expected (Runner A below), and the consoles do not
open yet. As a student (a CREMI login that is not in `users.json`) there is no Supervision link; as an administrator there is one.
The access log shows your CREMI login. Failure: Annex A.3.

Notes:
- Apache proxies to `127.0.0.1:3002` with WebSocket (`upgrade=websocket`) and a one-hour timeout, sends
  `X-Forwarded-Proto: https` (so the login cookie is `Secure`, with `--trust-proxy loopback`), accepts bodies up to 1 GiB
  (session ZIP archives) and shows `maintenance.html` on 502 and 503.
- `qemuweb-server.service` runs `--auth proxy --proxy-key-file /etc/qemuweb/proxy-key --logout-url ...`: the logout button
  goes to the OpenID logout, which ends at `/goodbye`. After a change of an account, no restart is needed.
- To disable a student, add the login with `$U add "$LOGIN" --no-password` then `$U disable "$LOGIN"`: a disabled login is
  refused through OpenID too.
- To change the key without an interruption, see "Rotate the shared key" below.
- An expired OpenID session: `/api/`, `/socket.io/` and `/auth/` have `OIDCUnAuthAction 401` in `qemuweb-3-app.conf`, so
  Apache answers them `401` instead of redirecting to the CREMI login (another origin, which the page cannot follow). The
  interface then reloads the page once (not twice within 30 seconds), and Apache sends that page request to the login.
- `/runner/connect` and `/api/runner/register` are outside OpenID (`AuthType None`): a runner has no browser and uses its
  token. The local runner dials the Unix socket of the server, not Apache.
- If the consoles freeze, or `/runner/connect` fails only through the public name: the relay must pass WebSocket
  (HTTP/1.1, `Upgrade`), 3600 s and large bodies (ask the CREMI). With Apache older than 2.4.47, replace the `ProxyPass /`
  line by `RewriteCond %{HTTP:Upgrade} websocket [NC]` and `RewriteRule ^/?(.*) ws://127.0.0.1:3002/$1 [P,L]`.

### Rotate the shared key

The key file `/etc/qemuweb/proxy-key` accepts one key, or two (one per line, either is valid; a third line, an empty line in
the middle or a key shorter than 16 characters stops the server at startup). So the key changes without any request refused.
Run on the server as `qemuweb`; the restarts of the server keep the machines of the local runner.

```sh
# 1. add the new key as a second line, and restart the server: it accepts both
NEW=$(openssl rand -hex 32)
echo "$NEW" | sudo tee -a /etc/qemuweb/proxy-key > /dev/null
sudo systemctl restart qemuweb-server        # or ./deploy/cremi/qwctl.sh restart server
# 2. give the new key to Apache, and reload it (no request is cut)
sudo sed -i "s/X-Proxy-Key \".*\"/X-Proxy-Key \"$NEW\"/" /etc/apache2/qemuweb-proxykey.inc
unset NEW
sudo apache2ctl configtest && sudo systemctl reload apache2
# 3. keep only the new key (the last line), and restart the server again
sudo sed -i '1d' /etc/qemuweb/proxy-key
sudo systemctl restart qemuweb-server
sudo wc -l /etc/qemuweb/proxy-key            # 1
```

Check afterwards with the first lines of Annex A.3 (a request with a wrong key is still refused: `403`). Step 10 creates the
first key, a file of one line.

### Switch an installed server to `--auth proxy`

For a server already running with the password login (service without `--auth`): create the key (step 10,
if `/etc/qemuweb/proxy-key` does not exist), declare the administrators (step 11), install the site and the service,
restart. Run on the server as `qemuweb`.

```sh
cd /srv/qemuweb && git pull
LOGIN="..."                                      # your CREMI login, between the quotes (repeat for each administrator)
U='./scripts/user.sh --users /etc/qemuweb/users.json'
$U add "$LOGIN" --role admin --no-password
$U list
sudo install -m 0644 deploy/cremi/qemuweb-3-app.conf /etc/apache2/sites-available/qemuweb.conf
sudo apache2ctl configtest && sudo systemctl reload apache2
sudo install -m 0644 deploy/cremi/qemuweb-server.service /etc/systemd/system/qemuweb-server.service
sudo systemctl daemon-reload && sudo systemctl restart qemuweb-server
sleep 3 && sudo journalctl -u qemuweb-server --since "1 min ago" --no-pager | tail -n 8
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3002/auth/me        # 401: no identity without the key
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Remote-User: admin' -H 'X-Proxy-Key: wrong' http://127.0.0.1:3002/auth/me   # 403
```

Then, in a private window, open `https://qemuweb.emi.u-bordeaux.fr/`: CREMI login, then the interface with your login and
the Supervision link (no QemuWeb login page). The restart keeps the machines of the local runner.

### Emergency: password mode

`--auth proxy` has no password login: `/auth/login` answers 404, there is no login page, and the SSH tunnel to port 3002
(no key) gives `401`. If OpenID is down, or to test with the tunnel, restart QemuWeb in `--auth password` mode (its own
login, the accounts of `users.json` with a password) for the time of the incident:

```sh
# on the server, as qemuweb: a drop-in replaces the authentication options (nothing is edited in the repository)
sudo systemctl edit qemuweb-server      # in the editor, write the three lines below, save, quit
#   [Service]
#   ExecStart=
#   ExecStart=/usr/bin/node server/main.js --listen 3002 --runtime /var/lib/qemuweb --users /etc/qemuweb/users.json --runners /etc/qemuweb/runners.json --logs /var/log/qemuweb --session-hours 12 --runner-grace 300 --trust-proxy loopback --auth password
cd /srv/qemuweb && ./scripts/user.sh --users /etc/qemuweb/users.json add admin --role admin    # asks a password
sudo systemctl restart qemuweb-server
# (on the workstation)  ssh -N -L 3012:127.0.0.1:3002 qemuweb-app   then http://127.0.0.1:3012 (the login page), log in as admin with that password
# back to normal: remove the drop-in and restart
sudo rm -r /etc/systemd/system/qemuweb-server.service.d && sudo systemctl daemon-reload && sudo systemctl restart qemuweb-server
```

Delete the `admin` account afterwards (`./scripts/user.sh --users /etc/qemuweb/users.json remove admin`).

### Rolling back one stage

Each stage is one site file: put the previous one back and reload.

```sh
# from stage 3 to stage 2 (QemuWeb stays installed, but is no longer reachable through Apache)
sudo install -m 0644 deploy/cremi/qemuweb-2-oidc.conf /etc/apache2/sites-available/qemuweb.conf
sudo apache2ctl configtest && sudo systemctl reload apache2

# from stage 2 to stage 1 (no more OpenID: the static maintenance page only)
sudo a2dissite qemuweb && sudo a2ensite qemuweb-maintenance
sudo apache2ctl configtest && sudo systemctl reload apache2

# out of the site altogether (the secrets file stays: delete it by hand if you give up)
sudo a2dissite qemuweb qemuweb-maintenance && sudo apache2ctl configtest && sudo systemctl reload apache2
```

Then repeat the check of that stage.

### Maintenance mode

The stage 1 site is the **maintenance switch**: every visitor gets the maintenance page (status `503`) and nothing reaches
QemuWeb.

```sh
# maintenance ON (the stage 3 site is replaced by the maintenance site)
sudo a2dissite qemuweb && sudo a2ensite qemuweb-maintenance
sudo apache2ctl configtest && sudo systemctl reload apache2

# maintenance OFF (the site of stage 3 again)
sudo a2dissite qemuweb-maintenance && sudo a2ensite qemuweb
sudo apache2ctl configtest && sudo systemctl reload apache2
```

- QemuWeb and the local runner keep running: only the web access is cut. The page reloads itself every 30 seconds.
- Remote runners get `503` too; their sessions are dropped after `--runner-grace` (300 s).
- It works without OpenID or secrets. Enable one site at a time (`a2dissite` first).

### Update later

`deploy/cremi/qwctl.sh` starts, stops, restarts and shows the two services (`qemuweb-server` and `qemuweb-runner`) in one command:
`./deploy/cremi/qwctl.sh status`, `restart server` (keeps the machines), `restart runner` or `restart` (both: stops every
machine, it asks first; `-y` skips the question), `logs [server|runner] [LINES]`. The plain commands are below.

After a release that **changes a file format** (the release notes and `docs/json-files.md` say so), the sessions of the
old format are no longer readable: save what matters first, then `git pull --tags && npm ci` and
`./deploy/cremi/qwctl.sh restart` (both services: the runner must run the new code too, since it reads the archives; an
archive rejected with `Invalid session.json in archive.` right after a pull means the runner is still the old one).
Restarting only the server never applies a change of the runner code.

```sh
# 15. a restart deletes the sessions of remote runners; the machines of the local runner survive
#     (for a long update, put the maintenance site first: see "Maintenance mode")
cd /srv/qemuweb && git pull && npm ci && sudo systemctl restart qemuweb-server
# after a change of a site file or of the secrets file
sudo apache2ctl configtest && sudo systemctl reload apache2
```

**Before copying a site file or the service file after a `git pull`**, read what changed in `deploy/cremi/`:
`git log --stat -5 -- deploy/cremi docs`. A new version of a site file may need a file that exists only on the server
(for example `qemuweb-proxykey.inc`, step 10, or `qemuweb-oidc.inc`): create it first, otherwise `apache2ctl configtest`
fails with `Could not open configuration file` (Apache keeps running with the old configuration, as long as you
do not restart it). Always run `configtest` before `reload`, and do not restart Apache until it says `Syntax OK`.

## Runner A: local, on this machine (`ssh qemuweb-app`)

Runs the machines on this machine, under `qemuweb`, and dials the server on the Unix socket
`/var/lib/qemuweb/runner-3002.sock` (same `--runtime` for both, at most 49 characters). Each host of `demo/lan.zip`
takes 1 GiB (`free -g`, `nproc`).

```sh
# 16. packages of the runner, and /dev/kvm for qemuweb
sudo apt update && sudo apt install -y qemu-system-x86 qemu-utils genisoimage vde2 rsync
qemu-system-x86_64 -netdev help | grep vde          # must list vde; else docs/install.md#qemu-without-vde-support (.env.local in /srv/qemuweb)
sudo usermod -aG kvm qemuweb
sudo -u qemuweb sh -c 'test -w /dev/kvm && echo kvm-ok'
```

**17. Base image.** Building it on this machine fails behind the CREMI proxy, so it is built on the **workstation** and
copied. On the workstation, in the repository (the second command records the SHA-256 files that `rsync` copies; `-a`
keeps the dates, `-S` keeps the file sparse):

```sh
bash scripts/prepare.sh --system debian13-legacy          # builds images/debian13-legacy.raw (nothing to do if it exists)
bash scripts/prepare.sh --hash --system debian13-legacy   # records images/debian13-legacy.raw.sha256, without building
ls -lh images/debian13-legacy.raw*
rsync -aS --progress images/debian13-legacy.raw images/debian13-legacy.raw.sha256 qemuweb-app:/srv/qemuweb/images/
```

Then, on the server:

```sh
cd /srv/qemuweb && bash scripts/prepare.sh --list         # debian13-legacy is listed, with a size and a date
```

```sh
# 18. the runner service
sudo install -m 0644 deploy/cremi/qemuweb-runner.service /etc/systemd/system/qemuweb-runner.service
sudo systemctl daemon-reload
sudo systemctl enable --now qemuweb-runner
sudo journalctl -u qemuweb-runner -n 30 --no-pager -o cat   # "Connected to the server."
sudo journalctl -u qemuweb-server -n 10 --no-pager -o cat          # the server sees its runner

# 19. in a private window: https://qemuweb.emi.u-bordeaux.fr/ (CREMI login), "Load session ZIP" demo/lan.zip, start, open a console
#     (without Apache: "Emergency: password mode" above, with the SSH tunnel)

# 20. on the server: the machines run here, under the runner's account
ps -eo pid,user,args | grep -E "[q]emu-system|[v]de_switch" | cut -c1-110
sudo journalctl -u qemuweb-runner -n 20 --no-pager -o cat
```

To stop the runner and its machines: `sudo systemctl stop qemuweb-runner` (save the sessions first). Restarting only the
server keeps the machines.

## Runner B: remote, on another machine

Dials the server through Apache with its own token (`/runner/connect` and `/api/runner/register` are outside OpenID).
The relay passes WebSocket (Annex A.3 checks it).

```sh
# 21. as root on REMOTE (proxy first if needed)
apt update
apt install -y bash build-essential coreutils findutils grep gzip curl git python3 qemu-system-x86 qemu-utils genisoimage vde2 ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
adduser --disabled-password --gecos '' runner
usermod -aG kvm runner                            # effective at next login

# 22. as runner on REMOTE
git clone git@gitub.u-bordeaux.fr:info/qemuweb.git ~/qemuweb && cd ~/qemuweb && npm ci   # needs read access to the mirror (own key or deploy key)
id -nG | grep -w kvm
qemu-system-x86_64 -netdev help | grep vde
bash scripts/prepare.sh --system alpine           # or copy images/ from another machine
# the registration route answers by itself, never with the OpenID redirection (4xx, not 302)
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' https://qemuweb.emi.u-bordeaux.fr/api/runner/register

# 23. browser: admin, /admin -> Runners, create a registration token (shown once)

# 24. register once, then run (--ca FILE only for a private authority). The runtime path: at most 49 characters
./scripts/runner.sh register --url https://qemuweb.emi.u-bordeaux.fr --token TOKEN --name salle-test \
  --runtime ~/qemuweb/runtime --runner-config ~/.config/qemuweb-runner/runner.json
./scripts/runner.sh run --runner-config ~/.config/qemuweb-runner/runner.json \
  --runtime ~/qemuweb/runtime --config ~/qemuweb/config.json --url https://qemuweb.emi.u-bordeaux.fr
# "Connected to the server." Then docs/remote-runner-test.md, steps 6 to 8.
```

Until milestone 8 (quotas, HMP allowlist, `Origin` check, logout, jail): trusted users only.

## Annex A. Diagnostic checks with `curl`

When a browser check fails, these commands locate the failing layer. On the server, `--noproxy '*'` skips the outgoing
proxy, `--resolve` sends the request to Apache here with the right name, and the certificate is checked (never `-k`). The
others run from a machine inside the CREMI (the jump host runs no command: a lab machine, or the VPN) and through the relay.

### A.1 Stage 1: certificate, Apache, network, relay

```sh
# the certificate: valid, covering the names, and its key belongs to it (the two hashes must be identical)
sudo ls -l /etc/apache2/certs/                    # the .key is readable by root only (mode 600 or 640)
sudo openssl x509 -in /etc/apache2/certs/star_emi_u-bordeaux_fr.crt -noout -subject -enddate -ext subjectAltName
sudo openssl x509 -in /etc/apache2/certs/star_emi_u-bordeaux_fr.crt -noout -pubkey | openssl sha256
sudo openssl pkey -in /etc/apache2/certs/star_emi_u-bordeaux_fr.key -pubout | openssl sha256

# Apache alone, on the server
curl --noproxy '*' -s -D - -o /dev/null --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/maintenance.html | head -1
curl --noproxy '*' -s --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/maintenance.html
# any other path: the same page, with the status 503
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/anything
# port 80: a redirection to the name of the machine
curl --noproxy '*' -s -o /dev/null -w '%{http_code} %{redirect_url}\n' --resolve v0-qemuweb.emi.u-bordeaux.fr:80:127.0.0.1 http://v0-qemuweb.emi.u-bordeaux.fr/maintenance.html

# from another machine inside the CREMI, to this machine by its name
curl -s https://v0-qemuweb.emi.u-bordeaux.fr/maintenance.html
# from a workstation, through the CREMI https relay
curl -s https://qemuweb.emi.u-bordeaux.fr/maintenance.html
```

**Expect**: `HTTP/1.1 200 OK` (or `HTTP/2 200`), the page (`QemuWeb is under maintenance`), `503`, then
`302 https://v0-qemuweb.emi.u-bordeaux.fr/maintenance.html`; the two last commands print the same page.

Server tests pass, inside-the-CREMI test fails: the firewall of the machine (443). Both pass, relay test fails (403, 502,
certificate or name): the CREMI relay. `sudo tail -n 20 /var/log/apache2/qemuweb-error.log` shows what Apache received.

### A.2 Stage 2: OpenID

```sh
# the CREMI OpenID provider must be reachable from here without the proxy (mod_auth_openidc reads its metadata at startup)
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' https://openid.emi.u-bordeaux.fr/.well-known/openid-configuration   # 200
# without a session: a redirection to the CREMI login, not the page (on the server, then from inside the CREMI)
curl --noproxy '*' -s -D - -o /dev/null --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/whoami.html | grep -iE '^(HTTP|location)'
curl -s -D - -o /dev/null https://v0-qemuweb.emi.u-bordeaux.fr/whoami.html | grep -iE '^(HTTP|location)'
```

**Expect**: `HTTP/1.1 302 Found` and a `location:` that starts with `https://openid.emi.u-bordeaux.fr/`.

`500` or no redirection: `sudo tail -n 30 /var/log/apache2/qemuweb-error.log` (a wrong secret: error of the token
endpoint; an unreachable provider: metadata error; a provider reachable only through the proxy: add
`OIDCOutgoingProxy proxy:3128`). Error about `redirect_uri`: the OpenID client must accept
`https://qemuweb.emi.u-bordeaux.fr/.openid` and `https://v0-qemuweb.emi.u-bordeaux.fr/.openid` (ask the CREMI).

### A.3 Stage 3: the application, the runners, the maintenance page

```sh
# QemuWeb alone, on its port (401: the application answers, without a session)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3002/auth/me
# a forged identity without the key is ignored: still 401 (with a wrong key: 403)
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Remote-User: admin' http://127.0.0.1:3002/auth/me
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Remote-User: admin' -H 'X-Proxy-Key: wrong' http://127.0.0.1:3002/auth/me

# an API path and a Socket.IO path without a session: 401 (OIDCUnAuthAction 401), not a 302 to the CREMI login
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/api/nodes
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 'https://v0-qemuweb.emi.u-bordeaux.fr/socket.io/?EIO=4&transport=polling'
# without a session: OpenID answers first (302), not the application (401)
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/auth/me
# a header sent by a client is not believed: still 302
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' -H 'X-Remote-User: admin' --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/auth/me
# runner registration is excluded from OpenID: QemuWeb answers itself (a 4xx, never 302)
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/api/runner/register
# runner connection, same (without the WebSocket upgrade; 401 or 404, never 302)
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/runner/connect
# the maintenance page: QemuWeb stopped, a path without OpenID gives 503 and the page of maintenance.html
sudo systemctl stop qemuweb-server
curl --noproxy '*' -s -w '\n%{http_code}\n' --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/runner/connect | grep -E 'under maintenance|^50'
sudo systemctl start qemuweb-server

# from another machine inside the CREMI
curl -s -o /dev/null -w '%{http_code}\n' https://v0-qemuweb.emi.u-bordeaux.fr/auth/me

# through the public relay (httpsproxy), from any machine: a WebSocket upgrade must reach the runner gateway (401, Content-Length: 0)
curl -sS -i --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" https://qemuweb.emi.u-bordeaux.fr/runner/connect | head -8
```

**Expect**: `401`, `401`, `403`, then `401`, `401` (API and Socket.IO paths), `302`, `302`, a `4xx` (the application's answer, not `302`), `401` or `404` (not `302`), then
`under maintenance` (the page) and `503`; the `/auth/me` from another machine prints `302`; the relay check (last command) is described below. In the journal, `users.log` (`/var/log/qemuweb/users.log`) shows the refused key as a
`proxy-refused` line, and the logins of the browser as `"via":"proxy"`.

If a runner path answers `302`, the `AuthType None` block of that path does not apply: check `qemuweb-3-app.conf`.

The relay check must print `HTTP/1.1 401` with `Content-Length: 0` and no `X-Powered-By`: the upgrade request reached the runner
gateway, which refuses it with an empty body. A `401` with `X-Powered-By: Express` and a JSON body
`{"error":"Authentication required."}` means the relay dropped the `Upgrade` header (an ordinary request reached Express); a `101` or
any other status is not right either. (In `--auth password` mode, the emergency mode, a dropped `Upgrade` gives a `302` to
`/login.html` again.) To fix it, its `location` needs `proxy_http_version 1.1`, `Upgrade $http_upgrade`, `Connection $connection_upgrade`
(with the `map` in its `http` section), `client_max_body_size 1g`, `proxy_request_buffering off`, `proxy_buffering off`,
`proxy_read_timeout 3600s`, `proxy_send_timeout 3600s` and `X-Forwarded-For $proxy_add_x_forwarded_for`. Once it works,
the Connections panel of `/admin` shows the transport of every browser (`websocket`, not `polling`).
