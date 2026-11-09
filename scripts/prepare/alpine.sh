#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
# Alpine's inputs and outputs live under its own ID, while older files are
# moved into this layout to preserve existing downloads and prepared images.
source_dir="$SOURCES/alpine"
raw="$IMAGES/alpine.raw"
vdi="$IMAGES/alpine.vdi"
version=3.24.3
iso="alpine-virt-$version-x86_64.iso"
url="https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64"
mkdir -p "$source_dir"
move_if_present "$SOURCES/$iso" "$source_dir/$iso"
move_if_present "$SOURCES/$iso.sha256" "$source_dir/$iso.sha256"
move_if_present "$IMAGES/alpine-$version-qemunet-x86_64.raw" "$raw"
move_if_present "$IMAGES/alpine-$version-qemunet-x86_64.vdi" "$vdi"
fetch_file "$url/$iso" "$source_dir/$iso"
fetch_file "$url/$iso.sha256" "$source_dir/$iso.sha256"
# Do not build from an ISO unless its publisher-provided checksum matches.
(cd "$source_dir" && sha256sum -c "$iso.sha256")

if [[ ! -s "$raw" ]]; then
  require_commands qemu-system-x86_64 qemu-img python3 base64
  temp_dir="$(mktemp -d "$RUNTIME/.alpine-prepare.XXXXXX")"
  disk="$temp_dir/alpine.raw"
  serial_socket="$temp_dir/alpine-serial.sock"
  serial_log="$temp_dir/alpine-serial.log"
  guest_script="$temp_dir/alpine-prepare.sh"
  # This script runs inside the temporary Alpine VM: install to a virtio disk,
  # create lab accounts, and make the serial console usable on every boot.
  cat > "$guest_script" <<'ALPINE_PREPARE'
#!/bin/sh
set -eu
passwd -d root
if ! id toto >/dev/null 2>&1; then adduser -D -s /bin/ash toto; fi
echo 'toto:toto' | chpasswd
lbu add /home/toto
grep -qxF ttyS0 /etc/securetty || echo ttyS0 >> /etc/securetty
grep -q '^ttyS0::respawn:' /etc/inittab || echo 'ttyS0::respawn:/sbin/getty -L ttyS0 115200 vt100' >> /etc/inittab
cat > /tmp/qemunet-answers <<'ANSWERS'
KEYMAPOPTS=none
HOSTNAMEOPTS=qemuweb
DEVDOPTS=mdev
INTERFACESOPTS="auto lo
iface lo inet loopback

auto eth0
iface eth0 inet dhcp
hostname qemuweb
"
TIMEZONEOPTS="UTC"
PROXYOPTS=none
APKREPOSOPTS="-1"
USEROPTS=none
SSHDOPTS=none
NTPOPTS=none
DISKOPTS="-m sys -s 0 /dev/vda"
LBUOPTS=none
APKCACHEOPTS=none
export KERNELOPTS="quiet console=ttyS0,115200"
ANSWERS
ERASE_DISKS=/dev/vda setup-alpine -e -f /tmp/qemunet-answers
ALPINE_PREPARE
  cat >> "$guest_script" <<'ALPINE_HOOK'
target=''
for partition in /dev/vda3 /dev/vda2 /dev/vda4; do
  if mount "$partition" /mnt 2>/dev/null; then
    if [ -f /mnt/etc/alpine-release ]; then target=/mnt; break; fi
    umount /mnt
  fi
done
[ -n "$target" ] || { echo 'Alpine installed root partition not found'; exit 1; }
mkdir -p "$target/usr/local/sbin" "$target/etc/init.d" "$target/etc/runlevels/default"
cat > "$target/usr/local/sbin/qemuweb-guest-start" <<'GUEST_HOOK'
ALPINE_HOOK
  cat "$ROOT/scripts/prepare/guest-start.sh" >> "$guest_script"
  cat >> "$guest_script" <<'ALPINE_HOOK'
