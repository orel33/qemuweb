# <img src="public/favicon.svg" alt="" width="32" height="32"> QemuWeb

QemuWeb lets you create and control Linux machines running in QEMU or VirtualBox
from a browser. Connect them through VDE switches, use their serial consoles,
and import or export sessions and network topologies.

## Quick start

You need a **Linux** or **macOS** host, **Node.js 18 or newer** with npm, Bash, Python 3,
QEMU (`qemu-system-x86_64`, and optionally `qemu-system-aarch64` on Apple Silicon, with VDE support), `qemu-img`, `vde_switch`, `vdeterm`, and
an ISO image tool (`genisoimage` or `mkisofs`). VirtualBox (`VBoxManage`) is optional.
On Linux, QEMU uses KVM hardware acceleration when `/dev/kvm` is accessible. On macOS,
QEMU uses HVF acceleration when running native architectures (e.g. ARM64 guests on Apple Silicon,
or x86_64 guests on Intel) and TCG emulation when running x86_64 guests on Apple Silicon.

### On Ubuntu 24.04:

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

### On macOS:

Install the dependencies with Homebrew:

```sh
brew install node python3 qemu vde cdrtools
```

### Setup and Start

Clone, install dependencies, prepare one image, and start:

```sh
git clone https://github.com/orel33/qemuweb.git
cd qemuweb
npm ci
bash scripts/prepare.sh --system alpine
./start.sh
```

Open <http://127.0.0.1:3002>. Press `Ctrl+C` to stop the server, or use
`PORT=3003 ./start.sh` to choose another port.

The server listens only on `127.0.0.1` and has no authentication. To use it
from another machine, forward the port over SSH:
`ssh -L 3002:127.0.0.1:3002 <server>`.

VirtualBox is optional: install it separately to provide `VBoxManage`. The
VirtualBox engine is disabled in the Web interface when `VBoxManage` is
unavailable.

## Using QemuWeb

### Included LAN demo

1. Prepare the Debian Legacy image: `bash scripts/prepare.sh --system debian13-legacy`.
2. In the Web interface, choose an engine in **General Settings**, click
   **Load session ZIP**, and select [`demo/lan.zip`](demo/lan.zip).
3. Start the hosts and the switch. Their startup scripts assign `192.168.0.x`
   addresses to the four hosts. Open their consoles and `ping` between them.

The archive contains settings and startup scripts but no working disks, so hosts
start from fresh images. [`demo/`](demo/) also contains DMZ and gateway sessions
(`dmz0.zip`, `dmz1.zip`, `gw0.zip`, `gw1.zip`).

### Sessions and topologies

- **Save session** exports hosts, switches, settings, and startup scripts as a
  ZIP archive; **Load session ZIP** restores it.
- Before loading, the dialog summarizes the archive and warns when a base image
  changed since the session was saved. Hosts on a changed image start from the
  current image; their working disks (qcow2) are discarded, never reused.
- **Load topology** reads a `.topo` text file that describes only hosts,
  switches, and their links, without disks or startup scripts. Examples:
  [`topo/lan.topo`](topo/lan.topo), [`topo/dmz.topo`](topo/dmz.topo),
  [`topo/gw.topo`](topo/gw.topo).

### Startup scripts

Each host can run `start.sh` at boot from an automatically built startup disk.
Enable **Auto-build and attach startup disk** in **Host Settings → Startup**,
then edit `start.sh`. The default script uses placeholders replaced for each
host:

```sh
#!/bin/sh
hostname @HOSTNAME@
ifconfig @IFNAME0@ 192.168.0.@SWPORT0@/24
```

To ship another file, such as `firewall.sh`, use **Add extra files** in the same
tab and call it from `start.sh`, for example `sh /mnt/cdrom/firewall.sh`. Each
extra file is limited to 1 MiB, and all startup files together to 4 MiB. Save
the settings and restart the host to use the rebuilt disk.

### OCI Containers with Boot2container (b2c)

