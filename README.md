# QemuWeb

QemuWeb lets you create and control Linux machines running in QEMU or VirtualBox
from a browser. You can connect them through VDE switches, use their serial
consoles, and import or export sessions and network topologies. The
[architecture](docs/architecture.md) is documented separately.

## Installation

You need a **Linux** or **macOS** host, **Node.js 18 or newer** with npm, Bash, Python 3,
QEMU (`qemu-system-x86_64` with VDE support), `qemu-img`, `vde_switch`, `vdeterm`, and
an ISO image tool (`genisoimage` or `mkisofs`). VirtualBox (`VBoxManage`) is optional.
On Linux, QEMU uses KVM hardware acceleration when `/dev/kvm` is accessible. On macOS,
QEMU uses HVF acceleration on Intel hosts and TCG emulation on Apple Silicon.
Image preparation downloads official sources and uses `curl`, `gzip`, `isoinfo`, and standard Unix tools.

On Debian or Ubuntu, install the distribution packages:

```sh
sudo apt install bash build-essential coreutils findutils grep gzip curl nodejs npm python3 qemu-system-x86 qemu-utils genisoimage vde2
```

On macOS, install the dependencies with Homebrew:

```sh
brew install node python3 qemu vde cdrtools
```

Install VirtualBox separately if you plan to use the VirtualBox engine. If your Linux distribution's
QEMU lacks VDE support, see the [QEMU installation notes](misc/install-qemu.md).
Then, from the repository root:

```sh
npm ci
bash scripts/prepare.sh
./start.sh
```

Open <http://127.0.0.1:3002>. Press `Ctrl+C` to stop the server. Use
`PORT=3003 ./start.sh` to choose another port.

## Try the included LAN demo

1. Prepare at least the Debian Legacy image with `bash scripts/prepare.sh --system debian13-legacy`.
2. In the Web interface, choose an engine in **General Settings**, click **Load session ZIP**, and select [`demo/lan.zip`](demo/lan.zip).
3. Start the hosts and switch if they are not running. Their startup scripts assign `192.168.0.x` addresses to the four hosts. Open their consoles and try `ping` between them.

The archive includes settings and startup scripts, but no working disks, so
hosts start from fresh images. [`topo/lan.topo`](topo/lan.topo) describes the same
layout for **Load topology**, without startup scripts or IP addresses. You can
also add hosts and switches in the Web interface, connect them, and save the
session as a ZIP archive.

## Prepare the available images

`bash scripts/prepare.sh` prepares the four systems listed in
[`config.json`](config.json): Alpine Linux 3.24, Debian 13 Cloud, Debian 13 Legacy,
and OpenWrt 25.12. To prepare one system or list existing images:

```sh
bash scripts/prepare.sh --system alpine
bash scripts/prepare.sh --system debian13-cloud
bash scripts/prepare.sh --system debian13-legacy
bash scripts/prepare.sh --system openwrt
bash scripts/prepare.sh --list
```

Downloads and checksums go to `sources/<system>/`. Preparation creates RAW
base images for QEMU and VDI base images for VirtualBox in `images/`. Existing
images are reused. `--force` rebuilds a selected system and saves the previous
RAW/VDI pair in `images/backups/`. Stop its machines first: their working disks
may depend on the previous base image.

## Configuration files

| File | Purpose |
| --- | --- |
| [`config.json`](config.json) | System catalog, base images, memory, and QEMU or VirtualBox options. |
| `.env` and `.env.local` | Executable names and local path overrides; `.env.local` is specific to your machine. |
| `runtime/<session>/session.json` | Engine and inventory for the current session. |
| `runtime/<session>/<host>/host.json` and `runtime/<session>/<switch>/switch.json` | Saved host and switch settings. |
| `runtime/<session>/<host>/startup/start.sh` | Commands run when a host starts. |
| [`topo/lan.topo`](topo/lan.topo) and other `.topo` files | Text descriptions of topologies, without disks or startup scripts. |

The [JSON examples](docs/samples/) show the session file formats. `runtime/`
contains temporary files that are removed with their session; use **Save session**
to keep a portable copy.
