# QemuWeb on qemuweb.emi.u-bordeaux.fr (CREMI)

Debian or Ubuntu (TODO: confirm with `cat /etc/os-release`). Files to copy are in this directory
(`deploy/cremi/`): `qemuweb.service` and `qemuweb-runner.service` (systemd units), `nginx-qemuweb.conf` (nginx
site), and `nginx-hello.conf` with `hello.html` (static test page). The server is installed in two parts: part 1
as root (`ssh qemuweb`), part 2 as `qemuweb` (`ssh qemuweb-app`, which forwards your SSH agent to reach the git
mirror; `qemuweb` is a sudoer). Then the runner that runs the machines: **A** on this same machine (local
runner), **B** on another machine (remote runner). The two aliases are in the workstation's `~/.ssh/config`: `qemuweb` (root) and
`qemuweb-app` (user `qemuweb`, `ForwardAgent yes`), both through the CREMI jump host. The server runs as
`qemuweb`, never root. See `docs/deployment.md` and `docs/remote-runner-test.md` (variant B).

## Server, part 1: root (`ssh qemuweb`)

```sh
# prompt: standard Debian (user@host:dir#), now and at every login
PS1='${debian_chroot:+($debian_chroot)}\u@\h:\w\$ '
echo "PS1='\${debian_chroot:+(\$debian_chroot)}\\u@\\h:\\w\\\$ '" >> ~/.bashrc

# 0. proxy (3128); /etc/profile.d is read by the login shells of qemuweb
export http_proxy=http://proxy:3128/ https_proxy=http://proxy:3128/ no_proxy=localhost,127.0.0.1,qemuweb.emi.u-bordeaux.fr
echo 'export http_proxy=http://proxy:3128/ https_proxy=http://proxy:3128/ no_proxy=localhost,127.0.0.1,qemuweb.emi.u-bordeaux.fr' > /etc/profile.d/proxy.sh

# 1. packages (build-essential, python3: node-pty is compiled by npm ci)
apt update && apt full-upgrade -y
apt install -y bash build-essential coreutils findutils grep gzip curl git python3 ca-certificates gnupg sudo
apt autoremove -y

# 2. Node.js 24 (Ubuntu's is too old)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
node --version                                    # v24.x

# 3. account (home /home/qemuweb, apart from the code), directories, ssh, sudo
adduser --system --group --home /home/qemuweb --shell /bin/bash qemuweb
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

## Server, part 2: `qemuweb` (`ssh qemuweb-app`)

```sh
ssh-add -l                                        # on the server: your identity must be listed

# 4. code, from the mirror
git clone git@gitub.u-bordeaux.fr:info/qemuweb.git /srv/qemuweb
cd /srv/qemuweb && git checkout main && npm ci
git describe --tags

# 5. test of the web path with a static page, before QemuWeb (check the certificate first: annex A)
sudo ss -ltnp | grep -E ':(80|443)\s'            # who holds 80 and 443 now (apache2?)
sudo systemctl disable --now apache2              # frees 80 and 443 for nginx (error if not installed: ignore)
sudo apt install -y nginx
sudo chmod 700 /srv/cert && sudo chmod 600 /srv/cert/key.pem
sudo install -d /var/www/qemuweb-test
sudo install -m 0644 deploy/cremi/hello.html /var/www/qemuweb-test/hello.html
sudo rm -f /etc/nginx/sites-enabled/default
sudo install -m 0644 deploy/cremi/nginx-hello.conf /etc/nginx/sites-available/qemuweb
sudo ln -sf /etc/nginx/sites-available/qemuweb /etc/nginx/sites-enabled/qemuweb
sudo nginx -t && sudo systemctl reload nginx
# 5a. on the server, nginx alone (should print the page)
curl --noproxy '*' -sk --resolve qemuweb.emi.u-bordeaux.fr:443:127.0.0.1 https://qemuweb.emi.u-bordeaux.fr/hello.html
# 5b. from the CREMI jump host, straight to this machine (IP = hostname -I here)
#     ssh cremi 'curl -sk --resolve qemuweb.emi.u-bordeaux.fr:443:IP https://qemuweb.emi.u-bordeaux.fr/hello.html'
# 5c. from the workstation, through the CREMI https frontend (qemuweb.emi.u-bordeaux.fr is an alias of httpsproxy)
#     curl -sv https://qemuweb.emi.u-bordeaux.fr/hello.html 2>&1 | grep -E '^< HTTP|hello'
#     403 here but the page in 5a and 5b: the frontend must be configured by the CREMI (WebSocket, 3600 s, 4 GiB,
#     X-Forwarded-*, TLS termination); and open https://qemuweb.emi.u-bordeaux.fr/hello.html in a browser

# 6. application accounts (asks for a password; users.json is 0600)
U='./scripts/user.sh --users /etc/qemuweb/users.json'
$U add admin --role admin
$U add toto
$U list

# 7. nginx, the real site (replaces the test site of step 5)
sudo install -m 0644 deploy/cremi/nginx-qemuweb.conf /etc/nginx/sites-available/qemuweb
sudo ln -sf /etc/nginx/sites-available/qemuweb /etc/nginx/sites-enabled/qemuweb
sudo nginx -t && sudo systemctl reload nginx
# firewall: 80 and 443 only, never 3002. TODO: restrict access until milestone 6

# 8. service
sudo install -m 0644 deploy/cremi/qemuweb.service /etc/systemd/system/qemuweb.service
sudo systemctl daemon-reload
sudo systemctl enable --now qemuweb
sudo journalctl -u qemuweb -n 30 --no-pager -o cat    # "QemuWeb is ready." "No runner connected."

# 9. checks (401 twice)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3002/auth/me
curl -s -o /dev/null -w '%{http_code}\n' https://qemuweb.emi.u-bordeaux.fr/auth/me

