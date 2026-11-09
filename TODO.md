# TODO

QemuWeb work to plan and implement. See the [roadmap](docs/ROADMAP.md) for the longer migration sequence. Task codes are stable random identifiers: add new codes without changing existing ones.

## LANs and topology

- [x] **FQJ27** — Record a repeatable two-host Debian 13 Legacy LAN check: switch ports, static IPs, bidirectional ping, and Stop/Resume.
- [x] **KPT46** — Add the repeatable LAN2 integration test for Debian 13 Legacy, covering switch ports and MACs, serial login, bidirectional ping, and Stop/Resume.
- [x] **BHW45** — Load and save supported network topologies in the Web app as `.topo` files, separate from `config.json` and referring to system IDs declared in `config.json`:
  - Start with QemuNet's `SWITCH <name>` and `HOST <system-id> <name> [switch-name ...]` lines, plus comments and blank lines. The order of switches on a `HOST` line is the order of its Ethernet interfaces. Use the adapted local examples `topo/lan.topo` and `topo/gw.topo`, based on the sibling project's `demo/lan.topo` and `demo/gw.topo`.
  - Validate the entire file before creating any sessions: syntax, duplicate names, known system IDs, existing switch references and interface limits. Reject old IDs such as `debian` unless they are declared in `config.json`. Reject unsupported legacy directives with a clear message; parse `.topo` as data, never as shell code.
  - Save the current network back to a normalized `.topo` file and reload it with the same hosts, switches and ordered links. Keep image paths, executable settings, runtime state and disk overlays out of the topology file.
  - [ ] **NVT64** — Define the network model and API for a switch and its hosts, with internal stable IDs, port assignments and an isolated runtime directory.
  - [ ] **KRP13** — Group console pages by LAN and switch, instead of paging through individual sessions in creation order.
  - [ ] **ZMX82** — Allow a switch to appear in a LAN without displaying its management console.
  - [x] **TCG09** — **v0.3.0 graphical overview:** add a top-right button that switches between the current **Terminals** view and a new **Graphic** view without changing running sessions.
    - Draw every host and switch as a named node, with one distinct SVG Bézier link for each connected Ethernet interface. Show useful status and interface/switch information, including multiple links between the same nodes.
    - Clicking a node selects its session and opens its terminal view. Fit the loaded `topo/lan.topo` and `topo/gw.topo` examples, handle an empty network, and keep the graph in sync when sessions are added, removed, renamed or started/stopped.
    - Use `backup/legacy-qemuweb-2026-11-03:frontend/src/components/Drawflow.vue`, its Host/Switch node components and `frontend/src/style.css` as visual references within the current Web app.
  - [ ] **YLD71** — **After v0.3.0:** extend the draggable graphical overview with host-to-switch link editing, validate changes against the current interface rules, and save the resulting hosts, switches and ordered links back to the existing `.topo` format. Decide how to persist node positions separately from `.topo`; they currently last for the browser session only. Keep runtime-only state and disk overlays out of the file.
  - [ ] **PSA36** — Add whole-network Start and Stop with partial-start cleanup; extend the lifecycle to Resume, Reset and Delete in the durable-session stage.
- [ ] **WEX58** — Prepare the topologies needed for TP6.

## Hosts and settings

- [x] **JUK24** — Generate unique default host names from women's first names common around 1900.
- [x] **RNC67** — Keep Settings concise by default and reveal technical fields in an Expert mode.
- [x] **DPM41** — Allow QEMU or VirtualBox to be selected in general Settings.
- [x] **XVA93** — Consolidate host creation and network configuration in **Host Settings**:
  - Keep the host settings button, rename it **Host Settings**, and use the same title for its dialog.
  - Remove the **Network Settings** button and move its dialog content into the **Network interfaces** section of **Host Settings**.
  - Make **Add a new host** open exactly the same **Host Settings** dialog, with Expert mode initially disabled.
- [x] **PUD84** — Simplify cloning around the currently selected host or switch:
  - Place the **Clone** icon last in the bottom-left action group and clone the currently selected item.
  - Show a minimal dialog containing only the proposed editable clone name and the **Autostart** checkbox.
  - For a host, add a checkbox before **Autostart** to optionally copy its network interfaces and reconnect them to the same switches, while always assigning new ports and MAC addresses.
