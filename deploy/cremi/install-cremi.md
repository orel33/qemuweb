# QemuWeb on qemuweb.emi.u-bordeaux.fr (CREMI), behind Apache2 and OpenID

Debian or Ubuntu (TODO: confirm with `cat /etc/os-release`). Files to copy are in this directory
(`deploy/cremi/`):

| File | Use |
|---|---|
| `qemuweb-1-hello.conf` | Apache site, stage 1: static page, HTTP and HTTPS |
| `qemuweb-2-oidc.conf` | Apache site, stage 2: the static page behind OpenID |
| `qemuweb-3-app.conf` | Apache site, stage 3: QemuWeb behind Apache and OpenID (final site) |
| `qemuweb-oidc.inc.example` | model of the file that holds the OpenID secrets (kept on the server only) |
| `hello.html`, `attente.html`, `au-revoir.html` | static pages: test page, waiting page, logout page |
| `qemuweb.service`, `qemuweb-runner.service` | systemd units (server, local runner) |

**Network.** `qemuweb.emi.u-bordeaux.fr` is an alias of the CREMI https relay `httpsproxy.emi.u-bordeaux.fr`
(10.252.0.222), which forwards internally to this machine, `v0-qemuweb.emi.u-bordeaux.fr` (10.252.0.117), exactly as
`progsys.emi.u-bordeaux.fr` is forwarded to `v0-progsys`. The Apache site therefore answers to the `ServerName`
`v0-qemuweb.emi.u-bordeaux.fr` (aliases `v0-qemuweb` and `qemuweb.emi.u-bordeaux.fr`). The TLS certificate is the CREMI
wildcard, already on the machine: `/etc/apache2/certs/star_emi_u-bordeaux_fr.crt` and `.key`. The CREMI supports
OpenID only with Apache2 (`mod_auth_openidc`), so Apache2 is the front end; QemuWeb listens on `127.0.0.1:3002` only.

**Plan.** The server is installed in two parts: part 1 as root (`ssh qemuweb`), part 2 as `qemuweb` (`ssh qemuweb-app`,
which forwards your SSH agent to reach the git mirror; `qemuweb` is a sudoer). Part 2 goes in **three stages**, each
tested alone, so that a failure points at one layer only:

1. **Stage 1**: a static "hello" page over HTTP and HTTPS, without OpenID. Proves the https relay, the names, the
   certificate and Apache.
2. **Stage 2**: the same page behind OpenID. Proves `mod_auth_openidc`, the client secrets and the identity header.
3. **Stage 3**: QemuWeb itself behind Apache (WebSocket, large uploads, waiting page, runners excluded from OpenID).

Then the runner that runs the machines: **A** on this same machine (local runner), **B** on another machine (remote
runner). The two aliases are in the workstation's `~/.ssh/config`: `qemuweb` (root) and `qemuweb-app` (user
`qemuweb`, `ForwardAgent yes`), both through the CREMI jump host (`cremi` below). The server runs as `qemuweb`, never
root. See `docs/deployment.md` and `docs/remote-runner-test.md` (variant B).

**One site file per stage.** Each stage has its own complete site file, installed over the same
`/etc/apache2/sites-available/qemuweb.conf`. Each file is usable as is, and going back one stage is one `install`
of the previous file (see "Rolling back one stage"). This is easier to follow than editing one file three times.

## Server, part 1: root (`ssh qemuweb`)

