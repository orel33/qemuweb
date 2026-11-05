# QemuWeb - beta

This demo runs Alpine Linux, Debian 13, or OpenWrt in QEMU or VirtualBox and relays the `ttyS0` serial console to xterm.js through a local web server.

## Software architecture overview

QemuWeb has three runtime layers: the browser interface, the Node.js server, and the local virtualization processes. The browser never connects directly to QEMU, VirtualBox, `vde_switch`, or a Unix socket. `server.js` owns the processes and runtime files, exposes the HTTP API, and relays interactive streams through Socket.IO.

```text
Browser: public/index.html
  xterm.js, tabs, VM/switch controls, logs, QEMU monitor
                         │
               HTTP API │ Socket.IO
                         ▼
Node.js: server.js
  Express API, session state, process lifecycle, stream relays
          │                    │                    │
          ▼                    ▼                    ▼
  QEMU / VirtualBox       vde_switch          runtime files
  virtual machines        + vdeterm           disks and sockets
```

The toolbar's **System** and **Engine** selections determine how a VM session enters this architecture:

```text
Browser selection
  System: Alpine / Debian 13 / Debian 13 Legacy / OpenWrt
  Engine: QEMU · KVM / QEMU · TCG / VirtualBox
                              │
                              ▼
                         config.json
                 system profile + engine options
                              │
                 ┌────────────┴────────────┐
                 ▼                         ▼
          QEMU execution path       VirtualBox execution path
          RAW → QCOW2 disk          VDI → differential VDI
          KVM or TCG                VBoxManage
          HMP monitor               no web monitor
          VDE networking            networking disabled for now
                 │                         │
                 └────────────┬────────────┘
                              ▼
                    Unix serial socket
                              ▼
              server.js ↔ Socket.IO ↔ xterm.js
```

The VDE switch is a first-class session parallel to a VM session. It has no **System** or **Engine** selector because it is neither a guest OS nor a virtual machine:

```text
                         Browser switch tab
              Play / Stop                 xterm.js
                   │                         ↕
              HTTP API                  Socket.IO
                   │                         ↕
                   └────── server.js switch session ──────┐
                               │                           │
                         process control              terminal relay
                               │                           ↕
                               │                        node-pty
                               │                           ↕
                               │                        vdeterm
                               │                           ↕
                               │             management Unix socket (-M)
                               ▼                           ↕
                         vde_switch ◀──────────────────────┘
                               ↕
                       VDE data socket (-s)
                               ↕
                    QEMU VDE NICs / guest LAN
```

The switch's HTTP path creates, starts, stops or removes the `vde_switch` process. Its Socket.IO path remains open for the interactive `vdeterm` terminal. The lower `-s` path is the Ethernet data plane shared by the QEMU NICs; it operates independently from the `-M` management console.

The engine changes the virtualization backend, disk implementation and available control channels:

| Engine | Execution and disk | Serial console | Monitor | VDE networking |
|---|---|---|---|---|
| **QEMU · KVM** | `qemu-system-x86_64` with hardware acceleration; QCOW2 working disk backed by RAW | QEMU Unix serial socket | QEMU HMP socket | Supported |
| **QEMU · TCG** | Same QEMU path with software CPU emulation; same QCOW2/RAW disk model | QEMU Unix serial socket | QEMU HMP socket | Supported |
| **VirtualBox** | `VBoxManage`; differential VDI working disk backed by the prepared VDI | VirtualBox server-mode UART socket | Not exposed by QemuWeb | Disabled in the current prototype |

KVM and TCG therefore share the same application architecture; only QEMU's acceleration mode changes. VirtualBox follows a different process and disk-management path, but converges on the same serial-console relay used by xterm.js.

The system selection does not introduce another software layer. It selects a declarative profile from `config.json`; the server combines that profile with QEMU defaults or VirtualBox settings:

