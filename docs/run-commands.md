# Starting the server and a runner: one page

The **server** serves the web interface and places each session on a **runner**, the process that runs the machines (QEMU, VDE).
Details: [install.md](install.md), [deployment.md](deployment.md), [remote-runner-test.md](remote-runner-test.md).

## 1. Everything on one machine (server and local runner)

```sh
./scripts/start.sh --listen 3002        # server + local runner (--no-auth: quick trial)
./scripts/demo.sh                       # demo on port 3003: admin/admin, toto/toto, tutu/tutu
# browser: http://127.0.0.1:3002  (accounts: ./scripts/user.sh --help)
```

Two terminals, to restart the server alone (the runner keeps the machines):

```sh
./scripts/server.sh --listen 3003 --local-runner --runner-grace 300    # terminal 1
./scripts/runner.sh --port 3003                                        # terminal 2
```

## 2. Server on one machine, runner on another (here `prout` 192.168.0.101 and `tralala` 192.168.0.100)

**Server (`prout`)**, listening on the LAN address (`--bind`; `--no-auth` is refused off loopback):

```sh
./scripts/demo.sh --bind 192.168.0.101                  # demo (passwords = logins: trusted LAN)
./scripts/server.sh --listen 3003 --bind 192.168.0.101  # or a plain server, no local runner
```

Browser: `http://192.168.0.101:3003`, sign in as an administrator, **/admin, Runners, Create registration token**, copy it (shown once).

**Runner (`tralala`)**, which dials out (no inbound port):

```sh
./scripts/runner.sh register --url http://192.168.0.101:3003 --token TOKEN --name tralala --insecure \
  --runner-config ~/.config/qemuweb-runner/runner.json         # once
./scripts/runner.sh run --url http://192.168.0.101:3003 --insecure \
  --runner-config ~/.config/qemuweb-runner/runner.json         # every start
```

To place a session on `tralala`: pause the `local` runner in **/admin, Runners**, then sign in as a user without a session.

## What to remember

| Topic | Rule |
| --- | --- |
| Registration token | Single use, valid 15 min, 1 h or 24 h: only for `register`. The runner then keeps its own token in `runner.json` until it is **revoked** (exit status 78). |
| `--insecure` | Only for a plain `http://` URL to an address other than 127.0.0.1 (token and traffic readable on the network); leave it out with `https://`. |
| Runner machine | The account must be in the `kvm` group (`sudo usermod -aG kvm $USER`, log in again); a system whose image is missing there is not offered (`scripts/prepare.sh --list`). |
