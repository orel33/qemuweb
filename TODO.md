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
  - [ ] **TCG09** — Show the loaded network as a graphical topology.
  - [ ] **YLD71** — Make the graphical topology interactive so edits can be saved back to `.topo`.
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
- [ ] **GTS16** — Explore user-editable guest startup scripts, with defaults supplied by `config.json` if useful.
- [ ] **LQF75** — Explore predefined host roles: lightweight terminal, web server, gateway, DNS server and DHCP server, plus a ready-made LAN with several hosts and a preset network address.
- [ ] **CMZ38** — Define image-specific metadata in `config.json`, make the relevant values editable in the UI, and inject the resulting configuration into the VM at launch.
- [ ] **HNK52** — Explore graphical guests through VNC.

## Console and monitor

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
- [ ] **EZY15** — For the beta release, evaluate isolated concurrent sessions for anonymous users before production authentication is available.
