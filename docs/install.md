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
interface when `VBoxManage` is unavailable (the **Engine** select of the header, next to the
title, offers it only when the server has `VBoxManage`).

## Starting the server and the runner by hand

`./start.sh` is the same as these two commands, run in two terminals from the
repository root (port 3002 and the runtime directory `/tmp/qw-<login>/3002` by default, for both):

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
bash scripts/prepare.sh                      # same as --list: nothing is built
bash scripts/prepare.sh --system all         # all systems
bash scripts/prepare.sh --all                  # same as --system all
bash scripts/prepare.sh --system <id>        # alpine, debian13-cloud, debian13-legacy, openwrt
bash scripts/prepare.sh --list               # show prepared images and the state of their SHA-256 files (ok, old, missing)
bash scripts/prepare.sh --hash               # (all systems) record image hashes without building (reports missing images)
bash scripts/prepare.sh --system <id> --force  # rebuild one system
bash scripts/prepare.sh --system <id> --proxy http://proxy:3128/  # behind an HTTP proxy
bash scripts/prepare.sh --system all --parallel  # build the systems at the same time (at most 4); --parallel=N: at most N (1 to 8)
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
records them for existing images without rebuilding anything: it prints `<system>.<format>: no image`
for a missing one, and exits with status 2 when `--system` names a system without any image
(or when no system has an image, or a hash cannot be written); one missing format is only a warning. Restore an image from
`images/backups/` together with its `.sha256` file, since an older image is not detected
when its newer hash file is left in place.

### Building several systems at once

`--system all --parallel` (or `--all --parallel`) builds the systems at the same time instead of
one after the other: `--parallel` runs as many builds as there are systems, at most 4, and
`--parallel=N` (1 to 8) at most N (`--parallel=1` is the sequential build, and the option has no
effect for one system). The builds share nothing: each one has its own `sources/<system>/`,
`images/<system>.*`, scratch directory and build VM (QEMU user-mode network, no fixed port), and
no two systems download the same file. Each build writes its whole output to
`sources/.prepare/.parallel.XXXXXX/<system>.log` (the paths are printed at the start); the terminal
shows one status line per system (state, elapsed time, phase), redrawn in place, or plain
`<system>: started / done in HH:MM:SS / FAILED` lines without a terminal. A failed build does not
stop the others: the summary lists every system with its time, then the end of each failed log, and
the exit status is 1 (the logs are kept; after a full success they are removed). Ctrl+C or SIGTERM
stops all the builds and their VMs (with `--force`, the previous images of the interrupted systems
are put back). Follow one build with `tail -f` on its log (below).

Several Debian VMs at once are heavy: each build VM takes 0.25 to 2 GB of memory (Debian Legacy:
2 GB and 2 cores; the others 1 GB or less) and an image build writes several GB. `prepare.sh`
warns (it does not refuse) when less than 2 GB of memory is available per build, when the machine has
fewer cores than builds, or when less than 10 GB are free in `images/` or `sources/`; lower
`--parallel=N` in that case. KVM serves several VMs at once.

### Behind an HTTP proxy

Without direct Internet access, give the proxy with `--proxy URL` (`http://host:port`;
`--proxy none` or an empty value forces no proxy). By default `prepare.sh` uses the
`https_proxy` or `http_proxy` variable when set, which is also what `curl` uses for
the downloads. The proxy in use is printed first (`Proxy: http://proxy:3128/ (from the
environment)` or `Proxy: none`; credentials in the URL are hidden). An invalid URL is
refused with status 2.

The builds run an installer or a script in a VM, which cannot see your environment, so the
proxy is given to it: Debian 13 Legacy through the installer preseed (`mirror/http/proxy`),
Debian 13 Cloud through the cloud-init apt configuration, Alpine through the `PROXYOPTS` answer
of `setup-alpine` and the `http_proxy`, `https_proxy` and `ftp_proxy` variables of its build
script (also used by its `apk add`), OpenWrt through the same variables before its `apk add`.
It is removed from, or never written into, the finished image (the Alpine build checks that the
installed `/etc` does not hold it). A proxy on the machine's own loopback (`localhost`, `127.x`) is
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
`security.debian.org` (Alpine: `mirrors.alpinelinux.org/mirrors.txt` and the `main` and `community`
package indexes of `dl-cdn.alpinelinux.org`; OpenWrt: the `base` and `packages` feeds of
`downloads.openwrt.org`) through the same proxy and stops at once, naming the failing URL
and the `curl` error (and, for a `403` of the proxy, the IPv4/IPv6 hint above), when they are not
reachable. The ISO and the images are downloaded with `curl`; a failed download names its URL.

