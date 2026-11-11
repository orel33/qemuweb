# Debian 13 Legacy image profile

This document is the technical contract for the `debian13-legacy` teaching
image. The preparation script is the executable source of truth; this profile
explains the intended result and the invariants that must remain stable.

## Purpose

`debian13-legacy` is a compact, text-mode Debian system for networking labs. It
recreates the useful teaching environment of the historical QemuNet Debian
image on a clean Debian 13 base, without carrying forward its mixed Debian
releases, obsolete libraries, graphical stack, or documentation toolchain.

The profile intentionally uses traditional virtual hardware:

| Property | Value |
|---|---|
| Architecture | `amd64` / x86-64 |
| Distribution | Debian 13 |
| Installation source | Official amd64 netinst ISO, verified with Debian's `SHA512SUMS` |
| System identifier | `debian13-legacy` |
| Default hostname | `qemuweb` |
| Mode | Linux text console |
| Canonical base | `images/debian13-legacy.raw` |
| VirtualBox base | `images/debian13-legacy.vdi` |
| Virtual disk size | 4 GiB, sparse RAW |
| QEMU machine | `q35` |
| System disk bus | IDE |
| Linux root device | `/dev/sda1` |
| Ethernet model | Intel `e1000` |
| Boot loader | GRUB installed in the virtual system disk |
| Boot source | First hard disk (`-boot order=c`) |

## Offline construction

[`scripts/prepare/debian13-legacy.sh`](../scripts/prepare/debian13-legacy.sh)
performs an unattended Debian netinst installation. It extracts the installer's
kernel and initrd from the verified ISO, appends the preseed and guest setup
script to the initrd, and boots a temporary preparation VM.

The preparation VM uses:

```text
q35 machine
KVM when available, otherwise TCG
2 vCPUs
2048 MiB RAM
IDE RAW system disk
IDE netinst CD-ROM
e1000 adapter on temporary QEMU user networking
serial output captured in a preparation log
```

The Debian installer uses regular partitioning with the atomic recipe and
installs GRUB on `/dev/sda`. The root filesystem must remain the first IDE disk
partition, `/dev/sda1`, because this profile deliberately demonstrates stable
legacy device naming rather than UUID-based root discovery.

The base installation includes Debian's `standard` task and the explicit
teaching packages listed below. Package recommendations are globally disabled:
required dependencies are retained, but optional `Recommends` are not
automatically installed. No distribution upgrade is run while building the
image.

The 4 GiB virtual capacity is the minimum maintained project target. The
atomic partitioning recipe reserves approximately 480 MiB for swap and assigns
the remainder to the root filesystem. Because RAW is sparse, its physical host
usage reflects guest data rather than the full 4 GiB virtual capacity.

When preparation succeeds, the script:

1. shuts down the temporary installer VM;
2. makes the RAW base read-only (`0444`);
3. derives a read-only VDI base from the same RAW content.

Existing non-empty bases are reused. Use
`bash scripts/prepare.sh --system debian13-legacy --force` after stopping
dependent hosts to deliberately rebuild this profile. Its base has an empty
`/etc/machine-id` and `/var/lib/dbus/machine-id` links to it; see the
[shared image contract](image-contract.md).

## Runtime virtual hardware

The system-specific values in [`config.json`](../config.json) override the
common QEMU defaults. A normal QEMU launch therefore uses:

| Setting | Effective value |
|---|---|
| Machine | `q35` |
| CPU with KVM | `host` |
| CPU with TCG | `qemu64` |
| Memory | 1024 MiB |
| vCPUs | 1 |
| Display | none |
| RTC | UTC |
| Working disk | QCOW2 overlay backed by the read-only RAW base |
| Disk attachment | `if=ide,format=qcow2,media=disk` |
| Boot order | first hard disk (`c`) |
| NIC | none until an interface is explicitly added |
| Added NIC model | `e1000` |
| Guest serial console | QEMU serial port connected to a Unix socket |
| QEMU monitor | separate Unix socket |

VirtualBox uses the VDI base, a per-VM differential VDI, 1024 MiB RAM, one
CPU, a headless display, and COM1 connected to the QemuWeb serial Unix socket.
Its network adapters are also absent until explicitly configured.

## Boot and console contract

The guest must boot autonomously from its own GRUB installation. Runtime
launches must not need QEMU's `-kernel`, `-initrd`, or `-append` options.

The preparation script writes the following persistent GRUB policy:

```text
GRUB_CMDLINE_LINUX_DEFAULT="console=tty0 console=ttyS0,115200 net.ifnames=0"
GRUB_CMDLINE_LINUX="root=/dev/sda1"
GRUB_DISABLE_LINUX_UUID=true
GRUB_TERMINAL="console serial"
GRUB_SERIAL_COMMAND="serial --speed=115200 --unit=0 --word=8 --parity=no --stop=1"
```

Both console paths are required:

