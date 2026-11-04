# QemuWeb - beta

This demo runs Alpine Linux, Debian 13, or OpenWrt in QEMU or VirtualBox and relays the `ttyS0` serial console to xterm.js through a local web server.

## Text console: xterm and the browser

In the historical QemuNet command, `-append '… console=ttyS0 …'` explicitly tells the **Linux kernel** to write to its first serial port. With `xterm -e qemu-system-x86_64 … -nographic`, QEMU hides the video display and, when no `-serial` option is supplied, implicitly connects that serial port to its standard input and output, and therefore to xterm. QEMU also shares those streams with its monitor (`Ctrl+A`, then `C`). The name `ttyS0` is not implicit: its **connection to xterm** is. A `getty` service on `ttyS0` is still needed to display a `login:` prompt.

In the web demo, `-display none` only hides the video display. `-serial unix:…` explicitly connects the serial port to a socket; the server then relays characters between that socket and xterm.js over WebSocket. `-monitor unix:…` opens a separate socket for the QEMU monitor. The serial console and login are configured in the images by `prepare.sh`. [From QemuNet to Qemuweb](docs/qemunet-to-qemuweb.md) describes both paths and the LAN migration.

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

At launch, the server performs no further system configuration: QEMU creates a QCOW2 working disk based on the RAW image; VirtualBox creates a VDI working disk based on the prepared VDI. Each instance has its own writes. They are retained by **Stop**, **Play / Resume**, and **Reboot**, then discarded by **Reset**, **Exit**, or server shutdown. The base files in `images/` are never modified.

`images/` contains only ready-to-run base images named after the system identifier: `alpine.raw` / `alpine.vdi`, `debian13.raw` / `debian13.vdi`, and `openwrt.raw` / `openwrt.vdi`. The `.raw` extension explicitly identifies the disk format. `sources/` keeps the official downloads and checksums needed for preparation; `runtime/` contains temporary files and VM differential disks. [config.json](config.json) describes the systems and their launch options; `prepare.sh` does not overwrite it or generate a catalog.

### System configuration

Command paths live in [`.env`](.env) (the tracked defaults) and `.env.local` (machine-specific overrides, ignored by Git), separate from [config.json](config.json). `.env` gives each command its default executable name, searched in `PATH`, for example `QEMU_SYSTEM_X86_64=qemu-system-x86_64`. To override one, put `NAME=/absolute/path/to/executable` in `.env.local`. A nonempty `.env.local` value takes priority over the process environment and `.env`. For example:

```sh
QEMU_SYSTEM_X86_64=/opt/qemu-11.1.3/bin/qemu-system-x86_64
```

At startup, the server checks the configured commands, prints a green check or red cross for each, and exits if any check fails. It uses the resolved QEMU, `qemu-img`, and `VBoxManage` paths. `npm start` still launches Node from `PATH`; image preparation and cleanup scripts also still use `PATH`.