QemuWeb supports launching virtual machines directly from OCI / Docker container images using [Boot2container](https://gitlab.freedesktop.org/gfx-ci/boot2container) without building full OS disk images:

1. Prepare container assets: `bash scripts/prepare.sh --system container`.
   - The preparation script automatically detects the host architecture (`uname -m`):
     - On Apple Silicon (`arm64`), downloads `linux-arm64-qemu` and `initramfs.linux_arm64.cpio.xz`.
     - On x86_64 (`amd64`), downloads `linux-x86_64-qemu` and `initramfs.linux_amd64.cpio.xz`.
   - Initializes a 10 GB sparse cache disk (`images/container.raw`) to persist container layers locally.
2. In the Web interface, add a new host and choose system **OCI Container (b2c)**.
3. In **Host Settings**, enter any public or private container image (e.g. `docker.io/library/alpine:3.20` or `docker.io/library/nginx:alpine`).
4. Networking:
   - Interface `eth0` defaults to **Internet (NAT)**, which provides transparent DHCP and outbound internet access for Boot2container to pull container layers from Docker Hub or OCI registries.
   - Additional interfaces (`eth1`, `eth2`, ...) can connect to virtual switches (`s1`, `s2`, ...) to participate in private topologies alongside regular VMs.
5. Multi-architecture execution:
   - Boot2container uses `"arch:qemu": "auto"`. On Apple Silicon Macs, QemuWeb automatically executes native ARM64 QEMU (`qemu-system-aarch64`) with **HVF hardware acceleration**, boots the ARM64 kernel, and pulls native ARM64 container layers. On x86_64 hosts, it runs `qemu-system-x86_64` with KVM.

## Images

`scripts/prepare.sh` prepares the systems listed in [`config.json`](config.json):
Alpine Linux 3.24, Debian 13 Cloud, Debian 13 Legacy, OpenWrt 25.12, and OCI Container (Boot2container).

```sh
bash scripts/prepare.sh                      # all systems
bash scripts/prepare.sh --system <id>        # alpine, debian13-cloud, debian13-legacy, openwrt, container
bash scripts/prepare.sh --list               # show prepared images
bash scripts/prepare.sh --system <id> --force  # rebuild one system
```

Downloads go to `sources/<system>/`. Each system gets a RAW base image for QEMU
and a VDI base image for VirtualBox in `images/`; VirtualBox is not needed to
build them. Existing images are reused. `--force` keeps the previous RAW/VDI
pair in `images/backups/`; stop the system's machines first, because their
working disks depend on the base image.

Guests log in as `root` without a password on the serial console.

## Configuration

| File | Purpose |
| --- | --- |
| [`config.json`](config.json) | System catalog, base images, memory, and QEMU or VirtualBox options. |
| [`.env`](.env) | Executable names used by QemuWeb. |
| `.env.local` | Machine-specific overrides of `.env` (absolute paths); ignored by Git. |
| `runtime/<session>/` | Current session: `session.json`, `<host>/host.json`, `<host>/startup/start.sh`, `<switch>/switch.json`, working disks, and sockets. |

`runtime/` is temporary: a session's files are removed with the session or when
the server stops. Use **Save session** to keep a portable copy.

## Maintenance scripts

| Command | Effect |
| --- | --- |
| `scripts/stop.sh` | Stop the server started on `PORT` (default 3002). |
| `scripts/killall.sh [--dry-run]` | Stop this project's servers, QEMU processes, and VirtualBox VMs, including orphans. |
| `scripts/cleanall.sh [--dry-run] [--images] [--sources]` | Run `killall.sh`, then remove `runtime/` files and optionally images or downloads. |

## Development

| Path | Role |
| --- | --- |
| `server.js` | HTTP API, Socket.IO consoles, and process management. |
| `topology.js` | `.topo` parsing and formatting. |
| `session-archive.js` | Session ZIP import and export. |
| `guest-media.js` | Startup disk (ISO) generation. |
| `resource-metrics.js` | CPU and memory metrics for VMs. |
| `command-preflight.js`, `system-config.js` | Executable checks, and `config.json` and host settings validation. |
| `public/` | Web interface (HTML, xterm.js terminals, network graph). |
| `scripts/prepare/` | One image preparation script per system. |

See [docs/architecture.md](docs/architecture.md) for the data paths between the
browser, the server, and QEMU, VirtualBox, and VDE.

Tests:

```sh
npm test                          # unit tests only
./scripts/run-tests.sh --list     # unit and integration scenarios
```

Integration tests need prepared images, QEMU with VDE, and usually KVM. See
[test/TESTS.md](test/TESTS.md) for each scenario and its prerequisites.

## Troubleshooting

### QEMU without VDE support

Ubuntu 24.04's packaged QEMU may lack the VDE network backend. Build a
compatible binary with the [QEMU installation notes](misc/install-qemu.md), then
create `.env.local` in the repository root:

```text
QEMU_SYSTEM_X86_64=/opt/qemu-<version>/bin/qemu-system-x86_64
```

This overrides only `QEMU_SYSTEM_X86_64`; `qemu-img` still comes from the
distribution. Check that `/opt/qemu-<version>/bin/qemu-system-x86_64 -netdev help`
lists `vde`, then run `./start.sh` again.

### Port already in use

Another QemuWeb server is probably running. Stop it with `scripts/stop.sh`, or
start on another port with `PORT=3003 ./start.sh`.

### Custom QEMU paths and .env configuration

By default, QemuWeb resolves QEMU executables (`qemu-system-x86_64` and `qemu-system-aarch64`) from the system `PATH` (such as `/opt/homebrew/bin` on macOS or `/usr/bin` on Linux).

To use custom builds or non-standard install paths, override them in `.env.local` (ignored by Git):

```text
QEMU_SYSTEM_X86_64=/custom/path/bin/qemu-system-x86_64
QEMU_SYSTEM_AARCH64=/custom/path/bin/qemu-system-aarch64
```

Note that `QEMU_SYSTEM_AARCH64` is optional and non-blocking: on systems without an ARM64 QEMU binary, server startup proceeds normally as long as `qemu-system-x86_64` is available.
