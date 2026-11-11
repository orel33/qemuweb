# Prepared image contract

This document collects the intended invariants of the four reusable guest
images. The executable rules live in `scripts/prepare/<system>.sh`, the shared
guest hook in `scripts/prepare/resources/guest-start.sh`, and the hardware
profiles in `config.json`. A prepared image is a template, not an already
identified host.

## Common rules

- Each system is an x86-64 Linux text guest with a serial login on `ttyS0`.
  QemuWeb connects that port to the Web console. The prepared images permit
  passwordless `root` login for the isolated lab.
- The canonical base is `images/<system>.raw`; preparation derives a matching
  VDI for VirtualBox. Runtime writes go to a separate QCOW2 or differential
  VDI for each host, leaving the base unchanged.
- `/etc/machine-id` is **empty in every newly built base**. Debian also has
  `/var/lib/dbus/machine-id -> /etc/machine-id`. At first boot, systemd fills
  the Debian ID; the common guest hook fills it on Alpine and OpenWrt. The
  resulting ID stays in that host's working disk across ordinary reboots.
- The guest hook mounts the QemuWeb startup CD-ROM at `/mnt/cdrom` and runs
  `start.sh` if present. Its default template sets the runtime hostname with
  `hostname @HOSTNAME@`; the ISO builder substitutes the host name when it
  builds the CD-ROM. The prepared base keeps `qemuweb` as its initial name.
- A VDE switch supplies Ethernet connectivity only. It does not assign an IP
  address. Static addressing inside each guest is the current LAN workflow.

## Per-system rules

| System | QEMU disk / NIC | Guest LAN interface | Prepared network behavior | Machine ID at first host boot |
|---|---|---|---|---|
| Debian 13 Legacy | IDE / `e1000` | `eth0`, then `eth1`… | `net.ifnames=0`; `systemd-networkd` requests DHCP on `eth*`; a static address can be set inside the guest | systemd |
| Debian 13 Cloud | VirtIO / `virtio-net-pci` | `eth0`, then `eth1`… | `net.ifnames=0`; `systemd-networkd` requests DHCP on `eth*`; cloud-init is disabled after image preparation | systemd |
| Alpine | VirtIO / `virtio-net-pci` | `eth0` | `/etc/network/interfaces` requests DHCP on `eth0` | guest hook |
| OpenWrt | VirtIO / `virtio-net-pci` | `eth0` directly, without `br-lan` | UCI owns the LAN interface; the prepared image disables its stock DHCPv4, DHCPv6, DNS listener and router advertisements | guest hook |

The QemuWeb label **Ethernet 0** is the first virtual NIC, not a Linux naming
guarantee. The names above are the intended result of the current preparation
scripts; an older base can still show another name. Use `ip link` in the guest
to inspect the actual interface. Debian and Alpine remain DHCP *clients* by
default, even while the lab uses manually assigned static addresses. OpenWrt's
LAN configuration may retain a stock static address; change it before putting
multiple OpenWrt hosts on one switch.

## Clone, reboot and rebuild

QemuWeb's Clone action copies host configuration and creates a new working
disk from the base. It does not copy the source host's working disk. With a
newly prepared base, the clone therefore receives its own machine ID at first
boot. Reboot preserves the ID; Reset discards the working disk and gives the
host a new ID. A manual copy of an already used working disk also copies its
ID and must be cleaned while the copy is offline.

Existing RAW/VDI files are reused without changes. After stopping hosts that
depend on a base, rebuild it with:

```sh
bash scripts/prepare.sh --system <system> --force
```

`--force` saves the old RAW/VDI pair under `images/backups/`. A rebuilt base
must be checked for an empty `/etc/machine-id` and, on Debian, the D-Bus link.
Then boot two separate hosts and check that their IDs differ, `ttyS0` login
works, the expected interface appears, and static addresses can ping both
ways. Existing differential disks keep their previous machine IDs and may
depend on the old base; do not reuse them against a rebuilt base.

See [Debian 13 Legacy image profile](debian13-legacy.md) for its detailed
package and boot contract, [guest buses and drivers](qemu-guest-bus-and-drivers.md)
for the hardware choices, and [guest startup media](guest-startup.md) for the
startup hook.