```sh
# prompt: standard Debian (user@host:dir#), now and at every login
PS1='${debian_chroot:+($debian_chroot)}\u@\h:\w\$ '
echo "PS1='\${debian_chroot:+(\$debian_chroot)}\\u@\\h:\\w\\\$ '" >> ~/.bashrc

# 0. proxy (3128); /etc/profile.d is read by the login shells of qemuweb
export http_proxy=http://proxy:3128/ https_proxy=http://proxy:3128/ no_proxy=localhost,127.0.0.1,qemuweb.emi.u-bordeaux.fr,v0-qemuweb.emi.u-bordeaux.fr
echo 'export http_proxy=http://proxy:3128/ https_proxy=http://proxy:3128/ no_proxy=localhost,127.0.0.1,qemuweb.emi.u-bordeaux.fr,v0-qemuweb.emi.u-bordeaux.fr' > /etc/profile.d/proxy.sh

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

> **Security note.** `qemuweb` is root-equivalent: it runs the web server that serves the students, and it
> accepts every key of `/root/.ssh/authorized_keys`. Anyone who takes over the server process, or steals one
> of those keys, owns the machine. This is acceptable only because the application is open to trusted users
> until milestone 6 (no quotas, no HMP allowlist, no `Origin` check, no jail). Before opening it wider, remove
> `/etc/sudoers.d/qemuweb` (or restrict it to `systemctl restart qemuweb`) and keep `authorized_keys` to the
> administrators.

Apache itself is started and configured by `sudo` in part 2: it runs as root only to bind 80 and 443 and read the
certificate key, then serves as `www-data`. Run `sudo apache2ctl configtest` before every reload or restart.

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
# 5. before touching Apache: Apache version, who holds 80 and 443 (apache2 is expected), certificate
apache2 -v | head -1                              # Server version: Apache/2.4.x (x >= 47 for stage 3)
sudo ss -ltnp | grep -E ':(80|443)\s'            # anything but apache2: stop it first (443 is empty until step 6)
sudo ls -l /etc/apache2/certs/                    # the .key is readable by root only (mode 600 or 640)
sudo openssl x509 -in /etc/apache2/certs/star_emi_u-bordeaux_fr.crt -noout -subject -enddate -ext subjectAltName
# these two hashes must be identical (the key belongs to the certificate)
sudo openssl x509 -in /etc/apache2/certs/star_emi_u-bordeaux_fr.crt -noout -pubkey | openssl sha256
sudo openssl pkey -in /etc/apache2/certs/star_emi_u-bordeaux_fr.key -pubout | openssl sha256

# 6. the static page and the site of stage 1
sudo a2enmod ssl                                  # TLS
# the Debian default site answers unknown names (and the bare IP) with its "It works" page: off
sudo a2dissite 000-default
sudo install -d /var/www/qemuweb
sudo install -m 0644 deploy/cremi/hello.html /var/www/qemuweb/hello.html
sudo install -m 0644 deploy/cremi/qemuweb-1-hello.conf /etc/apache2/sites-available/qemuweb.conf
sudo a2ensite qemuweb
sudo apache2ctl configtest                        # Syntax OK
sudo systemctl enable apache2 && sudo systemctl restart apache2    # restart: mod_ssl adds port 443
sudo systemctl status apache2 --no-pager | head -5

# 7a. on the server, Apache alone (-k is not used: this also checks the certificate)
curl --noproxy '*' -s -D - -o /dev/null --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/hello.html | head -1
curl --noproxy '*' -s --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/hello.html
curl --noproxy '*' -s -o /dev/null -w '%{http_code} %{redirect_url}\n' --resolve v0-qemuweb.emi.u-bordeaux.fr:80:127.0.0.1 http://v0-qemuweb.emi.u-bordeaux.fr/hello.html

# 7b. from the CREMI jump host, to this machine by its name (on the workstation)
#     ssh cremi 'curl -s https://v0-qemuweb.emi.u-bordeaux.fr/hello.html'

# 7c. from the workstation, through the CREMI https relay, then in a browser
#     curl -s https://qemuweb.emi.u-bordeaux.fr/hello.html
```

**Expect (stage 1)**: 7a prints `HTTP/2 200` (or `HTTP/1.1 200 OK`), then `hello from v0-qemuweb` in the page, then
`302 https://qemuweb.emi.u-bordeaux.fr/hello.html`. 7b and 7c print the same page, and the browser shows the padlock
with no warning.

If 7a works but 7b does not: the machine's firewall (443). If 7a and 7b work but 7c does not (403, 502, certificate
or name error): the problem is the CREMI relay (ask the CREMI), not this machine. `sudo tail -n 20
/var/log/apache2/qemuweb-error.log` and `qemuweb-access.log` show what Apache received.

### Stage 2: the same page behind OpenID

