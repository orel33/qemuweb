#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"

id=debian13-legacy
# This profile installs Debian from the netinst ISO, rather than using a cloud
# image, so its disk and NIC can retain the legacy IDE + e1000 hardware model.
source_dir="$SOURCES/$id"
raw="$IMAGES/$id.raw"
vdi="$IMAGES/$id.vdi"
iso_name=debian-13.7.0-amd64-netinst.iso
iso="$source_dir/$iso_name"
sums="$source_dir/SHA512SUMS"
base_url=https://cdimage.debian.org/debian-cd/current/amd64/iso-cd
mkdir -p "$source_dir"

if [[ ! -s "$raw" ]]; then
  # Verify the installer media before extracting its kernel and initrd for an
  # unattended serial-console installation.
  require_commands curl sha512sum isoinfo python3 qemu-system-x86_64 qemu-img
  fetch_file "$base_url/$iso_name" "$iso"
  fetch_file "$base_url/SHA512SUMS" "$sums"
  (cd "$source_dir" && grep -E "[ *]${iso_name//./\\.}$" SHA512SUMS | sha512sum -c -)

  temp_dir="$(mktemp -d "$RUNTIME/.$id-prepare.XXXXXX")"
  trap '[[ -n "${qemu_pid:-}" ]] && kill -TERM "$qemu_pid" 2>/dev/null || true; rm -rf "$temp_dir"' EXIT
  isoinfo -i "$iso" -x '/INSTALL.AMD/VMLINUZ.;1' > "$temp_dir/vmlinuz"
  isoinfo -i "$iso" -x '/INSTALL.AMD/INITRD.GZ;1' > "$temp_dir/initrd.gz"
  cat > "$temp_dir/preseed.cfg" <<'PRESEED'
# Preseed fixes installer language, disk layout, root login, packages, and the
# late command that applies QemuWeb-specific guest settings.
d-i debian-installer/locale string en_US.UTF-8
d-i keyboard-configuration/xkb-keymap select us
d-i netcfg/choose_interface select auto
d-i netcfg/get_hostname string qemuweb
d-i netcfg/get_domain string local
d-i mirror/country string manual
d-i mirror/http/hostname string deb.debian.org
d-i mirror/http/directory string /debian
d-i mirror/http/proxy string
d-i passwd/root-login boolean true
d-i passwd/make-user boolean false
d-i passwd/root-password password temporary-root-password
d-i passwd/root-password-again password temporary-root-password
d-i time/zone string UTC
d-i clock-setup/utc boolean true
d-i partman-auto/method string regular
d-i partman-auto/choose_recipe select atomic
d-i partman-partitioning/confirm_write_new_label boolean true
d-i partman/choose_partition select finish
d-i partman/confirm boolean true
d-i partman/confirm_nooverwrite boolean true
d-i partman/confirm_write_new_label boolean true
d-i partman/mount_style select traditional
# Keep this teaching image compact. Explicit packages below are installed with
# their required dependencies, but optional Recommends are not pulled in.
d-i base-installer/install-recommends boolean false
d-i apt-setup/use_mirror boolean true
d-i pkgsel/upgrade select none
# QemuNet teaching toolkit: network administration, DNS/DHCP, capture and
# security, remote/legacy services, Apache, automation, and text-mode tools.
# Deliberately excluded: PHP, GCC, Emacs, TeX, TShark/Wireshark, IPython,
# Matplotlib, and graphical utilities. Scapy and Apache are retained.
d-i pkgsel/include string linux-image-amd64 bash sudo procps nano bash-completion curl wget unzip moreutils rsyslog iproute2 net-tools iputils-ping traceroute netcat-openbsd tcpdump bridge-utils vlan iptables dnsutils dnsmasq dnsmasq-utils isc-dhcp-client isc-dhcp-server nmap dsniff python3-scapy openssl gnutls-bin openvpn openssh-client openssh-server inetutils-telnet inetutils-telnetd tnftp inetutils-ftpd apache2 lynx python3 expect
tasksel tasksel/first multiselect standard
popularity-contest popularity-contest/participate boolean false
d-i grub-installer/only_debian boolean true
d-i grub-installer/bootdev string /dev/sda
d-i preseed/late_command string cp /legacy-setup.sh /target/tmp/legacy-setup.sh; cp /guest-start.sh /target/tmp/guest-start.sh; cp /qemuweb-start.service /target/tmp/qemuweb-start.service; in-target /bin/sh /tmp/legacy-setup.sh
d-i finish-install/reboot_in_progress note
d-i debian-installer/exit/poweroff boolean true
PRESEED
  cat > "$temp_dir/legacy-setup.sh" <<'SETUP'
