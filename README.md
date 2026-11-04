# QemuWeb - beta

This demo runs Alpine Linux, Debian 13, or OpenWrt in QEMU or VirtualBox and relays the `ttyS0` serial console to xterm.js through a local web server.

## Text console: xterm and the browser

In the historical QemuNet command, `-append '… console=ttyS0 …'` explicitly tells the **Linux kernel** to write to its first serial port. With `xterm -e qemu-system-x86_64 … -nographic`, QEMU hides the video display and, when no `-serial` option is supplied, implicitly connects that serial port to its standard input and output, and therefore to xterm. QEMU also shares those streams with its monitor (`Ctrl+A`, then `C`). The name `ttyS0` is not implicit: its **connection to xterm** is. A `getty` service on `ttyS0` is still needed to display a `login:` prompt.

In the web demo, `-display none` only hides the video display. `-serial unix:…` explicitly connects the serial port to a socket; the server then relays characters between that socket and xterm.js over WebSocket. `-monitor unix:…` opens a separate socket for the QEMU monitor. The serial console and login are configured in the images by `prepare.sh`. The [detailed command comparison](docs/commandes-qemu.pdf) illustrates both paths.

### Serial console and QEMU monitor

Both options use the same short syntax here, but provide two distinct interfaces:

```sh
-serial unix:/path/to/console.sock,server=on,wait=off
-monitor unix:/path/to/monitor.sock,server=on,wait=off
```

`-serial` connects the first virtual serial port (`ttyS0` in Linux) to the guest's interactive terminal: boot messages, `login:`, and then a shell. `-monitor` opens the text-based HMP monitor of **QEMU itself**: its commands control the emulator and are not Linux shell commands. `server=on` makes QEMU listen on each Unix socket; the Node server connects to them. `wait=off` lets QEMU start without waiting for a connection. The short form of `-serial` replaces the earlier `-chardev socket,… -serial chardev:serial0` pair.

In the web toolbar, check **Monitor** to enter commands for the VM in the current tab. For example, `help` lists commands, `info status` reports the VM's status, and `info block` describes its disks. Commands such as `system_reset` or `quit` directly change or stop the VM, so use them with care. The monitor is available for QEMU, not VirtualBox. Its commands and responses are recorded in the **Log**, even when the panel is hidden.

## Image preparation

`prepare.sh` prepares the systems before use:

- **Alpine**: the script downloads and verifies the official `virt` ISO, installs it unattended into a RAW image, prepares the `root` and `toto` accounts, configures boot output and login on `ttyS0`, then produces the VDI base for VirtualBox.
- **Debian 13**: the script downloads and verifies the official cloud image, boots it once in an isolated temporary QEMU VM, prepares the `root`, `toto`, and `demo` accounts, configures serial access and DHCP networking, disables cloud-init for subsequent boots, then produces a read-only RAW image.
- **OpenWrt**: the script verifies and decompresses the official RAW image.
- For **VirtualBox**, the script converts each RAW image into a read-only VDI base.

At launch, the server performs no further system configuration: QEMU creates a differential QCOW2 based on the RAW image; VirtualBox creates a differential VDI based on the prepared VDI. Each instance has its own writes. They are retained by **Stop** and **Reboot**, then discarded by **Reset** or by closing the tab. The base files in `images/` are never modified.

`images/` contains only ready-to-run base images named after the system identifier: `alpine.raw` / `alpine.vdi`, `debian13.raw` / `debian13.vdi`, and `openwrt.raw` / `openwrt.vdi`. The `.raw` extension explicitly identifies the disk format. `sources/` keeps the official downloads and checksums needed for preparation; `runtime/` contains temporary files and VM differential disks. [config.json](config.json) describes the systems and their launch options; `prepare.sh` does not overwrite it or generate a catalog.

### System configuration