| System profile | QEMU disk bus | QEMU network model | Memory | Architectural requirement |
|---|---|---|---:|---|
| **Alpine Linux 3.24** | VirtIO | `virtio-net-pci` | 512 MiB | Prepared boot and login on `ttyS0` |
| **Debian 13** | VirtIO | `virtio-net-pci` | 1024 MiB | Prepared GRUB boot and login on `ttyS0` |
| **Debian 13 Legacy** | IDE | `e1000` | 1024 MiB | Legacy disk/NIC drivers; consoles on `tty0` and `ttyS0` |
| **OpenWrt 25.12** | VirtIO | `virtio-net-pci` | 256 MiB | Text shell on `ttyS0` |

Every profile provides a RAW base for QEMU and a prepared VDI base for VirtualBox. Its guest-side drivers and serial configuration must match the selected virtual hardware, but all systems use the same browser, API, session and console components.

The interactive paths are deliberately different because each endpoint provides a different interface:

| Interactive element | Data path | Purpose |
|---|---|---|
| QEMU VM console | `xterm.js ↔ Socket.IO ↔ server.js ↔ Unix serial socket ↔ QEMU UART ↔ guest ttyS0` | Display kernel output and provide the guest's `login:` prompt and shell. |
| VirtualBox VM console | `xterm.js ↔ Socket.IO ↔ server.js ↔ Unix serial socket ↔ VirtualBox UART ↔ guest ttyS0` | Provide the same guest console through VirtualBox's server-mode virtual UART. |
| VDE switch terminal | `xterm.js ↔ Socket.IO ↔ server.js ↔ node-pty ↔ vdeterm ↔ VDE management socket ↔ vde_switch` | Provide the interactive VDE prompt, including line editing, history, completion and asynchronous switch messages. |
| QEMU monitor | `Monitor form ↔ HTTP/JSON ↔ server.js ↔ Unix monitor socket ↔ QEMU HMP` | Send emulator commands such as `info status`; this controls QEMU and is not a guest shell. |
| Start, Stop, Reboot, Reset and Exit | `Toolbar ↔ HTTP/JSON ↔ server.js ↔ process/VBoxManage control` | Manage one VM or switch session and its working files. |
| Logs and status | `server.js ↔ Socket.IO ↔ selected browser tab` | Keep launch commands, process messages, console state and lifecycle state associated with the correct tab. |

`node-pty` is required only on the switch path. A VM exposes a byte-oriented serial socket that Node can relay directly. `vdeterm`, by contrast, is a terminal application: the pseudo-terminal gives it the TTY behavior needed for prompts, arrow keys, command history, completion and terminal resizing.

VDE uses two separate paths:

```text
Interactive management:
xterm.js ↔ Socket.IO ↔ node-pty ↔ vdeterm ↔ management socket (-M) ↔ vde_switch

Virtual Ethernet traffic:
guest NIC ↔ QEMU -netdev vde ↔ VDE data socket (-s) ↔ vde_switch ↔ another guest NIC
```

The management path carries switch commands; it carries no guest network packets. Conversely, the VDE data socket transports Ethernet frames and is not a command console.

Offline image preparation is separate from runtime execution. `prepare.sh` and `scripts/prepare/` build reusable base images under `images/`. At runtime, `server.js` reads [config.json](config.json), creates per-session disks and Unix sockets under `runtime/`, and never modifies the base images. Current session state and bounded console transcripts are kept in server memory; working disks and sockets disappear when their session is deleted or the server performs its cleanup.

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

`prepare.sh` reads the IDs under `systems` in `config.json` and invokes the matching `scripts/prepare/<id>.sh`. Shared helpers are alongside these scripts. Each target keeps its downloads and checksums in `sources/<id>/`:

