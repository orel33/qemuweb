# TODO

Next work for the QemuWeb LAN migration. See [the roadmap](docs/ROADMAP.md) for later stages.

- [ ] Record a repeatable two-host Debian 13 Legacy LAN check: switch ports, static IPs, bidirectional ping, and Stop/Resume.
- [ ] Define a network model and API for a switch and its hosts, including stable IDs, port assignments, and an isolated runtime directory.
- [ ] Add whole-network Start and Stop actions with partial-start cleanup; extend the lifecycle to Resume, Reset and Delete in the durable-session stage.
- [ ] Extend startup checks into per-engine capability reports for QEMU/KVM, QEMU/TCG, QEMU/VDE, and VirtualBox.
