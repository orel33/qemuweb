#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

prepare_debian_image() {
  # The caller's ID keeps downloaded source, raw output, and VDI output isolated
  # for each Debian cloud profile.
  local id="$1"
  local source_dir="$SOURCES/$id" raw="$IMAGES/$id.raw" vdi="$IMAGES/$id.vdi"
  local cloud_source sums url='https://cloud.debian.org/images/cloud/trixie/latest'
  # Not local: the EXIT trap below runs after this function has returned.
  temp_dir=''; qemu_pid=''
  mkdir -p "$source_dir"
  cloud_source="$source_dir/debian-13-genericcloud-amd64.qcow2"
  sums="$source_dir/SHA512SUMS"
  if prepare_sources; then
    fetch_file "$url/debian-13-genericcloud-amd64.qcow2" "$cloud_source"
    fetch_file "$url/SHA512SUMS" "$sums"
    # Verify the downloaded cloud image against Debian's published checksum list.
    (cd "$source_dir" && grep -E '[ *]debian-13-genericcloud-amd64\.qcow2$' SHA512SUMS | sha512sum -c -)
  fi
  if ! prepare_images; then return 0; fi

  if [[ ! -s "$raw" ]]; then
    [[ -s "$cloud_source" ]] || { echo "Missing source image: $cloud_source (run --sources first)." >&2; return 1; }
    require_commands qemu-system-x86_64 qemu-img genisoimage python3 base64
    # Fail in seconds, before any VM starts, when apt in the VM could not reach the mirrors.
    check_debian_mirrors "$id"
    temp_dir="$(mktemp -d "$RUNTIME/.$id-prepare.XXXXXX")"
    chmod 700 "$temp_dir"
    trap '[[ -n "${qemu_pid:-}" ]] && kill -TERM "$qemu_pid" 2>/dev/null || true; [[ -n "${temp_dir:-}" ]] && rm -rf "$temp_dir"' EXIT
    local overlay="$temp_dir/debian-bootstrap.qcow2" seed="$temp_dir/debian-seed.iso"
    local serial_log="$temp_dir/debian-serial.log" qmp_socket="$temp_dir/debian-qmp.sock"
    local user_data="$temp_dir/user-data" meta_data="$temp_dir/meta-data" network_config="$temp_dir/network-config"
    # Cloud-init creates the lab account, enables both consoles, and configures
    # the guest NIC for DHCP. The VDE switch itself does not provide DHCP.
    local hook_b64 unit_b64
    hook_b64="$(base64 -w 0 "$ROOT/scripts/prepare/resources/guest-start.sh")"
    unit_b64="$(base64 -w 0 "$ROOT/scripts/prepare/resources/qemuweb-start.service")"
    # The VM cannot see this shell's environment: give cloud-init the proxy for apt
    # (empty: none). The file it writes is removed again by the last runcmd.
    local apt_proxy_yaml='' guest_proxy
    if [[ -n "$PROXY_URL" ]]; then
      guest_proxy="$(guest_proxy_url)"
      apt_proxy_yaml="  http_proxy: \"$guest_proxy\""$'\n'"  https_proxy: \"$guest_proxy\""$'\n'
    fi
    cat > "$user_data" <<CLOUD_CONFIG
#cloud-config
hostname: qemuweb
manage_etc_hosts: true
ssh_pwauth: true
disable_root: false
package_update: true
# Match the Debian Legacy networking toolkit without pulling optional graphical
# and plotting packages recommended by tools such as Scapy.
apt:
${apt_proxy_yaml}  conf: |
    APT::Install-Recommends "false";
packages:
  # Console and download tools.
  - sudo
  - procps
  - nano
  - bash-completion
  - curl
  - wget
  # Network administration and diagnostics.
  - iproute2
  - net-tools
  - iputils-ping
  - traceroute
  - netcat-openbsd
  - tcpdump
  - bridge-utils
  - vlan
  - iptables
  # DNS and DHCP clients and servers.
  - dnsutils
  - dnsmasq
  - dnsmasq-utils
  - isc-dhcp-client
  - isc-dhcp-server
  # Capture, scanning, security, and VPN.
  - nmap
  - dsniff
  - python3-scapy
  - openssl
  - gnutls-bin
  - openvpn
  # Remote and legacy network services.
  - openssh-client
  - openssh-server
  - inetutils-telnet
  - inetutils-telnetd
  - tnftp
  - inetutils-ftpd
users:
  - name: toto
    groups: [sudo]
    shell: /bin/bash
    lock_passwd: false
chpasswd:
  expire: false
  users:
    - {name: toto, password: toto, type: text}
write_files:
  - path: /usr/local/sbin/qemuweb-guest-start
    permissions: '0755'
    encoding: b64
    content: $hook_b64
  - path: /etc/systemd/system/qemuweb-start.service
    permissions: '0644'
    encoding: b64
    content: $unit_b64
  - path: /etc/default/grub.d/99-qemuweb-ifnames.cfg
    permissions: '0644'
    content: |
      GRUB_CMDLINE_LINUX="\${GRUB_CMDLINE_LINUX:+\$GRUB_CMDLINE_LINUX }net.ifnames=0"
  - path: /etc/systemd/network/20-qemunet.network
    permissions: '0644'
    content: |
      [Match]
      Name=eth*
      [Network]
      DHCP=yes
runcmd:
  - [passwd, -d, root]
  - [systemctl, enable, serial-getty@ttyS0.service]
  - [systemctl, enable, serial-getty@ttyS1.service]
  - [systemctl, enable, getty@tty1.service]
  - [systemctl, enable, systemd-networkd.service]
  - [systemctl, enable, qemuweb-start.service]
  - [touch, /etc/cloud/cloud-init.disabled]
  # The build proxy must not stay in the image, which is used on other networks.
  - [rm, -f, /etc/apt/apt.conf.d/90cloud-init-aptproxy]
  # Finish the template with no fixed machine ID. This is the last guest-side
  # change before the temporary preparation VM is shut down.
  - [sh, -c, 'if update-grub && grep -q "net.ifnames=0" /boot/grub/grub.cfg && test -x /usr/sbin/ifconfig && command -v ping >/dev/null && command -v tcpdump >/dev/null && command -v nano >/dev/null; then : > /etc/machine-id && mkdir -p /var/lib/dbus && rm -f /var/lib/dbus/machine-id && ln -s /etc/machine-id /var/lib/dbus/machine-id && test ! -s /etc/machine-id && test "\$(readlink /var/lib/dbus/machine-id)" = /etc/machine-id && echo QEMUNET_IMAGE_PREPARED >/dev/ttyS0; else echo QEMUNET_IMAGE_SETUP_FAILED >/dev/ttyS0; exit 1; fi']
CLOUD_CONFIG
    cat > "$meta_data" <<EOF_META
instance-id: qemuweb-$id-$(date +%s)
local-hostname: qemuweb
EOF_META
    cat > "$network_config" <<'NETWORK_CONFIG'
# The first preparation boot still uses predictable en* names. After GRUB is
# updated, subsequent boots use eth* and the persistent networkd file above.
version: 2
ethernets:
  all-interfaces:
    match:
      name: "en*"
    dhcp4: true
NETWORK_CONFIG
    qemu-img create -f qcow2 -F qcow2 -b "$cloud_source" "$overlay"
    # Boot a temporary overlay so the downloaded base cloud image remains pristine.
    genisoimage -quiet -output "$seed" -volid cidata -joliet -rock "$user_data" "$meta_data" "$network_config"
    qemu-system-x86_64 -machine q35 -accel "$(prep_acceleration)" -m 1024 -smp 1 \
      -display none -monitor none -qmp "unix:$qmp_socket,server=on,wait=off" -serial "file:$serial_log" \
      -no-reboot -drive "file=$overlay,if=virtio,format=qcow2" \
      -drive "file=$seed,media=cdrom,readonly=on" -boot order=c -nic user,model=virtio-net-pci \
      >"$temp_dir/qemu.stdout" 2>"$temp_dir/qemu.stderr" &
    qemu_pid=$!
    echo "  Building the image in a VM (serial log: $serial_log)"
    # Success: our marker and cloud-init's last line are both in the log. Cloud-init
    # prints nothing while it installs packages, so a silent VM is only reported
    # (no stall limit); the total limit in lib/common.sh still applies.
    if ! watch_vm "Debian cloud image build of $id" "$qemu_pid" "$serial_log" \
        "$CLOUD_INIT_DONE" 0 0 CLOUD_INIT_FAILURES CLOUD_INIT_PHASES; then
      qemu_pid=''
      rm -f "$overlay"
      trap - EXIT
      echo "Preparation files preserved in $temp_dir" >&2
      exit 1
    fi
    # Ask the guest to shut down cleanly so cloud-init finishes before conversion.
    python3 - "$qmp_socket" <<'PY'
import json
import socket
import sys

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.settimeout(15)
sock.connect(sys.argv[1])
stream = sock.makefile('rwb', buffering=0)
json.loads(stream.readline())
stream.write(b'{"execute":"qmp_capabilities","id":1}\r\n')
while json.loads(stream.readline()).get('id') != 1: pass
stream.write(b'{"execute":"system_powerdown","id":2}\r\n')
while json.loads(stream.readline()).get('id') != 2: pass
stream.close()
PY
    wait "$qemu_pid"
    qemu_pid=''
    # Flatten the temporary qcow2 overlay into the RAW runtime image format.
    qemu-img convert -p -f qcow2 -O raw "$overlay" "$raw.tmp"
    chmod 444 "$raw.tmp"
    mv "$raw.tmp" "$raw"
    rm -rf "$temp_dir"
    temp_dir=''
    trap - EXIT
  fi
  chmod 444 "$raw"
  make_vdi "$raw" "$vdi"
  echo "Debian base ready: $raw"
}
