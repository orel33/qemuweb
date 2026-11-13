# QemuWeb

QemuWeb lets you create and control Linux machines running in QEMU or VirtualBox
from a browser. You can connect them through VDE switches, use their serial
consoles, and import or export sessions and network topologies. The
[architecture](docs/architecture.md) is documented separately.

## Installation

For **Ubuntu 24.04 on x86-64**, install **Node.js 24 LTS** with npm from the
[official Node.js download page](https://nodejs.org/en/download). Ubuntu 24.04's
`nodejs` package is older. The repository includes `.nvmrc` for users of nvm.
Check `node --version` and `npm --version` before installing dependencies;
npm rejects unsupported Node versions.

QEMU installations need `qemu-system-x86_64` with VDE support, `qemu-img`,
`vde_switch`, `vdeterm`, and access to `/dev/kvm`. VirtualBox is optional:
install it separately to provide `VBoxManage` if you want VirtualBox hosts.
Image preparation uses `curl`, `gzip`, `isoinfo`, and standard Unix tools.

On Ubuntu 24.04, install the distribution packages:

```sh
sudo apt install bash build-essential coreutils findutils grep gzip curl git python3 qemu-system-x86 qemu-utils genisoimage vde2
```

Clone the repository:

```sh
git clone https://github.com/orel33/qemuweb.git
cd qemuweb
```

The Ubuntu 24.04 QEMU package installed here does not provide the VDE network
backend. If `qemu-system-x86_64 -netdev help` does not list `vde`, follow the
[QEMU installation notes](misc/install-qemu.md) to build a compatible binary
and select it with `.env.local`. Confirm that your user can read and write
`/dev/kvm` before starting QEMU hosts. Then install the Node.js dependencies,
prepare one image, and start QemuWeb:

```sh
npm ci
bash scripts/prepare.sh --system alpine
./start.sh
```

Open <http://127.0.0.1:3002>. Press `Ctrl+C` to stop the server. Use
`PORT=3003 ./start.sh` to choose another port. The project's `allowScripts`
entry lets npm 11 run the pinned `node-pty` install script. VirtualBox is
disabled in the Web interface when `VBoxManage` is unavailable. Image
preparation creates both RAW and VDI files with QEMU tools; it does not need
VirtualBox. Running a QEMU host requires usable `/dev/kvm` access.

## Try the included LAN demo

1. Prepare at least the Debian Legacy image with `bash scripts/prepare.sh --system debian13-legacy`.
2. In the Web interface, choose an engine in **General Settings**, click **Load session ZIP**, and select [`demo/lan.zip`](demo/lan.zip).
3. Start the hosts and switch if they are not running. Their startup scripts assign `192.168.0.x` addresses to the four hosts. Open their consoles and try `ping` between them.

The archive includes settings and startup scripts, but no working disks, so
hosts start from fresh images. [`topo/lan.topo`](topo/lan.topo) describes the same
layout for **Load topology**, without startup scripts or IP addresses. You can
also add hosts and switches in the Web interface, connect them, and save the
session as a ZIP archive.

To include a file such as `firewall.sh` in a host's startup disk, open **Host
Settings → Startup → Add extra files** and select it. Enable **Auto-build and
attach startup disk** in the same tab, then call the file from `start.sh` if
it should run at boot, for example `sh /mnt/cdrom/firewall.sh`. Save the settings
and restart the host to use the rebuilt disk. Each extra file can be at most
1 MiB; all startup files together can be at most 4 MiB.

## Prepare the available images

`bash scripts/prepare.sh` prepares the four systems listed in
[`config.json`](config.json): Alpine Linux 3.24, Debian 13 Cloud, Debian 13 Legacy,
and OpenWrt 25.12. Newly built Debian images include the `resize` command. To prepare
one system or list existing images:

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