The OpenID client is **the one of the reference site** (the CREMI administrator asked for the same client). Its three
secrets (client ID, client secret, crypto passphrase) are never in the repository: they live in
`/etc/apache2/qemuweb-oidc.inc` on this server, root only, which the Apache site includes.

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
# the CREMI OpenID provider must be reachable from here without the proxy (mod_auth_openidc reads its metadata at startup)
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' https://openid.emi.u-bordeaux.fr/.well-known/openid-configuration   # 200
sudo a2enmod auth_openidc headers                 # OpenID; headers: RequestHeader (identity for the application)
sudo install -m 0644 deploy/cremi/au-revoir.html /var/www/qemuweb/au-revoir.html
sudo install -m 0644 deploy/cremi/qemuweb-2-oidc.conf /etc/apache2/sites-available/qemuweb.conf
sudo apache2ctl configtest                        # Syntax OK
sudo systemctl restart apache2                    # restart: a new module is loaded

# 10a. on the server, without a session: a redirection to the CREMI login, not the page
curl --noproxy '*' -s -D - -o /dev/null --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/hello.html | grep -iE '^(HTTP|location)'

# 10b. from the CREMI jump host, the same (on the workstation)
#      ssh cremi 'curl -s -D - -o /dev/null https://v0-qemuweb.emi.u-bordeaux.fr/hello.html | grep -iE "^(HTTP|location)"'

# 10c. in a browser, https://qemuweb.emi.u-bordeaux.fr/hello.html: CREMI login, then the page. Then, on the server,
#      the access log: the line of hello.html has `user=` followed by your CREMI login
sudo tail -n 5 /var/log/apache2/qemuweb-access.log
```

**Expect (stage 2)**: 10a prints `HTTP/1.1 302 Found` and a `location:` that starts with
`https://openid.emi.u-bordeaux.fr/`; 10b prints the same. In the browser (10c) you are sent to the CREMI login, then
see `hello from v0-qemuweb`; the log line of `/hello.html` reads `user=<your CREMI login>` (`user=-` on the first, redirected request, which had
no session). A user without the group `cremi-active` gets `403` after the login.

**Why the log shows the identity.** The site sets the header `X-Remote-User` from the claim `preferred_username`
(`RequestHeader set X-Remote-User ... env=OIDC_CLAIM_preferred_username`), and the `LogFormat` of the site prints
`%{X-Remote-User}i`, the request header as Apache sends it on. It needs no module and no script, it is the exact
value QemuWeb will receive in stage 3, and it is robust (a CGI or SSI page would need another module). The site
first removes any `X-Remote-User` (and `X-User-*`) sent by a browser (`RequestHeader unset ... early`), so a client
cannot forge its identity. All the variables of a logged-in user are listed at
https://services.emi.u-bordeaux.fr/intranet/mesinfos/info.php.

If 10a gives `500` or no redirection: `sudo tail -n 30 /var/log/apache2/qemuweb-error.log` (a wrong secret shows as
an error of the token endpoint; an unreachable provider as a metadata error). If the OpenID provider is only
reachable through the proxy, add `OIDCOutgoingProxy proxy:3128` to the site (not needed on the reference site).

To log out (to test again): `https://qemuweb.emi.u-bordeaux.fr/.openid?logout=https://qemuweb.emi.u-bordeaux.fr/au-revoir`
(the page `/au-revoir` is not protected, so that the logout is not followed by an immediate login).

### Stage 3: QemuWeb behind Apache

What is **double** until task OIDC01: the user first logs in with OpenID (Apache), then with the QemuWeb
password of `users.json` (step 11). QemuWeb ignores `X-Remote-User` for now; OIDC01 will make the server trust that
header, only from the local Apache, take the administrator role from a group claim and drop the second password.

