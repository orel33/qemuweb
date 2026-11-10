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
- [x] **GTS16** — **v0.4.0, Debian 13 Legacy under QEMU:** deliver a per-host, read-only ISO containing `start.sh` and optional companion resources. The guest mounts it at `/mnt/cdrom` and executes the script near the end of boot; the script never runs on the Web server.
  - Edit or import `start.sh` in Host Settings, save it implicitly in this browser's `localStorage`, and use one checkbox to build and attach a fresh ISO before Start/Resume/Reboot/Reset. Show the ISO creation command in the Host Log before disk and QEMU launch.
  - Prepare the Debian 13 Legacy RAW/VDI pair with a late boot systemd hook. Validate the script and companion resources in two LAN2 hosts, Stop/Resume, edited script after Reboot, and preserved working disk state. Missing media or script fails promptly without blocking login; the guest journal keeps script output and exit status.
- [ ] **NQX72** — Debian 13 Cloud, Alpine and OpenWrt RAW/VDI bases have been rebuilt with their guest startup hooks and installed locally after an overlay audit; previous bases are backed up. Under QEMU, verify each guest boots with a per-host `QWEBSTART` ISO, runs `start.sh` and reads a companion resource by relative path. Check that missing media or script reports an error without blocking login, that ISO content remains isolated per host, and that edits after Reboot and disk state after Resume behave as documented. The integration test has not yet been run.
- [ ] **VBH54** — Validate the startup ISO with Debian 13 Legacy under VirtualBox, then extend the same boot, resource, missing-media, Reboot and Resume scenarios to the other prepared guests. Record host hypervisor constraints and fix any engine-specific attachment or refresh failures.
- [ ] **FUR92** — Make `runtime/<session-id>/<host-id>/startup/` the source of the host's startup CD-ROM contents. Remove the `guestMedia` script and companion-file content from `host.json`; keep only startup options such as automatic ISO attachment there.
  - Create `startup/` for each host. On **OK** in Host Settings, save the edited or imported `start.sh` there on the server; **Cancel** must leave the existing file unchanged. For now, `start.sh` remains the only startup file editable in the Web interface.
  - Build the ISO from every regular file under `startup/`, preserving relative subdirectories. A file added there outside the Web interface must appear on the next rebuilt CD-ROM; reject symlinks, unsafe paths and files exceeding the existing startup-media limits. Keep each host's files isolated and leave the generated ISO and sockets outside `startup/`.
  - Preserve existing companion files when the Web editor saves `start.sh`. Migrate any existing `guestMedia` content to `startup/` before removing it from `host.json`, and keep the Host Settings API transactional. Later in this task, add a companion-file editor for relative paths and verify that edits appear on the next launch. Milestone 1 implements the directory source, migration and script-only Web save; the companion-file editor remains open.
- [ ] **LQF75** — Explore predefined host roles: lightweight terminal, web server, gateway, DNS server and DHCP server, plus a ready-made LAN with several hosts and a preset network address.
- [x] **CMZ38** — **v0.5.0:** clarify the configuration layers and make **Host Settings** a transactional editor for each host:
  - Keep the engine choice (QEMU/KVM, QEMU/TCG or VirtualBox) common to the current application session in **General Settings**. Save it and the other session-wide choices in `runtime/<session-id>/session.json`; define explicitly which UI-only preferences, if any, remain browser-local. Do not silently change the engine for only newly created hosts within an existing session.
  - Use `config.json` as the system catalog and source of defaults. Show image-constrained values such as system ID, description, login hint, base image, disk bus and network-card model as read-only. Classify QEMU machine type (currently `q35`) and the VirtualBox guest profile explicitly as engine-specific, launch-time profile values.
  - Keep editable per-host overrides for CPU count, memory, clock, startup media and QEMU network connections separate from system defaults. Give each host its own configuration keyed by host ID; editing one host must never change the defaults offered to a later host of the same system. Derive QCOW2, ISO and socket paths on the server from the session and host IDs, and show generated paths read-only in Expert rather than storing them as user overrides.
  - In **Host Settings**, stage edits until **OK** and discard them on **Cancel**. On **OK**, validate and send the whole host configuration to the server, then save it in `runtime/<session-id>/<host-id>/host.json`; do not use `localStorage` as the source of truth for host settings. The Web host name may update immediately, but CPU, memory, clock, startup media and network connections edited while a host runs take effect on its next Start/Resume/Reboot/Reset. Offer **Restart automatically** and a now/later choice for changed launch settings on a running host; a stopped host applies them on its next Play. Preserve the working disk and unchanged MAC/port assignments across an ordinary reboot.
  - Save switch configuration separately in `runtime/<session-id>/<switch-id>/switch.json`. Use a stable session ID independent of the server PID, and record IDs and references in the main `session.json`. Write these JSON files safely and keep their declarative settings distinct from generated sockets and other ephemeral process state. This file layout prepares full-session save/reload; actual restoration of hosts, switches and working disks after a server restart remains the durable-session roadmap stage.
  - Keep live QEMU NIC hotplug as the separate roadmap stage: editing network connections during execution in CMZ38 schedules them for the next guest start. Do not present VirtualBox VDE cabling as available until its engine support exists. Validate and document the effective settings and engine-specific limitations for both QEMU and VirtualBox.
  - Keep `config.json`, the session JSON files, `.topo` and generated runtime files distinct. Update the README's obsolete `rtcBase`/memory examples and launch-setting lifecycle description.
  - Implementation and static review are complete through beta 6; the user reported a successful manual check. Automated tests were not run by Codex, and VirtualBox guest validation remains tracked separately in **VBH54**.
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
