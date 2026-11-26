# Optimisation of the debian13-cloud image

Running report of the work on `images/debian13-cloud.raw`: measurements before and after, findings, decisions and
changes. Updated at each step.

**Goals:** a shorter boot, a smaller image, no optional network service started at boot (they can still be started by
hand), and then a **Services** tab in Host Settings (roadmap HSV01).

## Status

| Step | Content | State |
| --- | --- | --- |
| 0 | Measure the current image | **Done** (26 November 2026) |
| 1 | Disable the optional services, remove what is not needed | **Written** (build scripts), not built yet |
| 2 | Rebuild and measure again | Waiting for the user's approval |
| 3 | Services tab in Host Settings (HSV01) | Not part of IMG03 |

Roadmap code of this work: **IMG03** (IMG01 is about `debian13-legacy`).

## Method

- Image of 21 November 2026, **before any optimisation**, on the development machine, with KVM.
- QEMU started directly, not through QemuWeb: `q35`, `-cpu host`, 1 vCPU, 1024 MiB, virtio disk with `-snapshot` (the
  image is not modified), one virtio network card connected to a sink that never answers, no startup disk.
- **Time to login:** wall clock from the QEMU launch to the first `login:` on `ttyS0` (firmware and GRUB included).
- **Systemd time:** `systemd-analyze`, once `systemctl is-system-running --wait` returns.
- **Memory, disk, services:** `free -m`, `df -m /`, `systemctl` and `ss` in the guest.
- **Spontaneous traffic:** QEMU `filter-dump` on the card, for about 90 s after the boot.
- **Packages and enabled units:** also read from the image without booting it (`debugfs`, read-only).

The measurement script is now in the repository: `scripts/measure-image.py IMAGE.raw` (4 boots, the last one detailed,
with 90 s of silence before the count of the frames), and `scripts/measure-image.py IMAGE.raw --check` (user network,
Internet access: DHCP by hand, `apt-get update`, a package installation, every disabled service started by hand). The
card of the measurement is connected to a UDP socket that never answers. The first "before" values below come from the
temporary scripts, and part of those runs used a bare `hubport`, which stalls the card: the old image has to be measured
again with the repository script, so that both columns come from the same method.

## Results

| Measure | Before | After | Gain |
| --- | --- | --- | --- |
| Time to login (4 boots) | 12.2 to 13.8 s (mean 13.2 s) | | |
| `systemd-analyze` total | 8.6 to 9.9 s (kernel about 3 s) | | |
| Memory used at idle | 202 to 203 MiB | | |
| Used space on `/` | 1019 MiB | | |
| RAW image, space on disk (virtual size 3 GiB) | 1.33 GiB | | |
| Installed packages | 373 (581 MiB) | | |
| Running services | 13 | | |
| Failed units | 3 | | |
| Frames sent without any request (about 90 s) | 21 | | |

## Initial state

### Services

- **Running:** `dbus`, `getty@tty1`, `serial-getty@ttyS0` and `ttyS1`, `ssh`, `systemd-journald`, `systemd-logind`,
  `systemd-networkd`, `systemd-resolved`, `systemd-timesyncd`, `systemd-udevd`, `unattended-upgrades`, `user@1000`
  (the measurement login).
- **Failed:** `dnsmasq`, `isc-dhcp-server`, `qemuweb-start` (no startup disk in this measurement).
- **Also enabled:** `openvpn`, `inetutils-inetd`, `apparmor`, `e2scrub_reap`, `grub-common`, `systemd-pstore`,
  `remote-fs.target`.
- **Timers:** `apt-daily`, `apt-daily-upgrade`, `apt-listchanges`, `dpkg-db-backup`, `man-db`, `fstrim`,
  `e2scrub_all`.
- **Listening on the network:** SSH (TCP 22), LLMNR (`systemd-resolved`, port 5355). `inetutils-inetd` is enabled but
  `/etc/inetd.conf` has no active line: neither telnet nor FTP is served.
- **Not installed:** `apache2`, `bind9`.

### Slowest units

| Unit | Time |
| --- | --- |
| `qemuweb-start.service` | 2.5 s (fails without a startup disk, after retries) |
| `isc-dhcp-server.service` | 2.2 s (fails) |
| `dev-vda1.device` | 1.6 s |
| `apparmor.service` | 0.8 s |
| `grub-common.service` | 0.4 to 0.6 s |
| `dnsmasq.service` | 0.5 s (fails) |

These times overlap: they cannot be added up, and a slow unit does not always delay the login prompt. The GRUB timeout
is already 0.

### Network traffic

21 frames: DHCPv4 requests (repeated with a growing delay), IPv6 duplicate address detection, router solicitations
and MLD reports, LLMNR.

### Disk space

- Largest packages: `vim-runtime` 37 MiB, kernel 34 MiB, `libperl5.40` 28 MiB, `nmap-common` 21 MiB,
  `perl-modules` 19 MiB, `coreutils` 18 MiB, `grub-common` 17 MiB, `locales` 15 MiB, `qemu-utils` 12 MiB.
- Left by the build: APT lists 162 MiB, `pkgcache.bin` and `srcpkgcache.bin` 47 MiB each, about **255 MiB** in all.

## Decisions (26 November 2026)