```sh
# 11. application accounts (asks for a password; users.json is 0600). The user name must be a QemuWeb account
U='./scripts/user.sh --users /etc/qemuweb/users.json'
$U add admin --role admin
$U add toto
$U list

# 12. service (QemuWeb on 127.0.0.1:3002; port 3002 is never opened in the firewall)
sudo install -m 0644 deploy/cremi/qemuweb.service /etc/systemd/system/qemuweb.service
sudo systemctl daemon-reload
sudo systemctl enable --now qemuweb
sudo journalctl -u qemuweb -n 30 --no-pager -o cat    # "QemuWeb is ready." "No runner connected."
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3002/auth/me    # 401: the application alone

# 13. the proxy modules, the waiting page and the site of stage 3
apache2 -v | head -1                              # 2.4.47 or later: ProxyPass ... upgrade=websocket (WebSocket)
sudo a2enmod proxy proxy_http proxy_wstunnel      # reverse proxy, WebSocket
sudo install -m 0644 deploy/cremi/attente.html /var/www/qemuweb/attente.html
sudo install -m 0644 deploy/cremi/qemuweb-3-app.conf /etc/apache2/sites-available/qemuweb.conf
sudo apache2ctl configtest                        # Syntax OK
sudo systemctl restart apache2                    # restart: new modules are loaded

# 14a. on the server, without a session: OpenID answers first (302), not the application (401)
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/auth/me
# a header sent by a client is not believed: still 302
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' -H 'X-Remote-User: admin' --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/auth/me
# runner registration is excluded from OpenID: QemuWeb answers itself (a 4xx, never 302)
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/api/runner/register
# runner connection, same (without the WebSocket upgrade; 401 or 404, never 302)
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/runner/connect
# the waiting page: QemuWeb stopped, a path without OpenID gives 503 and the page of attente.html
sudo systemctl stop qemuweb
curl --noproxy '*' -s -w '\n%{http_code}\n' --resolve v0-qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://v0-qemuweb.emi.u-bordeaux.fr/runner/connect | grep -E 'not available|^50'
sudo systemctl start qemuweb

# 14b. from the CREMI jump host (on the workstation)
#      ssh cremi 'curl -s -o /dev/null -w "%{http_code}\n" https://v0-qemuweb.emi.u-bordeaux.fr/auth/me'

# 14c. in a browser, https://qemuweb.emi.u-bordeaux.fr/ : CREMI login, then the QemuWeb login (toto), "Load session
#      ZIP" demo/lan.zip (needs a runner: see Runner A), start, open a console (WebSocket). In the developer tools,
#      the cookie of QemuWeb has "Secure" set (X-Forwarded-Proto: https). Then the access log shows your login
sudo tail -n 5 /var/log/apache2/qemuweb-access.log
```

