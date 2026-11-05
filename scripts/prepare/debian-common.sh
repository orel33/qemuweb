#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

prepare_debian_image() {
  # The caller's ID keeps downloaded source, raw output, and VDI output isolated
  # for each Debian cloud profile.
  local id="$1"
  local source_dir="$SOURCES/$id" raw="$IMAGES/$id.raw" vdi="$IMAGES/$id.vdi"
  local cloud_source sums url='https://cloud.debian.org/images/cloud/trixie/latest'
  local temp_dir='' qemu_pid=''
  mkdir -p "$source_dir"
  cloud_source="$source_dir/debian-13-genericcloud-amd64.qcow2"
  sums="$source_dir/SHA512SUMS"
  fetch_file "$url/debian-13-genericcloud-amd64.qcow2" "$cloud_source"
  fetch_file "$url/SHA512SUMS" "$sums"
  # Verify the downloaded cloud image against Debian's published checksum list.
  (cd "$source_dir" && grep -E '[ *]debian-13-genericcloud-amd64\.qcow2$' SHA512SUMS | sha512sum -c -)

  if [[ ! -s "$raw" ]]; then
    require_commands qemu-system-x86_64 qemu-img genisoimage python3
    temp_dir="$(mktemp -d "$RUNTIME/.$id-prepare.XXXXXX")"
    chmod 700 "$temp_dir"
    local overlay="$temp_dir/debian-bootstrap.qcow2" seed="$temp_dir/debian-seed.iso"
    local serial_log="$temp_dir/debian-serial.log" qmp_socket="$temp_dir/debian-qmp.sock"
    local user_data="$temp_dir/user-data" meta_data="$temp_dir/meta-data" network_config="$temp_dir/network-config"
    # Cloud-init creates the lab account, enables both consoles, and configures
    # the guest NIC for DHCP. The VDE switch itself does not provide DHCP.
    cat > "$user_data" <<CLOUD_CONFIG
#cloud-config
hostname: qemuweb
manage_etc_hosts: true
ssh_pwauth: true
disable_root: false
package_update: true
packages: []
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
  - path: /etc/systemd/network/20-qemunet.network
    permissions: '0644'
    content: |
      [Match]
      Name=en*
      [Network]
      DHCP=yes
runcmd:
  - [passwd, -d, root]
  - [systemctl, enable, serial-getty@ttyS0.service]
  - [systemctl, enable, getty@tty1.service]
  - [systemctl, enable, systemd-networkd.service]
  - [touch, /etc/cloud/cloud-init.disabled]
  - [sh, -c, 'echo QEMUNET_IMAGE_PREPARED >/dev/ttyS0']
CLOUD_CONFIG
    cat > "$meta_data" <<EOF_META
instance-id: qemuweb-$id-$(date +%s)
local-hostname: qemuweb
EOF_META
    cat > "$network_config" <<'NETWORK_CONFIG'
# Cloud-init's NoCloud seed also supplies DHCP configuration for matching NICs.
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
    local prepared=0
    for _ in $(seq 1 900); do
      if grep -q 'QEMUNET_IMAGE_PREPARED' "$serial_log" 2>/dev/null && grep -q 'Cloud-init v.* finished at' "$serial_log" 2>/dev/null; then prepared=1; break; fi
      if ! kill -0 "$qemu_pid" 2>/dev/null; then break; fi
      sleep 1
    done
    if [[ "$prepared" != 1 ]]; then
      echo "Debian preparation failed for $id. Last serial output:" >&2
      tail -n 80 "$serial_log" 2>/dev/null || true
      cat "$temp_dir/qemu.stderr" >&2 || true
      kill -TERM "$qemu_pid" 2>/dev/null || true
      wait "$qemu_pid" 2>/dev/null || true
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
  fi
  chmod 444 "$raw"
  make_vdi "$raw" "$vdi"
  echo "Debian base ready: $raw"
}