| Subject | Decision |
| --- | --- |
| DHCP client, IPv6 autoconfiguration | Off at boot, can be started by hand (documented in the user guide). Goal: an idle host sends no frame |
| LLMNR, mDNS, NTP | Off |
| Optional network services | Installed, disabled, startable by hand; useless periodic timers disabled |
| Removed | `unattended-upgrades`, `cloud-init`, `qemu-utils` (with `cloud-image-utils`, `cloud-utils`, `cloud-initramfs-growroot`), `locales`, `libc-l10n` (`C.UTF-8` stays) |
| Kept | `vim`, `nano`, `nmap`, `scapy`, `tcpdump`, `openvpn`, the other lab tools, `qemu-guest-agent` |
| Added | `apache2` and `bind9`, disabled (for HSV01, later) |
| APT | Caches and lists removed, free blocks discarded |

## Changes

### Build (`scripts/prepare/`)

- **A finalize step** (`resources/debian-cloud-finalize.sh`), run in the build VM after `cloud-final.service`, because
  cloud-init cannot be purged while it runs. It disables the units, purges the packages, removes what cloud-init
  generated, checks the result, cleans APT and the journal, blanks the machine ID, runs `fstrim` and prints the end
  marker. Any failure prints the failure marker and stops the build.
- **Discard:** the build disk has `discard=unmap,detect-zeroes=unmap`, so the trimmed blocks become holes in the RAW.
- **Disabled units:** `ssh`, `dnsmasq`, `isc-dhcp-server`, `inetutils-inetd`, `openvpn`, `apache2`,
  `apache-htcacheclean`, `named`, `systemd-timesyncd`, `systemd-networkd-wait-online`, `e2scrub_reap`.
  **Disabled timers:** `apt-daily`, `apt-daily-upgrade`, `apt-listchanges`, `dpkg-db-backup`, `man-db`, `e2scrub_all`,
  `fstrim` (the root filesystem is already mounted with `discard`).
- **Network:** `20-qemunet.network` with `DHCP=no`, `LinkLocalAddressing=no`, `IPv6AcceptRA=no`, no LLMNR or mDNS,
  `RequiredForOnline=no`; the same LLMNR and mDNS setting for `systemd-resolved`. The links still come up.
- **dnsmasq:** `bind-dynamic`, so that a start by hand no longer collides with the stub of `systemd-resolved` (the
  failure seen in the initial measurement is of this kind or comes from the missing network; the `--check` run will
  tell).
- **`systemd-networkd-wait-online` disabled:** without any address it would make `dnsmasq`, started by hand, wait for
  two minutes.
- `apache2`, `bind9` and `vim` listed in the packages (`vim` was only there because the cloud image has it).

### Removal list

Never `apt-get autoremove`: an explicit list, first simulated in the build; the build fails if APT would remove
anything else. Besides the 8 packages decided above, these dependencies are only used by them (simulation on the
`dpkg` state of the current image): `dhcpcd-base`, `eject`, `genisoimage`, `libaio1t64`, `python3-attr`,
`python3-blinker`, `python3-configobj`, `python3-dbus`, `python3-distro-info`, `python3-jinja2`,
`python3-json-pointer`, `python3-jsonpatch`, `python3-jsonschema`, `python3-jsonschema-specifications`,
`python3-jwt`, `python3-markupsafe`, `python3-oauthlib`, `python3-referencing`, `python3-rpds-py`.
`netcat-openbsd`, `isc-dhcp-client` (`dhclient`) and `ca-certificates` stay, and the build checks it.

### What cloud-init leaves behind

| Item | Found in the current image | Handling |
| --- | --- | --- |
| `/etc/netplan/50-cloud-init.yaml` (DHCP on `en*`) | yes, owned by no package | removed (`netplan.io` stays, with no configuration) |
| `/etc/apt/apt.conf.d/94cloud-init-config` (no Recommends) | yes | replaced by `90qemuweb-no-recommends` |
| `/etc/ssh/sshd_config.d/50-cloud-init.conf` (password login) | yes | replaced by `10-qemuweb.conf` |
| `/etc/hosts` header about `manage_etc_hosts` | yes | file rewritten without it |
| SSH host keys | generated during the build, **the same on every host** | unchanged, so `systemctl start ssh` works at once |
| `sshd` start | `ssh.service` | unchanged, only disabled |
| Account `toto`, `sudo` group, hostname | written in the system | stay without cloud-init |
| `/etc/cloud`, `/var/lib/cloud`, cloud-init logs | yes | removed |

### `qemuweb-start.service`

Without a startup disk, the hook tried three times, one second apart, then failed, so every such host had a failed unit.
The script `guest-start.sh` is **shared by all images**:

- on systemd guests (both Debian images) only, it waits for `udevadm settle`, then stops at the first pass when a CD
  drive is present without the expected medium; Alpine and OpenWrt keep the three attempts;
- the "no startup disk" exit status is now **66** instead of 1, on every system (same message);
  `qemuweb-start.service` accepts it (`SuccessExitStatus=66`), so the unit no longer fails on Debian. On Alpine and
  OpenWrt a non-zero status is still a failure for their init system;
- a `start.sh` that fails, or a startup disk without `start.sh`, still fails the unit (unless `start.sh` itself exits
  with 66).

`debian13-legacy` gets this change at its next rebuild; nothing else of IMG03 applies to it.

A rebuild changes the identity of the base image: a saved session with working disks must then be loaded without them.

## Journal

- **26 November 2026:** initial measurement and static inspection. No change to the image or to the build scripts.
- **26 November 2026:** build scripts, finalize step, measurement script, user guide and install notes, IMG03 added to
  the roadmaps. Static checks only (`sh -n`, `bash -n`, Python syntax): nothing built, started or tested.