GUEST_HOOK
cat > "$target/etc/init.d/qemuweb-guest-start" <<'INIT_HOOK'
#!/sbin/openrc-run
description="Run QemuWeb guest startup media"
depend() { after local; }
start() { ebegin "QemuWeb guest startup"; /usr/local/sbin/qemuweb-guest-start >/dev/ttyS0 2>&1; eend $?; }
INIT_HOOK
chmod 755 "$target/usr/local/sbin/qemuweb-guest-start" "$target/etc/init.d/qemuweb-guest-start"
ln -sf /etc/init.d/qemuweb-guest-start "$target/etc/runlevels/default/qemuweb-guest-start"
umount "$target"
sync
echo QEMUNET_ALPINE_PREPARED
ALPINE_HOOK
  payload="$(base64 -w 0 "$guest_script")"
  # Boot the installer with a temporary user-mode NIC for package/repository
  # access; this is only for image preparation, not the resulting LAN topology.
  qemu-img create -f raw "$disk" 2G
  qemu-system-x86_64 -machine q35 -accel "$(prep_acceleration)" -m 768 -smp 1 \
    -display none -monitor none -serial "unix:$serial_socket,server=on,wait=off" -no-reboot \
    -drive "file=$disk,if=virtio,format=raw" \
    -drive "file=$source_dir/$iso,media=cdrom,readonly=on" -boot order=d \
    -nic user,model=virtio-net-pci >"$temp_dir/qemu.stdout" 2>"$temp_dir/qemu.stderr" &
  qemu_pid=$!
  python3 - "$serial_socket" "$serial_log" "$payload" <<'PY'
import os, re, socket, sys, time
socket_path, log_path, payload = sys.argv[1:]
deadline = time.monotonic() + 900
while not os.path.exists(socket_path):
    if time.monotonic() >= deadline: raise RuntimeError('Alpine serial socket unavailable')
    time.sleep(.1)
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(socket_path)
sock.settimeout(1)
buffer = b''
def wait_for(patterns):
    global buffer
    compiled = [re.compile(pattern) for pattern in patterns]
    with open(log_path, 'ab') as log:
        while time.monotonic() < deadline:
            try: chunk = sock.recv(4096)
            except TimeoutError: continue
            if not chunk: raise RuntimeError('Alpine serial console closed')
            log.write(chunk); log.flush(); buffer = (buffer + chunk)[-65536:]
            for index, pattern in enumerate(compiled):
                if pattern.search(buffer): return index
    raise RuntimeError('Alpine preparation timed out')
wait_for([rb'login:\s*$'])
sock.sendall(b'root\r')
wait_for([rb':~#\s*$'])
def command_at_prompt(command):
    global buffer
    buffer = b''
    sock.sendall(command.encode() + b'\r')
    wait_for([rb':~#\s*$'])
command_at_prompt(': > /tmp/qemunet-prepare.b64')
for offset in range(0, len(payload), 400):
    command_at_prompt(f"printf '%s' '{payload[offset:offset + 400]}' >> /tmp/qemunet-prepare.b64")
command = 'base64 -d /tmp/qemunet-prepare.b64 >/tmp/qemunet-prepare.sh && sh /tmp/qemunet-prepare.sh; status=$?; echo QEMUNET_ALPINE_STATUS_$status'
buffer = b''
sock.sendall(command.encode() + b'\r')
if wait_for([rb'QEMUNET_ALPINE_STATUS_0', rb'QEMUNET_ALPINE_STATUS_[1-9][0-9]*']) != 0:
    raise RuntimeError('Alpine installation failed')
sock.close()
PY
  kill -TERM "$qemu_pid"
  wait "$qemu_pid" || true
  chmod 444 "$disk"
  # Publish the completed disk only after the guest preparation has succeeded.
  mv "$disk" "$raw"
  rm -rf "$temp_dir"
fi
chmod 444 "$raw"
make_vdi "$raw" "$vdi"
echo "Alpine base ready: $raw"
