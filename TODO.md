# TODO

QemuWeb work to plan and implement. See the [roadmap](docs/ROADMAP.md) for the longer migration sequence.

## LANs and topology

- [ ] Record a repeatable two-host Debian 13 Legacy LAN check: switch ports, static IPs, bidirectional ping, and Stop/Resume.
- [ ] Define a network model and API for a switch and its hosts, including stable IDs, port assignments, and an isolated runtime directory.
- [ ] Group console pages by LAN and switch, instead of paging through individual sessions in creation order.
- [ ] Allow a switch to appear in a LAN without displaying its management console.
- [ ] Save and load a network topology in JSON format.
- [ ] Add a graphical view of the network topology.
- [ ] Make the graphical topology interactive.
- [ ] Add whole-network Start and Stop actions with partial-start cleanup; extend the lifecycle to Resume, Reset and Delete in the durable-session stage.
- [ ] Prepare the topologies needed for TP6.

## Hosts and settings

- [x] Generate unique default host names from women's first names common around 1900.
- [x] Keep Settings concise by default and reveal technical fields in an Expert mode.
- [x] Allow QEMU or VirtualBox to be selected in general Settings.
- [ ] Explore user-editable guest startup scripts, with defaults supplied by `config.json` if useful.
- [ ] Explore predefined host roles: lightweight terminal, web server, gateway, DNS server and DHCP server, plus a ready-made LAN with several hosts and a preset network address.
- [ ] Define image-specific metadata in `config.json`, make the relevant values editable in the UI, and inject the resulting configuration into the VM at launch.
- [ ] Explore graphical guests through VNC.

## Traffic and resource diagnostics

- [ ] Capture traffic on network links as PCAP files.
- [ ] Investigate Wireshark or `tshark` integration for inspecting captures.
- [ ] Obtain per-VM CPU and RAM usage metrics and display them in the UI.

## Server and deployment

- [ ] Extend startup checks into per-engine capability reports for QEMU/KVM, QEMU/TCG, QEMU/VDE, and VirtualBox.
- [ ] For the beta release, evaluate isolated concurrent sessions for anonymous users before production authentication is available.