- `tty0` preserves the traditional local VGA text console;
- `ttyS0` carries kernel messages, systemd output, login, and the interactive
  shell through QemuWeb;
- `serial-getty@ttyS0.service` provides the serial `login:` prompt;
- `getty@tty1.service` provides the first local virtual-terminal login;
- serial parameters are 115200 baud, 8 data bits, no parity, one stop bit.

At runtime, QemuWeb connects `ttyS0` explicitly with:

```text
-serial unix:<console socket>,server=on,wait=off
```

The separate QEMU monitor socket controls the emulator and must never be
confused with the guest shell:

```text
-monitor unix:<monitor socket>,server=on,wait=off
```

## Accounts

These credentials are intentionally convenient for disposable classroom VMs
and are unsafe for production or an untrusted network:

| Account | Password | Privileges |
|---|---|---|
| `root` | none | root |
| `toto` | `toto` | member of `sudo` |

## Network contract

`systemd-networkd` is enabled. `/etc/systemd/network/20-qemunet.network`
requests DHCP on interfaces matching `eth*`.

The image does not assume that a DHCP server exists. A plain VDE switch only
provides Ethernet switching; DHCP must be supplied by another lab host, a
router VM, or an explicitly configured service. QemuWeb adds no implicit NAT
or external adapter during normal runtime.

The `e1000` model is deliberate: it matches the historical QemuNet hardware
model and presents a conventional emulated Intel Ethernet controller. Multiple
interfaces may be attached, each with its own QemuWeb-generated MAC address.
The kernel argument `net.ifnames=0` disables predictable interface names for
this legacy profile, so cards appear in discovery order as `eth0`, `eth1`, and
so on.

## Explicit teaching packages

### Base and console utilities

```text
linux-image-amd64 bash sudo procps nano bash-completion
curl wget unzip moreutils rsyslog
```

### IP, Ethernet, VLAN, firewall, and diagnostics

```text
iproute2 net-tools iputils-ping traceroute netcat-openbsd tcpdump
bridge-utils vlan iptables
```

### DNS and DHCP

```text
dnsutils dnsmasq dnsmasq-utils isc-dhcp-client isc-dhcp-server
```

### Capture, scanning, security, and VPN

```text
nmap dsniff python3-scapy openssl gnutls-bin openvpn
```

### Remote and legacy network services

```text
openssh-client openssh-server
inetutils-telnet inetutils-telnetd
tnftp inetutils-ftpd
```

### Web and automation

```text
apache2 lynx python3 expect
```

The modern explicit Inetutils and `tnftp` package names avoid relying on
Debian transitional or virtual packages while retaining the historical
`telnet`, `telnetd`, `ftp`, and `ftpd` commands/services used in labs.

## Deliberate exclusions

The following historical components are not part of this image:

| Excluded component | Reason |
|---|---|
| PHP and `libapache2-mod-php` | Apache is required, PHP is not |
| TShark/Wireshark | large Wireshark library and data dependency set |
| Emacs | large editor footprint; `nano` is the standard text editor here |
| TeX Live and `gnutls-doc` | large documentation/typesetting footprint |
| GCC and development headers | no compilation toolchain required for the labs |
| IPython and Matplotlib | optional Scapy conveniences, not core Scapy requirements |
| Graphical desktop and applications | the image is serial/text-only |

`dsniff` itself requires a small set of X11 runtime libraries on Debian, even
when its command-line tools are used without a graphical desktop. Those are
mandatory package dependencies and are retained; Mesa, LLVM and a desktop
stack are not installed.

## Lifecycle and persistence

The RAW and VDI bases are immutable. Each tab receives its own writable working
disk:

- QEMU: QCOW2 overlay backed by `debian13-legacy.raw`;
- VirtualBox: differential VDI backed by `debian13-legacy.vdi`.

Stop, Resume, and Reboot retain the working disk. Reset, Exit, and closing the
tab discard it according to the application lifecycle documented in the main
README.

## Acceptance checklist

After rebuilding the image, verify all of the following before treating it as
a valid base:

- GRUB boots from the IDE disk without `-kernel`, `-initrd`, or `-append`;
- the kernel identifies the root filesystem as `/dev/sda1`;
- boot messages and `login:` appear on `ttyS0` in QemuWeb;
- a login remains available on `tty1`/`tty0` locally;
- both documented accounts work;
- `nano`, `scapy`, `apache2`, `ip`, `tcpdump`, `nmap`, `dnsmasq`, `dhcpd`,
  `sshd`, `telnetd`, `ftpd`, and `openvpn` are installed;
- PHP, GCC, Emacs, TeX, TShark/Wireshark, IPython, and Matplotlib are absent;
- no network interface is created unless QemuWeb explicitly adds one;
- attached `e1000` interfaces are detected as `eth0`, `eth1`, etc., and can
  request DHCP;
- QEMU and VirtualBox can each boot from their corresponding immutable base.