#!/bin/sh
set -eu
# Keep the image convenient for console-based lab use; these credentials are
# intended for this disposable teaching image, not a production VM.
passwd -d root
useradd -m -s /bin/bash -G sudo toto || true
printf 'toto:toto\n' | chpasswd
printf 'qemuweb\n' > /etc/hostname
mkdir -p /etc/default/grub.d /etc/systemd/network
# Keep both local and serial consoles available after boot, and use the legacy
# IDE disk's first partition as root instead of relying on UUID discovery.
cat > /etc/default/grub.d/99-qemunet-legacy.cfg <<'GRUB'
GRUB_DEFAULT=0
GRUB_TIMEOUT=1
GRUB_TIMEOUT_STYLE=menu
GRUB_CMDLINE_LINUX_DEFAULT="console=tty0 console=ttyS0,115200 net.ifnames=0"
GRUB_CMDLINE_LINUX="root=/dev/sda1"
GRUB_DISABLE_LINUX_UUID=true
GRUB_TERMINAL="console serial"
GRUB_SERIAL_COMMAND="serial --speed=115200 --unit=0 --word=8 --parity=no --stop=1"
GRUB
cat > /etc/systemd/network/20-qemunet.network <<'NETWORK'
# systemd-networkd requests DHCP on Ethernet interfaces. This is client-side
# configuration; the VDE switch does not run a DHCP server.
[Match]
Name=eth*

[Network]
DHCP=yes
NETWORK
systemctl enable serial-getty@ttyS0.service getty@tty1.service systemd-networkd.service
install -m 755 /tmp/guest-start.sh /usr/local/sbin/qemuweb-guest-start
install -m 644 /tmp/qemuweb-start.service /etc/systemd/system/qemuweb-start.service
systemctl enable qemuweb-start.service
# Refresh boot artifacts after changing GRUB and console/kernel settings.
update-grub
update-initramfs -u -k all
echo QEMUNET_IMAGE_PREPARED >/dev/ttyS0 || true
SETUP
  chmod +x "$temp_dir/legacy-setup.sh"
  cp "$ROOT/scripts/prepare/guest-start.sh" "$temp_dir/guest-start.sh"
  cp "$ROOT/scripts/prepare/qemuweb-start.service" "$temp_dir/qemuweb-start.service"
  python3 - "$temp_dir" <<'PY'
import gzip, os, stat, sys
from pathlib import Path
root = Path(sys.argv[1])
files = [('preseed.cfg', 0o100644), ('legacy-setup.sh', 0o100755), ('guest-start.sh', 0o100755), ('qemuweb-start.service', 0o100644)]
out = bytearray()
ino = 1
for name, mode in files:
    data = (root / name).read_bytes()
    n = name.encode() + b'\0'
    fields = [ino, mode, 0, 0, 1, 0, len(data), 0, 0, 0, 0, len(n), 0]
    out += b'070701' + b''.join(f'{v:08x}'.encode() for v in fields) + n
    out += b'\0' * (-len(out) % 4)
    out += data
    out += b'\0' * (-len(out) % 4)
    ino += 1
name = b'TRAILER!!!\0'
fields = [ino, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, len(name), 0]
out += b'070701' + b''.join(f'{v:08x}'.encode() for v in fields) + name
out += b'\0' * (-len(out) % 4)
(root / 'addon.cpio.gz').write_bytes(gzip.compress(out, mtime=0))
PY
  cat "$temp_dir/addon.cpio.gz" >> "$temp_dir/initrd.gz"
  rm -f "$raw.tmp"
  # The installer sees an IDE disk and e1000 NIC to match the legacy profile.
  # Four GiB leaves enough room for the compact teaching system, its swap,
  # lab files, logs, and routine package updates without bloating both bases.
  qemu-img create -f raw "$raw.tmp" 4G
  qemu-system-x86_64 -machine q35 -accel "$(prep_acceleration)" -m 2048 -smp 2 \
    -display none -monitor none -serial "file:$temp_dir/serial.log" -no-reboot \
    -kernel "$temp_dir/vmlinuz" -initrd "$temp_dir/initrd.gz" \
    -append 'auto=true priority=critical preseed/file=/preseed.cfg console=tty0 console=ttyS0,115200n8 ---' \
    -drive "file=$raw.tmp,if=ide,index=0,media=disk,format=raw" \
    -drive "file=$iso,if=ide,index=2,media=cdrom,readonly=on" \
    -nic user,model=e1000 -boot order=c \
    >"$temp_dir/qemu.stdout" 2>"$temp_dir/qemu.stderr" &
  qemu_pid=$!
  prepared=0
  for _ in $(seq 1 1800); do
    if grep -q QEMUNET_IMAGE_PREPARED "$temp_dir/serial.log" 2>/dev/null; then prepared=1; fi
    if [[ $prepared == 1 ]] && ! kill -0 "$qemu_pid" 2>/dev/null; then break; fi
    if ! kill -0 "$qemu_pid" 2>/dev/null; then break; fi
    sleep 1
  done
  if [[ $prepared != 1 ]]; then
    echo "Debian netinst preparation failed; last serial output:" >&2
    tail -n 100 "$temp_dir/serial.log" 2>/dev/null || true
    cat "$temp_dir/qemu.stderr" >&2 || true
    echo "Preparation files preserved in $temp_dir" >&2
    trap - EXIT
    exit 1
  fi
  wait "$qemu_pid" || true
  qemu_pid=''
  if [[ ! -s "$raw.tmp" ]]; then echo 'Installer did not produce a disk image.' >&2; exit 1; fi
  chmod 444 "$raw.tmp"
  mv "$raw.tmp" "$raw"
fi
chmod 444 "$raw"
make_vdi "$raw" "$vdi"
echo "Debian 13 legacy image ready: $raw"
