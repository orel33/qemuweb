# Installation

How to install QemuWeb on a machine and run it for your own use. To try it quickly with the demo, see the
[README](../README.md#try-the-demo). To open it to students (nginx, TLS, services, remote runners), see
[deployment](deployment.md).

## Install

QemuWeb targets **Ubuntu 24.04 on x86-64**.

1. Install the system packages. `build-essential` and `python3` are needed to
   compile `node-pty`, which has no Linux prebuild:

   ```sh
   sudo apt install bash build-essential coreutils findutils grep gzip curl git python3 qemu-system-x86 qemu-utils genisoimage vde2 tcpdump
   ```

   `tcpdump` prints the packets of a capture as text for the live **Capture**
   view of the Terminals (see [Capturing traffic](user-guide.md#capturing-traffic)).
   The runner checks it at startup like the other tools (`TCPDUMP` in `.env`,
   also searched in `/usr/sbin` and `/sbin`) but does not need it to run: without
   it the startup check warns, the live view says so, and everything else works,
   PCAP files included.

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

VirtualBox is optional: install it separately to provide `VBoxManage` (see
[VirtualBox](#virtualbox)). The VirtualBox engine is disabled in the Web
interface when `VBoxManage` is unavailable.

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
bash scripts/prepare.sh --list               # show prepared images and the state of their SHA-256 files (ok, old, missing)
bash scripts/prepare.sh --hash               # record image hashes without building
bash scripts/prepare.sh --system <id> --force  # rebuild one system
bash scripts/prepare.sh --system <id> --proxy http://proxy:3128/  # behind an HTTP proxy
bash scripts/prepare.sh --system <id> --follow  # also show the last 20 lines of the build log
bash scripts/prepare.sh --system <id> --proxy http://proxy:3128/ -6  # the build VM reaches the proxy over IPv6
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

### Behind an HTTP proxy

Without direct Internet access, give the proxy with `--proxy URL` (`http://host:port`;
`--proxy none` or an empty value forces no proxy). By default `prepare.sh` uses the
`https_proxy` or `http_proxy` variable when set, which is also what `curl` uses for
the downloads. The proxy in use is printed first (`Proxy: http://proxy:3128/ (from the
environment)` or `Proxy: none`; credentials in the URL are hidden). An invalid URL is
refused with status 2.

The Debian builds run an installer (Debian 13 Legacy) or cloud-init (Debian 13 Cloud)
in a VM, which cannot see your environment: the proxy is written into the installer
preseed (`mirror/http/proxy`) and the cloud-init apt configuration, and removed from
the finished image. A proxy on the machine's own loopback (`localhost`, `127.x`) is
given to the VM as `10.0.2.2`, the host as seen from QEMU's user-mode network; a proxy
given by a name is resolved on this machine and the VM gets its address (a short name
such as `proxy` works here through the search domains of the machine, not in the VM).

The build VM goes out over IPv4. A proxy may accept this machine over IPv6 and refuse its IPv4
address (`403`, `ERR_ACCESS_DENIED`): your own `curl` and `apt` then work (they prefer IPv6)
and the VM does not. The check before the VM starts is made over the same family as the VM and
says so. Ask for the IPv4 address of the machine to be authorised, or give `-6` (`--ipv6`): the
proxy name is then resolved to its IPv6 address, which the VM receives in brackets
(`http://[2001:db8::42]:3128/`; such an address can also be given to `--proxy` directly). Before
starting the VM, the build fetches the `Release` files of `deb.debian.org` and
`security.debian.org` through the same proxy and stops at once, naming the failing URL
and the `curl` error, when they are not reachable. The ISO and the other systems are
downloaded with `curl`; a failed download names its URL.

### Progress and failures of a Debian build

While the VM runs, one status line shows a gauge, an estimated percentage, the phase,
the elapsed time and the size of the serial log, for example
`[#####-----]  50%  Installing the base system  06:12  log 340 KB`. It is updated in
place on a terminal, and printed every 30 seconds otherwise. The percentage is an
estimate by phase read from the serial log (the steps of the installer, the stages of
cloud-init), not a measure of work: it never goes back and reaches 100% only at the end.
Cloud-init prints nothing while it installs packages, so that phase is long.

`--follow` (or `--follow=N`, 1 to 100 lines) shows the last 20 lines of the serial log
under the status line, redrawn in place on a terminal, so that a long phase can be watched.
Without a terminal (a pipe, a file) the new log lines are printed as they appear.

The build stops at once (status 1) when the log shows an error that will not recover,
such as the installer's `Bad archive mirror` dialog; it then prints the last 20 lines
of the log, the log directory and hints. The list of strings is in
`scripts/prepare/lib/common.sh`. A VM that prints nothing for 5 minutes is reported
(the installer is stopped after 15), and any VM is stopped after 30 minutes
(`PREPARE_VM_TIMEOUT` in the same file).

When a Debian build fails:

1. Read the end of the log shown, then the whole serial log,
   `runtime/.<system>-prepare.XXXXXX/serial.log` (the directory is kept on failure, with
   `qemu.stderr` and the preseed or cloud-init files; delete it when done).
2. Check the proxy first (`Proxy:` line); an unreachable mirror is the usual cause.
3. Without Internet access at all, build the image on another machine and copy
   `images/<system>.raw` and `.vdi` here, then run `bash scripts/prepare.sh --hash`.

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

## VirtualBox

QemuWeb is checked with VirtualBox 7.1 (`virtualbox-7.1` from Oracle), on a
machine whose `vboxdrv` kernel module matches `VBoxManage --version`. After a
kernel or VirtualBox update, run `sudo /sbin/vboxconfig` (and reboot if the
module is still the old one).

- **VirtualBox and KVM cannot run at the same time.** VirtualBox 7.1 on x86
  needs the processor's virtualization extensions (VT-x/AMD-V), which QEMU's KVM
  holds while one QEMU host runs, and the reverse. The runner refuses the start
  of a VirtualBox host while a QEMU/KVM host runs on the same runner (any
  session), and the start of a QEMU/KVM host while a VirtualBox host runs, with a
  message naming the hosts to stop. The KVM modules may stay loaded: only
  running machines matter. A program the runner cannot see (another runner, a
  libvirt machine, a QEMU started by hand) gives the VirtualBox error "another
  program on this machine holds the virtualization hardware (KVM)": stop it.
  To use both engines, run them one after the other, or use a machine or a
  runner dedicated to VirtualBox. Placing a VirtualBox session on a runner free
  of KVM hosts is not automatic yet.
- **The group `vboxusers` is not required** when `VBoxHeadless` is setuid root,
  as in the Oracle package, even though `/dev/vboxdrv` is `root:root 0600`
  (`/etc/udev/rules.d/60-vboxdrv.rules`). If a start says "VirtualBox cannot
  open /dev/vboxdrv", add yourself to the group (`sudo usermod -aG vboxusers
  $USER`) and log in again.
- **Reading a failure.** A host that fails to start shows a short sentence in its
  state line and in its **Log** view: a `# …` line that names the cause and the
  fix, followed by the original `VBoxManage` message. A failed start removes
  the virtual machine it created, so `VBoxManage list vms` and `VBoxManage list
  hdds` show nothing of it.

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