# 10. update later (a restart deletes the sessions of remote runners)
cd /srv/qemuweb && git pull && npm ci && sudo systemctl restart qemuweb
```

## Runner A: local, on this machine (`ssh qemuweb-app`)

The server starts no machine: this runner does, under the `qemuweb` account, on the same machine. It dials
the server on the Unix socket `/var/lib/qemuweb/runner-3002.sock`, so both services use the same `--runtime`.
Each host of `demo/lan.zip` takes 1 GiB of memory (`free -g`, `nproc` tell what this machine has).

```sh
# 11. packages of the runner, and /dev/kvm for qemuweb
sudo apt install -y qemu-system-x86 qemu-utils genisoimage vde2
qemu-system-x86_64 -netdev help | grep vde          # must list vde; else docs/install.md#qemu-without-vde-support (.env.local in /srv/qemuweb)
sudo usermod -aG kvm qemuweb
sudo -u qemuweb sh -c 'test -w /dev/kvm && echo kvm-ok'

# 12. base images. Building on this machine does not work behind the CREMI proxy (cdimage.debian.org answers 503
#     from squid, and the Debian installer that runs in the VM gets no proxy): build on the workstation, then
#     copy (-a keeps the dates: the server ignores a hash file older than its image, -S keeps the file sparse).
#     (on the workstation, in the repository)
#       bash scripts/prepare.sh --system debian13-legacy
#       rsync -aS --progress images/debian13-legacy.raw images/debian13-legacy.raw.sha256 qemuweb-app:/srv/qemuweb/images/
cd /srv/qemuweb
bash scripts/prepare.sh --list

# 13. the runner service
sudo install -m 0644 deploy/cremi/qemuweb-runner.service /etc/systemd/system/qemuweb-runner.service
sudo systemctl daemon-reload
sudo systemctl enable --now qemuweb-runner
sudo journalctl -u qemuweb-runner -n 30 --no-pager -o cat   # "Connected to the server."
sudo journalctl -u qemuweb -n 10 --no-pager -o cat          # the server sees its runner

# 14. try it without the CREMI frontend: an SSH tunnel from the workstation (keep it open), then
#     http://127.0.0.1:3012 in a browser, log in as toto, "Load session ZIP" demo/lan.zip, start, open a console
#     (on the workstation)  ssh -N -L 3012:127.0.0.1:3002 qemuweb-app

# 15. on the server: the machines run here, under the runner's account
ps -eo pid,user,args | grep -E "[q]emu-system|[v]de_switch" | cut -c1-110
sudo journalctl -u qemuweb-runner -n 20 --no-pager -o cat
```

To stop the runner and its machines: `sudo systemctl stop qemuweb-runner` (tell users to save a session ZIP
first). Restarting only the server keeps the machines: the runner reconnects and the server adopts its sessions.

## Runner B: remote, on another machine

A runner that dials the server over the network with its own token. Until the CREMI frontend is configured
(WebSocket), test it with the SSH tunnel of variant A of `docs/remote-runner-test.md`.

```sh
# 16. as root on REMOTE (proxy first if needed)
apt update
apt install -y bash build-essential coreutils findutils grep gzip curl git python3 qemu-system-x86 qemu-utils genisoimage vde2 ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
adduser --disabled-password --gecos '' runner
usermod -aG kvm runner                            # effective at next login

# 17. as runner on REMOTE
git clone git@gitub.u-bordeaux.fr:info/qemuweb.git ~/qemuweb && cd ~/qemuweb && npm ci   # needs read access to the mirror (own key or deploy key)
id -nG | grep -w kvm
qemu-system-x86_64 -netdev help | grep vde
bash scripts/prepare.sh --system alpine           # or copy images/ from another machine
curl -s -o /dev/null -w '%{http_code}\n' https://qemuweb.emi.u-bordeaux.fr/auth/me     # 401

# 18. browser: admin, /admin -> Runners, create a registration token (shown once)

# 19. register once, then run (--ca FILE only for a private authority)
./scripts/runner.sh register --url https://qemuweb.emi.u-bordeaux.fr --token TOKEN --name salle-test \
  --runtime ~/qemuweb/runtime --runner-config ~/.config/qemuweb-runner/runner.json
./scripts/runner.sh run --runner-config ~/.config/qemuweb-runner/runner.json \
  --runtime ~/qemuweb/runtime --config ~/qemuweb/config.json --url https://qemuweb.emi.u-bordeaux.fr
# "Connected to the server." Then docs/remote-runner-test.md, steps 6 to 8.
```

## Annex A. Checking the certificate (/srv/cert: csr.pem, key.pem, server.crt)

```sh
cd /srv/cert
openssl x509 -in server.crt -noout -subject -issuer -dates      # notBefore past, notAfter future
openssl x509 -in server.crt -noout -ext subjectAltName          # must list qemuweb.emi.u-bordeaux.fr
openssl x509 -in server.crt -noout -checkend $((30*24*3600))    # 0: valid for 30 more days
openssl x509 -in server.crt -noout -pubkey | openssl sha256     # these two hashes
openssl pkey -in key.pem -pubout | openssl sha256               # must be identical
grep -c 'BEGIN CERTIFICATE' server.crt                          # 1: no intermediates, see below
ls -ld /srv/cert /srv/cert/*                                    # 700 and 600 for the key
# only one block: add the authority's intermediates (from the CREMI) to server.crt, keep the order
# cat server.crt intermediate.crt > fullchain.pem   then use fullchain.pem in the nginx block
# csr.pem is only the request: nginx does not use it
```

Until milestone 6 (quotas, HMP allowlist, `Origin` check, logout, jail): trusted users only.