**Expect (stage 3)**: 14a prints `302`, `302`, then a `4xx` (the application's answer, not `302`), then `401` or `404`
(not `302`), then `not available` (the page) and `503`. 14b prints `302`. In the browser (14c): CREMI login, QemuWeb
login, then the application; the access log lines carry `user=<your CREMI login>`.

What Apache does for QemuWeb (`qemuweb-3-app.conf`): proxies everything to `127.0.0.1:3002` with
`upgrade=websocket` (Socket.IO and `/runner/connect`) and a one-hour timeout; sends `X-Forwarded-Proto: https`
(QemuWeb runs with `--trust-proxy loopback`, so the login cookie is `Secure`; Apache itself adds `X-Forwarded-For`
and `X-Forwarded-Host`); accepts bodies up to 1 GiB (`LimitRequestBody 1073741824`, for session ZIP archives, which
are flat sparse files; `/api/runner/register` takes 8 KiB); and shows `attente.html` on 502 and 503.

**Runners and OpenID.** `/runner/connect` and `/api/runner/register` are excluded from OpenID with an
`AuthType None` block, because a runner has no browser: it authenticates with its own token (a bearer token checked
by QemuWeb, which rejects an unknown one with 401; registration needs a one-time token created by an administrator).
The local runner (Runner A) does not use Apache at all: it dials the Unix socket of the server.

If the consoles open but freeze, or `/runner/connect` fails only through the public name while it works on the
server (14a) and from the jump host (14b): the CREMI relay must pass WebSocket and allow 3600 s and large bodies
(ask the CREMI). If Apache is older than 2.4.47 (`apache2 -v`), `upgrade=websocket` does not exist: replace the
`ProxyPass / ...` line by a `RewriteCond %{HTTP:Upgrade} websocket [NC]` plus `RewriteRule ^/?(.*)
ws://127.0.0.1:3002/$1 [P,L]` pair (and enable `rewrite`).

### Rolling back one stage

Each stage is only a site file: put the previous one back, test, reload. Modules that stay enabled do no harm.

```sh
# from stage 3 to stage 2 (QemuWeb stays installed, but is no longer reachable through Apache)
sudo install -m 0644 deploy/cremi/qemuweb-2-oidc.conf /etc/apache2/sites-available/qemuweb.conf
sudo apache2ctl configtest && sudo systemctl reload apache2

# from stage 2 to stage 1 (no more OpenID: the static page only)
sudo install -m 0644 deploy/cremi/qemuweb-1-hello.conf /etc/apache2/sites-available/qemuweb.conf
sudo apache2ctl configtest && sudo systemctl reload apache2

# out of the site altogether (the secrets file stays: delete it by hand if you give up)
sudo a2dissite qemuweb && sudo apache2ctl configtest && sudo systemctl reload apache2
```

Then repeat the checks of that stage. Note that stage 1 and stage 2 serve a test page: nobody can use QemuWeb until
stage 3 is back.

### Update later

```sh
# 15. a restart deletes the sessions of remote runners; the machines of the local runner survive
cd /srv/qemuweb && git pull && npm ci && sudo systemctl restart qemuweb
# after a change of a site file or of the secrets file
sudo apache2ctl configtest && sudo systemctl reload apache2
```

## Runner A: local, on this machine (`ssh qemuweb-app`)

The server starts no machine: this runner does, under the `qemuweb` account, on the same machine. It dials
the server on the Unix socket `/var/lib/qemuweb/runner-3002.sock`, so both services use the same `--runtime`
(`/var/lib/qemuweb`: the runtime path must stay at most 49 characters, because the sockets of a node must fit in
107 bytes). Each host of `demo/lan.zip` takes 1 GiB of memory (`free -g`, `nproc` tell what this machine has).

```sh
# 16. packages of the runner, and /dev/kvm for qemuweb
sudo apt install -y qemu-system-x86 qemu-utils genisoimage vde2
qemu-system-x86_64 -netdev help | grep vde          # must list vde; else docs/install.md#qemu-without-vde-support (.env.local in /srv/qemuweb)
sudo usermod -aG kvm qemuweb
sudo -u qemuweb sh -c 'test -w /dev/kvm && echo kvm-ok'

# 17. base images. Building on this machine does not work behind the CREMI proxy (cdimage.debian.org answers 503
#     from squid, and the Debian installer that runs in the VM gets no proxy): build on the workstation, then
#     copy (-a keeps the dates: the server ignores a hash file older than its image, -S keeps the file sparse).
#     (on the workstation, in the repository)
#       bash scripts/prepare.sh --system debian13-legacy
#       rsync -aS --progress images/debian13-legacy.raw images/debian13-legacy.raw.sha256 qemuweb-app:/srv/qemuweb/images/
cd /srv/qemuweb
bash scripts/prepare.sh --list

# 18. the runner service
sudo install -m 0644 deploy/cremi/qemuweb-runner.service /etc/systemd/system/qemuweb-runner.service
sudo systemctl daemon-reload
sudo systemctl enable --now qemuweb-runner
sudo journalctl -u qemuweb-runner -n 30 --no-pager -o cat   # "Connected to the server."
sudo journalctl -u qemuweb -n 10 --no-pager -o cat          # the server sees its runner

# 19. try it without Apache and OpenID: an SSH tunnel from the workstation (keep it open), then
#     http://127.0.0.1:3012 in a browser, log in as toto (QemuWeb password), "Load session ZIP" demo/lan.zip,
#     start, open a console
#     (on the workstation)  ssh -N -L 3012:127.0.0.1:3002 qemuweb-app

# 20. on the server: the machines run here, under the runner's account
ps -eo pid,user,args | grep -E "[q]emu-system|[v]de_switch" | cut -c1-110
sudo journalctl -u qemuweb-runner -n 20 --no-pager -o cat
```

To stop the runner and its machines: `sudo systemctl stop qemuweb-runner` (tell users to save a session ZIP
first). Restarting only the server keeps the machines: the runner reconnects and the server adopts its sessions.

## Runner B: remote, on another machine

A runner that dials the server over the network with its own token, through Apache (stage 3: `/runner/connect` and
`/api/runner/register` are not behind OpenID). If the CREMI relay does not pass the WebSocket yet, test it with the
SSH tunnel of variant A of `docs/remote-runner-test.md`.

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

Until milestone 6 (quotas, HMP allowlist, `Origin` check, logout, jail): trusted users only.