- [ ] **GTS16** — **v0.4.0:** deliver a per-host, read-only ISO containing `start.sh` and optional companion resources. The guest mounts it at `/mnt/cdrom` and runs `/mnt/cdrom/start.sh` near the end of each boot. Execute the script in the guest only, never on the Web server or a runner.
  - [x] **Debian 13 Legacy first validation:** integrate the editor, ISO and guest service; install a prepared RAW/VDI pair; verify LAN2 with two distinct scripts/resources, Stop/Resume, edited script after Reboot and preserved disk state.
  - [ ] **Complete GTS16:** verify an actual guest boot and `start.sh` execution under VirtualBox, then install or migrate the prepared bases for Debian 13 Cloud, Alpine and OpenWrt in the main environment. Their QEMU guest boots and ISO resources have passed in the isolated worktree.
  - Add an editor and file upload for `start.sh` in Host Settings, plus a way to add/remove companion files while preserving their relative paths on the ISO. Keep these files in host/session state, outside `.topo` and base images; validate names, paths and sizes and isolate each host's ISO. Build and attach the ISO for QEMU and VirtualBox before Start/Resume; make saved changes available on the next guest boot, including Reboot. Do not modify an ISO while it is attached to a running VM.
  - Prepare **every configured OS image** to use this contract. Install and enable a late boot `systemd` service in `debian13-legacy` and `debian13-cloud`; use the native init mechanism in Alpine and OpenWrt, which do not use systemd. Mount by a stable ISO label, read-only, with a short bounded wait. If the ISO or `start.sh` is missing, report a clear error immediately and continue booting; report the script's output and exit code in guest logs/serial console. Support manually restarting the guest hook for a hot run after refreshing/remounting the ISO.
  - Update the image preparation scripts and provide a documented rebuild or migration path for existing raw/VDI bases. Verify all four prepared OS profiles, both QEMU and VirtualBox media attachment, companion resource access, and LAN2 hostnames/static IPs after boot and after a script edit plus Reboot; preserve guest disk state on Resume.
- [ ] **LQF75** — Explore predefined host roles: lightweight terminal, web server, gateway, DNS server and DHCP server, plus a ready-made LAN with several hosts and a preset network address.
- [ ] **CMZ38** — Define image-specific metadata in `config.json`, make the relevant values editable in the UI, and inject the resulting configuration into the VM at launch.
- [ ] **HNK52** — Explore graphical guests through VNC.

## Console and monitor

- [x] **JRX42** — Add font family and font size controls to General Settings and apply them consistently to Host/Switch Console, Log and Monitor through shared CSS variables.
- [x] **VBR06** — Put the console/monitor toggle in the toolbar directly above the terminal, and render the QEMU monitor in that same terminal area so the user switches between the serial console and monitor in place.
- [x] **LWX29** — Integrate session logs as a third terminal view alongside Console and Monitor:
  - Replace the global Log button and dialog with an in-place Log view in each console pane.
  - Provide Console, Monitor and Log controls with distinct Lucide icons: **SquareTerminal**, **MonitorCog** and **FileText**.
  - Offer Console and Log for switches and VirtualBox hosts; offer Console, Monitor and Log for QEMU hosts.
  - Reuse the current xterm area for all views, keep Log read-only, and update it as new session log lines arrive.

## Traffic and resource diagnostics

- [ ] **SXP84** — Capture traffic on network links as PCAP files.
- [ ] **ADF29** — Investigate Wireshark or `tshark` integration for inspecting captures.
- [x] **MJL63** — Obtain per-VM CPU and RAM usage metrics and display them in the UI.

## Server and deployment

- [ ] **URK47** — Extend startup checks into per-engine capability reports for QEMU/KVM, QEMU/TCG, QEMU/VDE, and VirtualBox.
- [ ] **KYP59** — Move VM and VDE execution to a remote Linux runner, separate from the Web controller, in the style of a GitLab Runner:
  - Start with one authenticated runner that registers with the controller, reports engine/image capabilities, and owns QEMU/VDE processes, overlays, runtime directories and Unix sockets. Place every host and switch of a LAN on the same runner.
  - Route lifecycle commands, serial consoles, QEMU monitors, switch terminals, logs and CPU/RAM metrics through the controller. Keep worker paths and sockets off the browser network; use stable network/session IDs and idempotent commands.
  - Preserve running LANs across browser disconnects, report runner loss clearly, and reconnect/reconcile state after controller or runner restart. Prove the design with the existing LAN2 scenario from a browser on a different machine; add multi-runner scheduling only afterward.
- [ ] **EZY15** — For the beta release, evaluate isolated concurrent sessions for anonymous users before production authentication is available.
