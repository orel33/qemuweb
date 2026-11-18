# QemuWeb on qemuweb.emi.u-bordeaux.fr (CREMI)

Debian or Ubuntu (TODO: confirm with `cat /etc/os-release`). Files to copy are in this directory
(`deploy/cremi/`): `qemuweb.service` (systemd unit) and `nginx-qemuweb.conf` (nginx site). Two parts:
A as root (`ssh qemuweb`), B as `qemuweb` (`ssh qemuweb-app`, which forwards your SSH agent to reach the git
mirror; `qemuweb` is a sudoer). The two aliases are in the workstation's `~/.ssh/config`: `qemuweb` (root) and
`qemuweb-app` (user `qemuweb`, `ForwardAgent yes`), both through the CREMI jump host. The server runs as
`qemuweb`, never root. See `docs/deployment.md` and `docs/remote-runner-test.md` (variant B).

## Part A: root (`ssh qemuweb`)

```sh
# prompt: standard Debian (user@host:dir#), now and at every login
PS1='${debian_chroot:+($debian_chroot)}\u@\h:\w\$ '
echo "PS1='\${debian_chroot:+(\$debian_chroot)}\\u@\\h:\\w\\\$ '" >> ~/.bashrc

# 0. proxy (3128); /etc/profile.d is read by the login shells of qemuweb
export http_proxy=http://proxy:3128/ https_proxy=http://proxy:3128/ no_proxy=localhost,127.0.0.1
echo 'export http_proxy=http://proxy:3128/ https_proxy=http://proxy:3128/ no_proxy=localhost,127.0.0.1' > /etc/profile.d/proxy.sh

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

## Part B: `qemuweb` (`ssh qemuweb-app`)

```sh
ssh-add -l                                        # on the server: your identity must be listed

# 4. code, from the mirror
git clone git@gitub.u-bordeaux.fr:info/qemuweb.git /srv/qemuweb
cd /srv/qemuweb && git checkout main && npm ci
git describe --tags

# 5. application accounts (asks for a password; users.json is 0600)
U='./scripts/user.sh --users /etc/qemuweb/users.json'
$U add admin --role admin
$U add toto
$U list

# 6. nginx, with the prepared certificate files in /srv/cert (check them first: annex A)
sudo ss -ltnp | grep -E ':(80|443)\s'            # who holds 80 and 443 now (apache2?)
sudo systemctl disable --now apache2              # frees 80 and 443 for nginx (error if not installed: ignore)
sudo apt install -y nginx
sudo chmod 700 /srv/cert && sudo chmod 600 /srv/cert/key.pem
sudo rm -f /etc/nginx/sites-enabled/default
sudo install -m 0644 deploy/cremi/nginx-qemuweb.conf /etc/nginx/sites-available/qemuweb
sudo ln -sf /etc/nginx/sites-available/qemuweb /etc/nginx/sites-enabled/qemuweb
sudo nginx -t && sudo systemctl reload nginx
# firewall: 80 and 443 only, never 3002. TODO: restrict access until milestone 6

# 7. service
sudo install -m 0644 deploy/cremi/qemuweb.service /etc/systemd/system/qemuweb.service
sudo systemctl daemon-reload
sudo systemctl enable --now qemuweb
sudo journalctl -u qemuweb -n 30 --no-pager -o cat    # "QemuWeb is ready." "No runner connected."

# 8. checks (401 twice)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3002/auth/me
curl -s -o /dev/null -w '%{http_code}\n' https://qemuweb.emi.u-bordeaux.fr/auth/me

# 9. update later (a restart deletes the sessions of remote runners)
cd /srv/qemuweb && git pull && npm ci && sudo systemctl restart qemuweb
```

## Remote runner (another machine)

```sh
# 10. as root on REMOTE (proxy first if needed)
apt update
apt install -y bash build-essential coreutils findutils grep gzip curl git python3 qemu-system-x86 qemu-utils genisoimage vde2 ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
adduser --disabled-password --gecos '' runner
usermod -aG kvm runner                            # effective at next login

# 11. as runner on REMOTE
git clone git@gitub.u-bordeaux.fr:info/qemuweb.git ~/qemuweb && cd ~/qemuweb && npm ci   # needs read access to the mirror (own key or deploy key)
id -nG | grep -w kvm
qemu-system-x86_64 -netdev help | grep vde
bash scripts/prepare.sh --system alpine           # or copy images/ from another machine
curl -s -o /dev/null -w '%{http_code}\n' https://qemuweb.emi.u-bordeaux.fr/auth/me     # 401

# 12. browser: admin, /admin -> Runners, create a registration token (shown once)

# 13. register once, then run (--ca FILE only for a private authority)
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