- **Alpine**: the script downloads and verifies the official `virt` ISO, installs it unattended into a RAW image, prepares the `root` and `toto` accounts, configures boot output and login on `ttyS0`, then produces the VDI base for VirtualBox.
- **Debian 13**: the script downloads and verifies the official cloud image, boots it once in an isolated temporary QEMU VM, prepares the `root`, `toto`, and `demo` accounts, configures serial access and DHCP networking, disables cloud-init for subsequent boots, then produces a read-only RAW image.
- **Debian 13 Legacy**: a separate image installs the general Debian kernel plus `iproute2`, `tcpdump`, `iputils-ping`, `bash`, `net-tools`, `procps`, and `vim-tiny`. It boots from IDE with `root=/dev/sda1`, presents an `e1000` NIC, and enables consoles on `tty0` and `ttyS0`.
- **OpenWrt**: the script verifies and decompresses the official RAW image.
- For **VirtualBox**, the script converts each RAW image into a read-only VDI base.

At launch, the server performs no further system configuration: QEMU creates a QCOW2 working disk based on the RAW image; VirtualBox creates a VDI working disk based on the prepared VDI. Each instance has its own writes. They are retained by **Stop**, **Play / Resume**, and **Reboot**, then discarded by **Reset**, **Exit**, or server shutdown. The base files in `images/` are never modified.

`images/` contains ready-to-run base images named after the system identifier: `alpine.raw` / `alpine.vdi`, `debian13.raw` / `debian13.vdi`, `debian13-legacy.raw` / `debian13-legacy.vdi`, and `openwrt.raw` / `openwrt.vdi`. The `.raw` extension explicitly identifies the disk format. `sources/<id>/` keeps each target's downloads and checksums; `runtime/` contains temporary files and VM differential disks. [config.json](config.json) describes the systems and their launch options; preparation scripts read it but do not overwrite it.

### System configuration

Command paths live in [`.env`](.env) (the tracked defaults) and `.env.local` (machine-specific overrides, ignored by Git), separate from [config.json](config.json). `.env` gives each command its default executable name, searched in `PATH`, for example `QEMU_SYSTEM_X86_64=qemu-system-x86_64`. To override one, put `NAME=/absolute/path/to/executable` in `.env.local`. A nonempty `.env.local` value takes priority over the process environment and `.env`. For example:

```sh
QEMU_SYSTEM_X86_64=/opt/qemu-11.1.3/bin/qemu-system-x86_64
```

At startup, the server checks the configured commands, prints a green check or red cross for each, and exits if any check fails. It uses the resolved QEMU, `qemu-img`, and `VBoxManage` paths. `npm start` still launches Node from `PATH`; image preparation and cleanup scripts also still use `PATH`.

