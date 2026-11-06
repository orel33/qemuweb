# TODO

QemuWeb work to plan and implement. See the [roadmap](docs/ROADMAP.md) for the longer migration sequence. Task codes are stable random identifiers: add new codes without changing existing ones.

## LANs and topology

- [ ] **FQJ27** — Record a repeatable two-host Debian 13 Legacy LAN check: switch ports, static IPs, bidirectional ping, and Stop/Resume.
- [ ] **NVT64** — Define a network model and API for a switch and its hosts, including stable IDs, port assignments, and an isolated runtime directory.
- [ ] **KRP13** — Group console pages by LAN and switch, instead of paging through individual sessions in creation order.
- [ ] **ZMX82** — Allow a switch to appear in a LAN without displaying its management console.
- [ ] **BHW45** — Save and load a network topology in JSON format.
- [ ] **TCG09** — Add a graphical view of the network topology.
- [ ] **YLD71** — Make the graphical topology interactive.
- [ ] **PSA36** — Add whole-network Start and Stop actions with partial-start cleanup; extend the lifecycle to Resume, Reset and Delete in the durable-session stage.
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
  - Move the **Clone** icon to the bottom-right action area and clone the currently selected item.
  - Show a minimal dialog containing only the proposed editable clone name and the **Autostart** checkbox.
  - For a host, add a checkbox before **Autostart** to optionally copy its network interfaces and reconnect them to the same switches, while always assigning new ports and MAC addresses.
- [ ] **GTS16** — Explore user-editable guest startup scripts, with defaults supplied by `config.json` if useful.
- [ ] **LQF75** — Explore predefined host roles: lightweight terminal, web server, gateway, DNS server and DHCP server, plus a ready-made LAN with several hosts and a preset network address.
- [ ] **CMZ38** — Define image-specific metadata in `config.json`, make the relevant values editable in the UI, and inject the resulting configuration into the VM at launch.
- [ ] **HNK52** — Explore graphical guests through VNC.

## Console and monitor

- [x] **VBR06** — Put the console/monitor toggle in the toolbar directly above the terminal, and render the QEMU monitor in that same terminal area so the user switches between the serial console and monitor in place.

## Traffic and resource diagnostics

- [ ] **SXP84** — Capture traffic on network links as PCAP files.
- [ ] **ADF29** — Investigate Wireshark or `tshark` integration for inspecting captures.
- [ ] **MJL63** — Obtain per-VM CPU and RAM usage metrics and display them in the UI.

## Server and deployment

- [ ] **URK47** — Extend startup checks into per-engine capability reports for QEMU/KVM, QEMU/TCG, QEMU/VDE, and VirtualBox.
- [ ] **EZY15** — For the beta release, evaluate isolated concurrent sessions for anonymous users before production authentication is available.