[config.json](config.json) follows the same approach as [qemunet.cfg](https://github.com/orel33/qemunet/blob/master/qemunet.cfg): each key under `systems` (`alpine`, `debian13`, `openwrt`) identifies a system. Each entry contains its `linux` type, `text` mode, label and long description, login details, `images.raw` and `images.vdi` paths, system-specific QEMU options, and VirtualBox settings. Paths can be relative to the project root or absolute. Launching relies on this file; `server.js` contains no rules tied to an OS name. Any ISO files used by `prepare.sh` remain preparation sources, not systems that can be launched from the interface.

`qemu.defaults` supplies common values. The `systems.<id>.qemu` object contains only overrides: Debian 13 requests 1,024 MiB, OpenWrt requests 256 MiB, and Alpine inherits the defaults. All profiles have external networking disabled. `systems.<id>.virtualbox` separately supplies its memory, disabled network setting, and VirtualBox OS type. To add an already prepared Linux system in text mode, add a complete entry to `systems` with paths to its RAW and VDI bases; no separate catalog is needed.

In the web page, click **Settings** to view the system values and their corresponding QEMU or VirtualBox arguments. The dialog also shows settings added by the server and the disk creation and launch commands. Before launch, these are a preview; after launch, the session's settings are displayed. To change settings, edit `config.json` before starting a new VM. The interface and system descriptions are in English.

The **QEMU · KVM / TCG** choice remains in the main toolbar. **QEMU · KVM** requires accessible `/dev/kvm` and fails with an error if KVM is unavailable or a VirtualBox VM is running. Select **QEMU · TCG** explicitly to use software emulation. Disk, serial-console, and monitor paths are generated at launch; the QCOW2 working disk format and control sockets are part of the demo's operation. Configuration changes apply to **new sessions**. **Reboot** and **Reset** retain the options selected when their tab first started.

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

Technically, the **current disk** mentioned in the interface is a *differential disk*: a per-VM QCOW2 overlay for QEMU or a per-VM VDI differencing image for VirtualBox. It stores only the VM's writes and depends on its read-only base image. **Resume** and **Reboot** reopen that same disk; **Reset** replaces it with a new one.

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

Linux x86_64 is required. The main dependencies on Debian/Ubuntu are:

| Purpose | Package or installation |
|---|---|
| Web server | `nodejs` (Node.js 18+), `npm` |
| QEMU virtual machines | `qemu-system-x86` or a custom QEMU build |
| Image overlays and conversion | `qemu-utils` (`qemu-img`) |
| Image preparation | `python3`; `genisoimage` for the Debian seed ISO |
| VDE LAN | `vde2` (`vde_switch`) |
| VirtualBox VMs | VirtualBox installation (`VBoxManage`) |

KVM speeds up QEMU when `/dev/kvm` is accessible; otherwise TCG is available. The current startup check requires all seven configured commands, including tools for optional features.

To compile QEMU with VDE support, run `./misc/install-qemu.sh /opt/`, then set its `bin/qemu-system-x86_64` path in `.env.local`. This build does not install `qemu-img`; use the separate `qemu-utils` package. See the [QEMU installer notes](misc/install-qemu.md) for the directory layout and build options.

## Installation and preparation

Install the standard command-line tools and the packages used for preparation and VDE networking:

```sh
sudo apt install bash coreutils findutils grep gzip curl nodejs npm python3 qemu-utils genisoimage vde2
```

Provide `qemu-system-x86_64` from `qemu-system-x86` or a custom build, and install VirtualBox to provide `VBoxManage` for the current startup check.

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

Open <http://127.0.0.1:3002>. The turquoise **+** creates a **New VM** tab. Choose a system and an engine, then click **Play**. A display name such as `debian13-00` is assigned at first launch; double-click the tab to change it. This name does not change the Linux hostname inside the VM. Numbering advances from 00 to 99 for each system during the server's lifetime. VMs in other tabs continue to run in parallel. Serial output and logs belong to each machine; check **Log** to display QEMU or VirtualBox commands. Login details appear above the terminal:

### Local VDE LAN prototype

Click **+ Switch** to create a switch tab, then **Play** to start `vde_switch`. Its command panel accepts VDE management commands such as `help` and `port/allprint`. In a new QEMU VM tab, click **+ Interface** before the first launch and select a running switch. Up to four interfaces can be added; Qemuweb assigns each one a VDE port and a MAC address. The guest chooses its own interface name: Debian 13 may show `enp0s2` rather than `eth0` (`ip link show` lists it). Start two VM tabs against the same switch to make a LAN. Configure IP addresses inside the guests to test communication. **Settings** shows the resulting QEMU launch arguments.

An interface assignment remains fixed across Stop and Resume. Stop connected VMs before stopping their switch; remove their tabs before deleting the switch. Hot attachment to a VM that is already running is planned in the [roadmap](docs/ROADMAP.md). VMs without a selected switch have no network adapter, and VirtualBox has no network adapter. This prototype creates no external network connection.

**QEMU · KVM** uses hardware acceleration and reports an error if `/dev/kvm` is missing or inaccessible, or if a VirtualBox VM is running. Choose **QEMU · TCG** explicitly to use slower software emulation or to run QEMU alongside VirtualBox. VirtualBox cannot start while a QEMU VM uses KVM; stop that VM or start it with TCG first.

By default, [config.json](config.json) selects `-cpu host` in KVM mode: QEMU exposes the CPU features that the host can provide to the VM. This avoids the `CPUID.80000001H:ECX.svm` warning that QEMU's default CPU model can produce on an Intel host: `svm` is the AMD virtualization feature and is not needed for these VMs. In TCG mode, the profile selects `-cpu qemu64`. This setting affects the virtual CPU, not the Debian image; VMs already running keep their configuration until their next launch.

- **Alpine Linux 3.24**: `root` with an empty password, or `toto` / `toto`; temporary working disk.
- **Debian 13**: `root` with no password; `toto` / `toto` or `demo` / `serial-demo`; temporary working disk.
- **OpenWrt 25.12 x86-64**: press Enter to open the `root` shell without a password; temporary working disk.

### VM actions

The toolbar icons come from [Lucide](https://lucide.dev/icons); their license is kept in [public/icons/LICENSE-lucide.txt](public/icons/LICENSE-lucide.txt). The README uses small, locally stored SVGs in `docs/icons/`, colored to match the interface. Each hint below is the text shown on hover. Actions apply only to the selected tab.

| Icon / control | Action | Hint | Effect |
|---|---|---|---|
| ![Play icon](docs/icons/play.svg) | **Start** | `Start VM from the base image` | Create a new working disk and boot the VM. |
| ![Play icon](docs/icons/play.svg) | **Resume** | `Resume VM from its current disk` | After Stop or a guest shutdown, boot from the same disk with the original system, engine, settings, and display name. This is a cold boot, not a saved-memory restore. |
| ![Power icon](docs/icons/power.svg) | **Stop** | `Stop VM and keep its current disk` | Request guest shutdown through QEMU's `system_powerdown` or VirtualBox's ACPI power button. If the guest does not stop within 10 seconds, force it off. Keep its disk, tab, logs, and display name. |
| ![Reboot icon](docs/icons/rotate-cw.svg) | **Reboot** | `Reboot VM with its current disk (keep changes)` | Stop and boot again from the same disk. Use the same forced-stop fallback if needed. Keep the tab and display name. |
| ![Reset icon](docs/icons/rotate-ccw.svg) | **Reset** | `Reset VM from the base image (discard changes)` | After a warning, stop the VM, delete its current disk, create a fresh one from the base image, and boot. Keep the tab and display name. |
| ![Exit icon](docs/icons/x.svg) | **Exit** | `Exit VM, delete its disk and close the tab` | Force-stop the VM, delete its disk, sockets, and logs, then close its tab. The red **X on the tab** has the same effect and hint. |
| ![Clear icon](docs/icons/eraser.svg) | **Clear** | `Clear console history and keep the current line` | Clear this tab's console history while preserving its current prompt or line. |
| ![Settings icon](docs/icons/sliders-horizontal.svg) | **Settings** | `View VM launch settings` | Show the selected system's configuration and launch commands in a read-only dialog. |
| ![New VM icon](docs/icons/plus.svg) | **New VM** | `Open a new VM tab` | Add an empty tab; the VM starts only after Start. |
| **Log** checkbox | **Log** | `Show or hide VM logs` | Show or hide the log; commands and output are recorded even while hidden. |
| **Monitor** checkbox | **Monitor** | `Show or hide the QEMU monitor` | Show or hide QEMU's command interface when a QEMU VM is running. |

A forced Stop can leave the guest filesystem needing repair on the next boot. Only the selected VM is affected by these actions; other tabs keep running.

### VM status

The badge at the right of the toolbar describes the selected tab:

| Status | Meaning |
|---|---|
| **NEW** | The tab has never started a VM; no current disk exists. |
| **STARTING** | Play is creating or opening the disk and starting the VM. |
| **RUNNING** | The VM process is running. |
| **STOPPING** | Stop is waiting for graceful shutdown or applying its forced-stop fallback. |
| **STOPPED** | The VM is off and its current disk is kept; Play resumes from that disk. |
| **REBOOTING** | The VM is stopping and starting again on the same disk. |
| **RESETTING** | The current disk is being replaced and the VM is starting from the base image. |
| **ERROR** | An action failed or the VM ended with an error. The error message appears under the toolbar; the disk is retained when it still exists. |

Exit removes the tab, so it has no persistent status. Stopping the server with Ctrl+C force-stops its VMs and removes their temporary sessions and working disks.

If port 3002 is already in use, stop the old server or choose another port:

```sh
PORT=3003 npm start
```

## Official images

- [Alpine Linux virt](https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/)
- [Debian cloud images](https://cloud.debian.org/images/cloud/)
- [OpenWrt x86-64 images](https://downloads.openwrt.org/releases/25.12.6/targets/x86/64/)
