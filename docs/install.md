# Installation

How to install QemuWeb on a machine and run it for your own use. To try it quickly with the demo, see the
[README](../README.md#try-the-demo). To open it to students (nginx, TLS, services, remote runners), see
[deployment](deployment.md).

## Install

QemuWeb targets **Ubuntu 24.04 on x86-64**.

1. Install the system packages. `build-essential` and `python3` are needed to
   compile `node-pty`, which has no Linux prebuild:

   ```sh
   sudo apt install bash build-essential coreutils findutils grep gzip curl git python3 qemu-system-x86 qemu-utils genisoimage vde2
   ```

2. Install **Node.js 24 LTS** with npm. Ubuntu's `nodejs` package is too old,
   and `npm ci` fails with `EBADENGINE` on other Node versions. Use one of:

   ```sh
   nvm install                 # with nvm; reads .nvmrc
   sudo n 24                   # with n
   ```

   Or use the [official download](https://nodejs.org/en/download). Then check
   that `node --version` prints `v24.x` (run `hash -r` first if the shell still
   finds the old version).

3. Check QEMU prerequisites:
   - `qemu-system-x86_64 -netdev help` must list `vde`. If it does not, see
     [QEMU without VDE support](#qemu-without-vde-support).
   - Your user must be able to read and write `/dev/kvm`. If not, run
     `sudo usermod -aG kvm $USER` and log in again.

4. Clone, install, prepare one image, and start:

   ```sh
   git clone https://github.com/orel33/qemuweb.git
   cd qemuweb
   npm ci
   bash scripts/prepare.sh --system alpine
   ./scripts/user.sh add alice      # create your account; prompts for a password
   ./start.sh
   ```

Open <http://127.0.0.1:3002> and log in. Press `Ctrl+C` to stop the server, or
use `./start.sh --listen 3003` to choose another port. `./start.sh` starts two processes, the server and a
runner (the process that runs the machines), each as its own command, with output lines prefixed
`[server]` and `[runner]`; stopping it stops both, and if one of them dies the other is stopped. To keep the machines running when the server
restarts, run `./scripts/server.sh` in one terminal and `./scripts/runner.sh` in another (see
[docs/deployment.md](deployment.md#the-runner-process)).

The server listens only on `127.0.0.1`. To use it from another machine, forward
the port over SSH (`ssh -L 3002:127.0.0.1:3002 <server>`) or put it behind
nginx with TLS: see [docs/deployment.md](deployment.md).

VirtualBox is optional: install it separately to provide `VBoxManage`. The
VirtualBox engine is disabled in the Web interface when `VBoxManage` is
unavailable.

## Starting the server and the runner by hand

`./start.sh` is the same as these two commands, run in two terminals from the
repository root (port 3002 and `runtime/` of the repository by default, for both):

```sh
./scripts/server.sh                          # terminal 1: the server (web interface, accounts, sessions)
./scripts/runner.sh                          # terminal 2: the runner (QEMU and VDE processes)
./scripts/server.sh --listen 3003            # another port: the runner names the same one
./scripts/runner.sh --port 3003
```

The runner connects to the server of its `--port` and reconnects by itself, so
the two can start in either order. Run it as your normal user, never as root.
`./scripts/runner.sh --exit-on-disconnect` makes it stop its machines and exit
when the server goes away, which is what `./start.sh` does. `--help` of either script lists its
options; a refused option prints `<program>: <message>` and a `Usage:` line, exits with status 2 and starts nothing
(see [Server and runner command line](reference.md#server-and-runner-command-line)).

| To | Command |
|---|---|
| Stop the server only; the runner keeps the machines and waits for a new server | `Ctrl+C` in terminal 1, or `./scripts/stop.sh` (with `--listen PORT` if needed) |
| Stop the runner and all its machines | `Ctrl+C` in terminal 2 |
| See the servers, runners and machines of this project | `./scripts/status.sh` (`-w` to refresh, `--all` for other projects) |
| Stop everything, including leftovers after a crash | `./scripts/killall.sh` |

After a server restart, the runner's sessions are adopted again: users find
their machines still running.

## Images

`scripts/prepare.sh` prepares the systems listed in [`config.json`](../config.json):
Alpine Linux 3.24, Debian 13 Cloud, Debian 13 Legacy, and OpenWrt 25.12.

```sh
bash scripts/prepare.sh                      # all systems
bash scripts/prepare.sh --system <id>        # alpine, debian13-cloud, debian13-legacy, openwrt
bash scripts/prepare.sh --list               # show prepared images
bash scripts/prepare.sh --hash               # record image hashes without building
bash scripts/prepare.sh --system <id> --force  # rebuild one system
```

Downloads go to `sources/<system>/`. Each system gets a RAW base image for QEMU
and a VDI base image for VirtualBox in `images/`; VirtualBox is not needed to
build them. Existing images are reused. `--force` keeps the previous RAW/VDI
pair in `images/backups/`; stop the system's machines first, because their
working disks depend on the base image.

Each build also records `images/<system>.raw.sha256` and `.vdi.sha256` (the output of
`sha256sum`, so `cd images && sha256sum -c alpine.raw.sha256` verifies one). The server
uses a hash file that is not older than its image to compare the image with a session
archive without reading several gigabytes; a missing, malformed or older file is ignored
and the image is hashed instead (asynchronously). `bash scripts/prepare.sh --hash`
records them for existing images without rebuilding anything. Restore an image from
`images/backups/` together with its `.sha256` file, since an older image is not detected
when its newer hash file is left in place.

Guests log in as `root` without a password on the serial console.

Debian hosts have two serial ports (`ttyS0` and `ttyS1`) so that two
commands can run at once, for example `ping` on the first and `tcpdump` on the
second. Choose what a pane shows with its view selector: **Console (ttyS0)**,
**Console (ttyS1)** (only for hosts that have it), **Monitor** or **Log**;
the program running on the other console keeps running. **Host Settings →
Console** lists the console sockets (`serial0.sock`, `serial1.sock`) and the
monitor socket. Alpine, OpenWrt and
VirtualBox hosts have a single console. Debian images prepared before this
feature have no login on `ttyS1`: run `scripts/prepare.sh` again.

## Troubleshooting

### QEMU without VDE support

Ubuntu 24.04's packaged QEMU may lack the VDE network backend. Build a
compatible binary with the [QEMU installation notes](../misc/install-qemu.md), then
create `.env.local` in the repository root:

```text
QEMU_SYSTEM_X86_64=/opt/qemu-<version>/bin/qemu-system-x86_64
```

This overrides only `QEMU_SYSTEM_X86_64`; `qemu-img` still comes from the
distribution. Check that `/opt/qemu-<version>/bin/qemu-system-x86_64 -netdev help`
lists `vde`, then run `./start.sh` again.

### Port already in use

Another QemuWeb server is probably running. Stop it with `scripts/stop.sh`, or
start on another port with `./start.sh --listen 3003`.

### Runtime socket path is too long

`Runtime socket path is too long; move the project to a shorter directory.` The sockets of a node live in
`<runtime>/sessions/<session id>/<node id>/` and a Unix socket path is limited to 107 bytes, which leaves 49
characters for the runtime directory itself. A project kept in a deep directory (for example
`/home/me/Documents/projects/qemuweb/runtime`, 51 characters) fails when a session is loaded. Start with a short
runtime directory, for the server and the runner alike: `./scripts/start.sh --runtime /tmp/qemuweb-rt`
(`scripts/demo.sh` already does).
