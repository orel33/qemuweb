# Optimisation of the debian13-cloud image

Running report of the work on `images/debian13-cloud.raw`: measurements before and after, findings, decisions and
changes. Updated at each step.

**Goals:** a shorter boot, a smaller image, no optional network service started at boot (they can still be started by
hand). A **Services** tab in Host Settings (roadmap HSV01) comes later.

## Status

| Step | Content | State |
| --- | --- | --- |
| 0 | Measure the current image | **Done** (26 November 2026) |
| 1 | Disable the optional services, remove what is not needed | **Done** (build scripts) |
| 2 | Rebuild and measure again, run four tests | **Done** (26 November 2026, in the task worktree, current Debian cloud image) |
| 3 | Validation by the user: manual test of the Web interface, merge | To do |
| - | Services tab in Host Settings (HSV01) | Not part of IMG03 |

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

The measurement script is in the repository: `scripts/measure-image.py IMAGE.raw` (4 boots, the last one detailed:
interfaces, then the frames counted after 90 s of silence), and `scripts/measure-image.py IMAGE.raw --check` (QEMU user
network, Internet access: DHCP by hand, `apt-get update`, a package installation, every disabled service started by
hand, IPv6 autoconfiguration turned on by hand). The card of the measurement is connected to a UDP socket that never
answers. **Both columns below were measured with this script**, on the same machine, one after the other.

The first measurement of the old image, with temporary scripts, gave 12.2 to 13.8 s to login and 8.6 to 9.9 s for
`systemd-analyze`; part of those runs used a bare `hubport`, which stalls the card. These two values are replaced by
the ones below; memory, disk, packages, services and frames were confirmed.

## Results

| Measure | Before | After | Gain |
| --- | --- | --- | --- |
| Time to login (4 boots) | 9.2 to 9.4 s (mean 9.3 s) | 6.7 to 6.9 s (mean 6.8 s) | **-2.5 s (-27%)** |
| `systemd-analyze` total | 6.4 to 6.6 s | 4.0 to 4.2 s | -2.4 s (-37%) |
| of which userspace (kernel about 1.9 s in both) | 4.5 to 4.7 s | 2.1 to 2.3 s | -2.4 s |
| Memory used at idle (one reading) | 201 MiB | 184 MiB | -17 MiB (-8%) |
| Used space on `/` | 1019 MiB | 689 MiB | -330 MiB (-32%) |
| RAW image, space on disk (virtual size 3 GiB) | 1.33 GiB | 0.74 GiB | **-0.59 GiB (-44%)** |
| VDI image, space on disk | 1.47 GiB | 0.90 GiB | -0.57 GiB (-39%) |
| Installed packages | 373 (581 MiB) | 357 (549 MiB) | -16 (-32 MiB, with `apache2` and `bind9` added) |
| Running services | 13 | 10 | -3 |
| Active timers | 8 | 1 (`systemd-tmpfiles-clean`) | -7 |
| Failed units | 3 | 0 | -3 |
| Listening on the network | SSH, LLMNR | nothing (local resolver only) | |
| Frames sent without any request (90 s) | 21 | **0** | -21 |

"After" is the final image, built from the Debian cloud image downloaded on 26 November 2026 (kernel 6.12.118; the old
image has 6.12.117). The same day, a first build from an older cloud image (kernel 6.12.115) gave 6.5 and 6.7 s to
login, no frame, the same disk use, and **167 to 168 MiB** of memory at idle. The memory figure therefore moved by
about 17 MiB between the two bases; each measurement reads it once, and the cause was not examined.

At the end of the new image's boot `eth0` is `UP` with no address, IPv4 or IPv6: the zero does not come from a link
that is down. The old image gave 9.1 to 9.3 s to login and 21 frames in each of its
three runs of the day.

`--check` on the new image: **11 steps passed out of 11** (DHCP by hand with `dhclient`; `apt-get update`; installing
`tree`; starting `ssh`, `dnsmasq`, `named`, `apache2` (a page is served), `inetutils-inetd`, `openvpn` and
`isc-dhcp-server` (with a test subnet on a dummy interface); link-local and autoconfigured IPv6 addresses on `eth0`).
For `openvpn` and `inetutils-inetd` it only shows that the unit starts: no tunnel and no telnet or FTP session was tried.

## Tests

Run on 26 November 2026 on the final image, one at a time, after the user's approval:

