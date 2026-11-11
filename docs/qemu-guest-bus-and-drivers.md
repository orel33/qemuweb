# QEMU guest buses and drivers: disk and NIC

QEMU presents virtual hardware to the guest. The guest kernel needs a matching driver for each device. Disk and network devices are independent choices: a VM can boot from a VirtIO disk and use an emulated Intel NIC, or use another supported combination.

## Debian 13 cloud and legacy profiles

The `debian13-cloud` VM uses VirtIO for both its system disk and LAN NIC. An earlier test boot with `virtio-net-pci` showed `enp0s2`. The preparation now writes `net.ifnames=0` into GRUB and matches `eth*` in its persistent `systemd-networkd` configuration, as the Legacy profile does. The rebuilt Cloud image presented `eth0` in the two-host KVM diagnostic; additional cards are intended to appear as `eth1` and so on. The profile keeps `diskInterface: virtio` and `networkModel: virtio-net-pci`.

The separate `debian13-legacy` profile is installed from the official Debian 13 netinst ISO, not from a cloud image. Its preparation installs `linux-image-amd64` and the network/debug toolkit, and configures the boot command line with `root=/dev/sda1 console=tty0 console=ttyS0,115200 net.ifnames=0`. It also enables the GRUB console on serial and VGA. The profile uses an IDE disk and `e1000`; Debian mounts `/dev/sda1`, loads the Intel driver, reaches the serial login prompt, and names its cards `eth0`, `eth1`, and so on.

## Disk: VirtIO or IDE

| QEMU disk bus | Guest device and driver | Image requirement |
|---|---|---|
| `if=virtio` | VirtIO PCI transport and `virtio_blk` (VirtIO block device) | The boot kernel must include the driver or have it in the initramfs, so it can find and mount `/`. |
| `if=ide` | Emulated ATA/IDE or SATA controller; the driver depends on the QEMU machine and controller | The controller and disk drivers must likewise be available early enough to mount `/`. |

The Debian kernel packages provide the drivers; there is no separate `virtio` or `ide` driver package. Debian's `initramfs-tools` builds the early boot image. If a needed driver is modular, check that it is included in the initramfs and regenerate it after changing the kernel or module policy:

```sh
update-initramfs -u -k all
```

Qemuweb uses `-drive if=virtio` for the Debian cloud system disk and `-drive if=ide` for Debian Legacy. QEMU documents these as distinct drive interface types in its [`-drive` options](https://www.qemu.org/docs/master/system/qemu-manpage.html).

## Network: VirtIO or emulated Intel

| QEMU NIC model | Guest driver | Trade-off |
|---|---|---|
| `virtio-net-pci` | `virtio_pci` and `virtio_net` | Virtualization-aware device with lower emulation overhead; recommended for the current Debian image. |
| `e1000` | `e1000` | Emulates an Intel network card; useful for compatibility when the guest kernel has this driver. |

The NIC driver can load after Debian has mounted its local root disk, so it normally does not need to be in the initramfs. A missing NIC driver means QEMU can show a connected card while the guest only lists `lo`. The Debian 13 cloud image used by Qemuweb had no usable `e1000` driver; its selected card was therefore changed to `virtio-net-pci`. The earlier `enp0s2` observation came from a base built before the `net.ifnames=0` change. QemuWeb's “Ethernet 0” is a device index; the guest assigns its Linux interface name.

Both NIC models can connect to the same VDE switch. The NIC model does not determine whether the guest gets an IP address. VDE provides layer 2 switching, not DHCP; configure addresses in the guests or provide a DHCP service on the LAN.

## Debian packages and checks

For the Qemuweb Debian cloud image:

- `linux-image-cloud-amd64` provides the cloud kernel and its modules; VirtIO disk and network support are verified with the current image. Debian describes it as a kernel for x86-64 cloud platforms in the [`linux-image-cloud-amd64` package information](https://packages.debian.org/trixie/amd64/linux-image-cloud-amd64).
- `linux-image-amd64` is Debian's general-purpose 64-bit PC kernel, installed by the legacy image preparation to provide broad emulated device support. Kernel drivers are part of the kernel image, not standalone packages named `virtio-net` or `e1000`.
- `iproute2` provides the `ip` command. It displays and configures interfaces; it does not supply kernel drivers. [`systemd-networkd`](https://wiki.debian.org/SystemdNetworkd) or another network manager configures addresses. `systemd-networkd` is part of systemd.
- `pciutils` (`lspci`) and `kmod` (`modprobe`, `modinfo`) are optional diagnostics, not runtime prerequisites for a virtual NIC.

Check the running kernel's driver configuration and visible interfaces with:

```sh
uname -r
grep -E 'CONFIG_(VIRTIO_PCI|VIRTIO_BLK|VIRTIO_NET|E1000)=' /boot/config-$(uname -r)
ip -br link
```

In the kernel configuration, `=y` means built in and `=m` means supplied as a module. The disk's root driver must work during boot; the NIC driver only needs to load by the time networking is used. For a manual static LAN test on a rebuilt Cloud image, use its actual interface name, expected to be `eth0`:

```sh
ip link set eth0 up
ip address add 192.168.10.1/24 dev eth0
```

Give the second VM a different address in the same subnet, such as `192.168.10.2/24`. No gateway is needed for traffic confined to that LAN.