[config.json](config.json) follows the same approach as [qemunet.cfg](https://github.com/orel33/qemunet/blob/master/qemunet.cfg): each key under `systems` (`alpine`, `debian13`, `debian13-legacy`, `openwrt`) identifies a system and its `scripts/prepare/<id>.sh` script. Each entry contains its `linux` type, `text` mode, label and long description, login details, `images.raw` and `images.vdi` paths, system-specific QEMU options, and VirtualBox settings. Paths can be relative to the project root or absolute. Launching relies on this file; `server.js` contains no rules tied to an OS name.

`qemu.defaults` supplies common values. The `rtcBase` value is either `utc` (the Linux-friendly default, emitted as `-rtc base=utc`) or `localtime` (emitted as `-rtc base=localtime`); a system can override it in `systems.<id>.qemu`. The `systems.<id>.qemu` object contains only overrides: Debian 13 requests 1,024 MiB, OpenWrt requests 256 MiB, and Alpine inherits the defaults. All profiles have external networking disabled. `systems.<id>.virtualbox` separately supplies its memory, disabled network setting, and VirtualBox OS type. To add an already prepared Linux system in text mode, add a complete entry to `systems` with paths to its RAW and VDI bases; no separate catalog is needed.

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
| VDE LAN and interactive console | `vde2` (`vde_switch`, `vdeterm`); `node-pty` is installed by npm |
| VirtualBox VMs | VirtualBox installation (`VBoxManage`) |

KVM speeds up QEMU when `/dev/kvm` is accessible; otherwise TCG is available. The current startup check requires all eight configured commands, including `vde_switch` and `vdeterm` for VDE networking.

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

Each `scripts/prepare/<id>.sh` places that system's downloaded sources in `sources/<id>/` and its final `<id>.raw` and `<id>.vdi` bases in `images/`. The orchestrator checks that every path declared in `config.json` exists but does not rewrite the file. The page's system menu is populated directly from `config.json`. `runtime/` is reserved for temporary preparation and VM files. These directories are ignored by Git, except for their `.gitkeep` files.

## Running the demo

```sh
npm start
```

Open <http://127.0.0.1:3002>. The turquoise **+** creates a **New VM** tab. Choose a system and an engine, then click **Play**. A display name such as `debian13-00` is assigned at first launch; double-click the tab to change it. This name does not change the Linux hostname inside the VM. Numbering advances from 00 to 99 for each system during the server's lifetime. VMs in other tabs continue to run in parallel. Serial output and logs belong to each machine; check **Log** to display QEMU or VirtualBox commands. Login details appear above the terminal:

### Local VDE LAN prototype

New QEMU VM tabs start with one disconnected Ethernet card. Before the first launch, use **+ Interface** to add up to four cards, remove unwanted cards, or select a running VDE switch for each card. Click **+ Switch**, then **Play** to start `vde_switch` and its interactive `vdeterm` console in xterm.js. Commands such as `help` and `port/allprint`, command history, completion and asynchronous VDE messages use the persistent terminal session. Each card has its own MAC address; connected cards also receive a VDE port. Debian Legacy uses `e1000`, while Debian cloud uses `virtio-net-pci`. The guest chooses its own interface name: Debian may show `enp0s2` rather than `eth0` (`ip link show` lists it). Start two VM tabs against the same switch to make a LAN and configure IP addresses inside the guests. **Settings** shows the resulting QEMU launch arguments.

For the guest kernel and image requirements behind the disk and NIC choices, see [QEMU guest buses and drivers](docs/qemu-guest-bus-and-drivers.md).

The Debian 13 cloud profile uses a VirtIO disk and VirtIO network cards. **Debian 13 Legacy** is the separate IDE + `e1000` target, with `tty0`, `ttyS0`, and `root=/dev/sda1` configured by default.

An interface assignment remains fixed across Stop and Resume. Stop connected VMs before stopping their switch; remove their tabs before deleting the switch. Hot attachment to a VM that is already running is planned in the [roadmap](docs/ROADMAP.md). Disconnected cards remain visible inside the guest but cannot exchange traffic. Removing every card creates a VM without Ethernet; VirtualBox also has no network adapter. QEMU's `-nic none` disables its implicit network adapter; the explicit `-device e1000` or `-device virtio-net-pci` options still create the selected cards. This prototype creates no external network connection.

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
| ![Reset icon](docs/icons/rotate-ccw.svg) | **Reset** | `Reset VM from the base image (discard changes)` | After a QemuWeb warning dialog, stop the VM, delete its current disk, create a fresh one from the base image, and boot. Keep the tab and display name. |
| ![Exit icon](docs/icons/x.svg) | **Exit** | `Exit VM, delete its disk and close the tab` | After a QemuWeb warning dialog, force-stop the VM, delete its disk, sockets, and logs, then close its tab. The red **X on the tab** asks for the same confirmation. |
| ![Clear icon](docs/icons/eraser.svg) | **Clear** | `Clear console history and keep the current line` | Clear this tab's console history while preserving its current prompt or line. |
| ![Settings icon](docs/icons/sliders-horizontal.svg) | **Settings** | `View VM launch settings` | Show the selected system's configuration and launch commands in a read-only dialog. |
| ![New host icon](docs/icons/plus.svg) | **New host** | `Add a VM host` | Add a VM tab. The VM starts only after Start. |
| ![New switch icon](docs/icons/network-plus.svg) | **New switch** | `Add a VDE switch` | Add a VDE switch tab; start its switch process from that tab. |
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