### Progress and failures of a build

The Alpine and OpenWrt builds show the same status line and failure report as the
Debian ones (their phases come from markers that the build script prints and from the Alpine
installer's steps). The log shows for Alpine the failure of an unreachable mirror
(`wget: can't connect to remote host`, `No mirror found`, `unable to select packages`) and for
OpenWrt an `apk` network error or the failure marker of the build script; such a failure ends the
build within seconds (the VM has no stall of more than 5 minutes, and `apk` is stopped after
3 minutes in the OpenWrt VM) with the end of the log, the log directory and the hint
`the build VM cannot reach <host>: check the proxy (--proxy URL, or -6 if the proxy only accepts IPv6)`.
The strings are in `scripts/prepare/lib/common.sh` (`ALPINE_FAILURES`, `OPENWRT_FAILURES`);
they come from the failing Alpine log recorded at the CREMI, the OpenWrt ones are not yet checked
against a real failure.

To follow a build from another terminal, copy the `tail -f` command that each build prints when
its VM starts (the full path of the serial log, in the scratch directory of the build):

```text
  Installing Alpine in a VM
    log: /srv/qemuweb/sources/.prepare/.alpine-prepare.AbC123/alpine-serial.log  (follow: tail -f /srv/qemuweb/sources/.prepare/.alpine-prepare.AbC123/alpine-serial.log)
```

The log holds the terminal escape sequences of the guest console, as the VM wrote them; for a clean
view, filter them out:

```sh
tail -f <log> | sed -u 's/\x1b\[[0-9;?]*[A-Za-z]//g'
```

With `--parallel` the same line is in the log of each build (`<system>.log`), the status without a
terminal prints `<system>: build VM started, serial log <path>`, and the final summary gives the
serial log paths that still exist (a successful build removes its directory).

While the VM runs, one status line shows a gauge, an estimated percentage, the phase,
the elapsed time and the size of the serial log, for example
`[#####-----]  50%  Installing the base system  06:12  log 340 KB`. It is updated in
place on a terminal, and printed every 30 seconds otherwise. The percentage is an
estimate by phase read from the serial log (the steps of the installer, the stages of
cloud-init), not a measure of work: it never goes back and reaches 100% only at the end.
Cloud-init prints nothing while it installs packages, so that phase is long.

The build stops at once (status 1) when the log shows an error that will not recover,
such as the installer's `Bad archive mirror` dialog; it then prints the last 20 lines
of the log, the log directory and hints. The list of strings is in
`scripts/prepare/lib/common.sh`. A VM that prints nothing for 5 minutes is reported
(the installer is stopped after 15), and any VM is stopped after 30 minutes
(`PREPARE_VM_TIMEOUT` in the same file).

When a build fails:

1. Read the end of the log shown, then the whole serial log,
   `sources/.prepare/.<system>-prepare.XXXXXX/serial.log` (the directory is kept on failure, with
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
VirtualBox hosts have a single console. Debian images prepared before 17
November 2026 have no login on `ttyS1`, so its pane stays empty. Until the
first byte arrives, the **Console (ttyS1)** pane shows a hint saying so
("Nothing received yet. Press Enter. ..."): if it stays, rebuild the image with
`bash scripts/prepare.sh --system <id> --force`. `bash scripts/prepare.sh --list`
reads each Debian raw image offline and read-only (with `debugfs`, no root) and
prints a line such as `debian13-legacy  ttyS1 login: yes`, `... no`
or `... unknown` (`debugfs` missing, unreadable image or unexpected partition
table). Every raw image also gets a line such as
`debian13-legacy  guest agent: yes (restricted)`, `... yes (NOT restricted)`
(the agent is there without its QemuWeb allowlist) or `... no`,
read the same way: see [guest-agent](guest-agent.md).

**Addresses on the Graphic view (guest agent).** The addresses a running host reports are read from the QEMU
guest agent (`qemu-guest-agent`, `qemu-ga` on OpenWrt) through a virtio-serial channel QemuWeb adds to
the QEMU command line for the systems that have `guestAgent:qemu` in `config.json`. The four systems have it, but
only the images prepared with this version contain the agent (and its `/etc/qemu/qemu-ga.conf`, which
allows nothing but the network query): Debian 13 Legacy already had the package, Debian 13 Cloud, Alpine and OpenWrt
need `bash scripts/prepare.sh --system <id> --force`. An image without the agent simply shows no address.
VirtualBox hosts show none.

## VirtualBox

QemuWeb is checked with VirtualBox 7.1 (`virtualbox-7.1` from Oracle), on a
machine whose `vboxdrv` kernel module matches `VBoxManage --version`. After a
kernel or VirtualBox update, run `sudo /sbin/vboxconfig` (and reboot if the
module is still the old one).

- **VirtualBox and KVM cannot run at the same time.** VirtualBox 7.1 on x86
  needs the processor's virtualization extensions (VT-x/AMD-V), which QEMU's KVM
  holds while one QEMU host runs, and the reverse. The runner refuses the start
  of a VirtualBox host while a QEMU/KVM host runs on the same runner (any
  session), and the start of a QEMU/KVM host while a VirtualBox host runs. The
  message, shown in a dialog and in the host's Log, names only your own hosts
  that use the other engine: stop them, or try again later. When the conflict
  comes from another session it says only that the virtualization hardware of
  the runner is busy, and never names a host or a user; the names go to the
  runner's own output (`admin diagnostics:`), which only the administrator reads. The KVM modules may stay loaded: only
  running machines matter. A program the runner cannot see (another runner, a
  libvirt machine, a QEMU started by hand) gives the VirtualBox error "another
  program on this machine holds the virtualization hardware (KVM)": stop it.
  To use both engines, run them one after the other, or use a machine or a
  runner dedicated to VirtualBox. **Switching the engine** of a session is done in the
  header (**Engine**), only while no host of the session is up or busy; the hosts,
  their settings for both engines and the working disk of each engine (`disk.qcow2`,
  `disk.vdi`) are kept, so a session can alternate between QEMU and VirtualBox. A saved
  VirtualBox disk (`disk.vdi` in a session ZIP) loads again only when the base `.vdi` of its system is
  byte-identical to the one it was made on (the ZIP records its size and SHA-256); the runner then
  registers that base with VirtualBox again before attaching the disk, and a message names the cause if it
  cannot. A host
  whose system has no `.vdi` image (`scripts/prepare.sh`) stays in the session and cannot
  start under VirtualBox. Placing a VirtualBox session on a runner free
  of KVM hosts is not automatic yet.
- **The group `vboxusers` is not required** when `VBoxHeadless` is setuid root,
  as in the Oracle package, even though `/dev/vboxdrv` is `root:root 0600`
  (`/etc/udev/rules.d/60-vboxdrv.rules`). If a start says "VirtualBox cannot
  open /dev/vboxdrv", add yourself to the group (`sudo usermod -aG vboxusers
  $USER`) and log in again.
- **Reading a failure.** A host that fails to start shows a short sentence in its
  state line and in its **Log** view: a `# …` line that names the cause and the
  fix, followed by the original `VBoxManage` message. A failed start also opens a dialog with the same sentence (one dialog for
  Resume all, listing each host). A failed start removes
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

### The runtime directory is refused or too long

The runtime directory defaults to `/tmp/qw-<login>/<port>` (see [the reference](reference.md#runtime-directory)), so
the location of the project no longer matters. Two messages can still appear at startup:

- `… is too long (N bytes) … Use a shorter --runtime.` Only with an explicit `--runtime`: a Unix socket path is limited
  to 107 bytes, which leaves 49 bytes for the runtime directory (the message gives the exact numbers). Choose a shorter one.
- `/tmp/qw-<login> … refusing to use it`: the directory exists but is a symbolic link, belongs to someone else, or is open to group or
  others. Someone else created it, or it was changed: look at it, delete it if it is yours, or use `--runtime DIR`.

Warning `runtime directory … is on a tmpfs` or `has only N GB free`: the working disks of the sessions are written there;
give a larger disk with `--runtime DIR` if sessions are big.

With the default directory, **sessions do not survive a reboot of the machine** (`/tmp` is emptied): the next start
begins with an empty session. Use **Save session** (ZIP) to keep work, or `--runtime DIR` on a persistent disk.