| Command (`./scripts/run-tests.sh ...`) | Result |
| --- | --- |
| `unit` | **Passed**: 794 tests, 0 failed, 0 skipped |
| `check-host-debian13-cloud` | **Passed** on the second run: startup disk script, resource and disk marker at the first boot, after Reboot with edited files, and after Stop/Resume |
| `check-network-debian13-cloud` | **Passed**: 19 checks out of 19 (consoles, host names, static addresses, ping both ways, `tcpdump` on both hosts) |
| `check-load-start` | **Passed**: `examples/lan.zip` loaded and started, 1 switch and 4 hosts running, startup disks attached, session deletion cleans up |

The first run of `check-host-debian13-cloud` failed before any host started (`PUT /api/general-settings: VirtualBox is
unavailable on this server.`). Cause: the task worktree has no `.env.local`, and the system QEMU has no VDE support, so
the runner disabled QEMU. The three scenarios that start hosts then ran with
`QEMU_SYSTEM_X86_64=/opt/qemu-11.1.3/bin/qemu-system-x86_64`, the setting of the main checkout. No code was changed.
(The message names VirtualBox whatever engine is missing: a defect of the server, outside IMG03.)

The measurements and the image build use the system QEMU, as `prepare.sh` does.

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
- **dnsmasq:** `bind-dynamic`, so that a start by hand does not collide with the stub of `systemd-resolved` on port 53.
  It starts by hand in `--check`.
- **`systemd-networkd-wait-online` disabled:** without any address it would make `dnsmasq`, started by hand, wait for
  two minutes.
- `apache2`, `bind9` and `vim` listed in the packages (`vim` was only there because the cloud image has it).
- **QMP socket** of the build VM in a short private directory of `/tmp` (`qw-prepare.*`, removed afterwards): under
  `sources/.prepare/` of a deep project directory its path exceeded the 107 bytes of a UNIX socket, and the build
  stopped at once.

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

## Disk space after the rebuild

- Removed: 28 packages, 75.8 MiB, among them the old kernel package (34.1 MiB, replaced by a newer one), so 41.7 MiB
  without it: `locales` 15.4, `qemu-utils` 12.2, `libc-l10n` 4.6, `cloud-init` 3.1, `genisoimage` 1.6.
- Added: 12 packages, 43.3 MiB, among them the new kernel package (34.1 MiB), so about 9.2 MiB for `apache2`, `bind9`
  and their libraries. 22 other packages have another version, from the newer base.
- Most of the gain is the cleaning: the APT lists and caches (about 255 MiB). `/var/lib/apt/lists` is empty in the
  image, and `apt-get update` followed by an installation works.

## Remaining limits

- **Not tried yet:** a manual test of the Web interface (`scripts/demo.sh`), the example labs other than loading and
  starting `lan`, and VirtualBox.
- **Base image:** `prepare.sh` reuses the cloud image already downloaded in `sources/` and never upgrades packages
  during the build. To get a current base, delete the two files of `sources/debian13-cloud/` before a build. With
  `unattended-upgrades` removed, a host never updates itself.
- **SSH host keys** are the same on every host of a base image (as before).
- **Left as they are**, possible later gains: `grub-common.service` (about 0.2 s), `apparmor` (about 0.2 s),
  `netplan.io` (no configuration left), the kernel command line (about 1.8 s of kernel time).

## Journal

- **26 November 2026:** initial measurement and static inspection. No change to the image or to the build scripts.
- **26 November 2026:** build scripts, finalize step, measurement script, user guide and install notes, IMG03 added to
  the roadmaps. Static checks only (`sh -n`, `bash -n`, Python syntax): nothing built, started or tested.
- **26 November 2026,** after the user's approval: first build stopped at once (QMP socket path too long); second one
  stopped by the final check, which refused the `enabled-runtime` state that netplan gives to
  `systemd-networkd-wait-online` while the cloud-init configuration exists; third one successful (1 min 52 s). Both
  images measured, `--check` passed (11 of 11; its IPv6 step first failed on a wrong expectation of the script, the
  addresses being there). The old image was only read, with `-snapshot`. No test suite run.
- **26 November 2026,** with the user's approval: the two downloaded files of the worktree deleted (not those of the main
  checkout, left unchanged), current Debian cloud image downloaded, image rebuilt with `--force` (successful at once,
  2 min 34 s), both images measured, `--check` 11 of 11, then the four tests above, all passed.