[config.json](config.json) follows the same approach as [qemunet.cfg](https://github.com/orel33/qemunet/blob/master/qemunet.cfg): each key under `systems` (`alpine`, `debian13`, `openwrt`) identifies a system. Each entry contains its `linux` type, `text` mode, label and long description, login details, `images.raw` and `images.vdi` paths, system-specific QEMU options, and VirtualBox settings. Paths can be relative to the project root or absolute. Launching relies on this file; `server.js` contains no rules tied to an OS name. Any ISO files used by `prepare.sh` remain preparation sources, not systems that can be launched from the interface.

`qemu.defaults` supplies common values. The `systems.<id>.qemu` object contains only overrides: Debian 13 requests 1,024 MiB, OpenWrt requests 256 MiB and no network adapter, and Alpine inherits the defaults. `systems.<id>.virtualbox` separately supplies its memory, network, and VirtualBox OS type. To add an already prepared Linux system in text mode, add a complete entry to `systems` with paths to its RAW and VDI bases; no separate catalog is needed.

In the web page, click **Settings** to view the system values and their corresponding QEMU or VirtualBox arguments. The dialog also shows settings added by the server and the disk creation and launch commands. Before launch, these are a preview; after launch, the session's settings are displayed. To change settings, edit `config.json` before starting a new VM. The interface and system descriptions are in English.

The **QEMU · KVM auto / TCG** choice remains in the main toolbar because it also depends on `/dev/kvm` and any running VirtualBox VMs. Disk, serial-console, and monitor paths are generated at launch; the QCOW2 differential disk format and control sockets are part of the demo's operation. Configuration changes apply to **new sessions**. **Reboot** and **Reset** retain the options selected when their tab first started.

### Stopping and cleaning up

```sh
./killall.sh                 # stop all servers and VMs belonging to this project
./cleanall.sh                # stop instances and empty runtime/; keep images/ and sources/
./cleanall.sh --images       # also empty images/; keep downloads in sources/
./cleanall.sh --sources      # also empty the sources/ download cache; keep the bases
./cleanall.sh --images --sources  # remove both the bases and the preparation cache
./cleanall.sh --dry-run      # show what would be stopped and removed
```

These scripts target the QEMU and Node processes and VirtualBox VMs associated with this directory. `cleanall.sh` keeps `.gitkeep` files and does not delete the code or `node_modules/`. After `--images`, `prepare.sh` can rebuild the bases from `sources/` without downloading them again; after `--sources`, a full preparation will need to download any missing sources.

### Formats in use

| Engine | Read-only base | Instance differential disk |
|---|---|---|
| QEMU | RAW | QCOW2 |
| VirtualBox | VDI converted from the same RAW image | Differential VDI |

The RAW image remains the master source. `prepare.sh` produces an additional VDI base for VirtualBox, which uses additional disk space. Both engines use the same OS content, but each creates its own working disk. The bases are never modified.

### Conversions and commands

The following commands are equivalent to the steps performed by the project:

```sh
# Convert the RAW base to VDI for VirtualBox
qemu-img convert -f raw -O vdi base.raw base.vdi

# Create a QEMU working disk based on the RAW image
qemu-img create -f qcow2 -F raw -b base.raw instance.qcow2

# Create a VirtualBox differential disk based on the VDI
VBoxManage createmedium disk --filename instance.vdi --diffparent base.vdi --format VDI
```

VirtualBox can also convert the RAW image to VDI with `VBoxManage convertfromraw base.raw base.vdi --format VDI`. QEMU can use a VDI as the base of a QCOW2 by replacing `-F raw` with `-F vdi` in the overlay creation command. Neither variant is used by the demo.

Preparation downloads missing images from official repositories and verifies them against the published checksums. Once the images are prepared, starting and running VMs requires no downloads or cloud service.

## Prerequisites

- Linux x86_64, Node.js 18 or newer, and npm.
- `curl`, `sha256sum`, `sha512sum`, `gzip`, and `qemu-img`. `qemu-img` prepares the bases and creates QEMU overlays.
- Preparing Alpine and Debian also requires `qemu-system-x86_64` and `python3`; Debian additionally requires `genisoimage`. KVM speeds up preparation when `/dev/kvm` is readable and writable; otherwise preparation uses the slower TCG emulator. Alpine preparation also selects TCG when a VirtualBox VM is already running.
- To run with QEMU: `qemu-system-x86_64`. To run with VirtualBox: VirtualBox and `VBoxManage`.

## Installation and preparation

```sh
git clone --branch main https://github.com/orel33/qemuweb.git
cd qemuweb
npm ci
bash prepare.sh
```

The script places downloaded ISOs, cloud images, archives, and checksums in `sources/`, then places only the final `<id>.raw` and `<id>.vdi` bases in `images/`. It checks that the paths declared in `config.json` exist but does not rewrite that file. The page's system menu is populated directly from `config.json`. `runtime/` is reserved for files belonging to running VMs. The contents of all three directories are ignored by Git, except for the `.gitkeep` files that preserve their structure.

## Running the demo

```sh
npm start
```

Open <http://127.0.0.1:3002>. Each tab represents a VM: **New machine** creates a new tab. Choose a system and an engine, then click **Start** once. A display name such as `debian13-00` is assigned at launch; double-click the tab to change it while the VM is running. This name does not change the Linux hostname inside the VM. Numbering advances from 00 to 99 for each system during the server's lifetime. VMs in other tabs continue to run in parallel. Serial output and logs belong to each machine; check **Log** to display QEMU or VirtualBox commands. The tab's close button immediately force-stops its VM and deletes the whole session: differential disk, sockets, logs, and VirtualBox registration. It also cancels an ongoing Reboot or Reset. Login details appear above the terminal:

QEMU selects KVM when available. To run QEMU alongside VirtualBox, choose **QEMU · TCG** (slower software emulation) before starting QEMU. If VirtualBox is already running, **QEMU · KVM auto** automatically switches the new VM to TCG. VirtualBox cannot start while a QEMU VM uses KVM; the interface explains how to restart VMs in a compatible mode.

By default, [config.json](config.json) selects `-cpu host` in KVM mode: QEMU exposes the CPU features that the host can provide to the VM. This avoids the `CPUID.80000001H:ECX.svm` warning that QEMU's default CPU model can produce on an Intel host: `svm` is the AMD virtualization feature and is not needed for these VMs. In TCG mode, the profile selects `-cpu qemu64`. This setting affects the virtual CPU, not the Debian image; VMs already running keep their configuration until their next launch.

- **Alpine Linux 3.24**: `root` with an empty password, or `toto` / `toto`; ephemeral differential disk, restricted QEMU networking and VirtualBox NAT by default.
- **Debian 13**: `root` with no password; `toto` / `toto` or `demo` / `serial-demo`; ephemeral differential disk, restricted QEMU networking and VirtualBox NAT by default.
- **OpenWrt 25.12 x86-64**: press Enter to open the `root` shell without a password; ephemeral differential disk, networking disabled by default.

**Reboot** requests a graceful system shutdown, then restarts the VM on the same differential disk: all changes written to it are retained. **Reset** displays a warning, stops only the VM in the current tab, deletes its differential disk, creates a new one from the base image, and restarts it; other VMs are unaffected. These commands keep the same tab and display name. After **Stop**, you can choose **Reset** to restart from the base; **Start** is reserved for the tab's first launch. Closing a tab stops and deletes its session. Stopping the server with Ctrl+C stops all VMs it manages.

**Clear** removes the current tab's console history while preserving its current line, such as the login or shell prompt. The VM keeps running and new output appears normally.

If port 3002 is already in use, stop the old server or choose another port:

```sh
PORT=3003 npm start
```

## Official images

- [Alpine Linux virt](https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/)
- [Debian cloud images](https://cloud.debian.org/images/cloud/)
- [OpenWrt x86-64 images](https://downloads.openwrt.org/releases/25.12.6/targets/x86/64/)
