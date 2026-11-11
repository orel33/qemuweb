#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
parse_prepare_mode "$@"

# Keep the downloaded release archive and checksum file under the OpenWrt ID;
# migrate older top-level files if present.
source_dir="$SOURCES/openwrt"
raw="$IMAGES/openwrt.raw"
vdi="$IMAGES/openwrt.vdi"
archive=openwrt-25.12.6-x86-64-generic-ext4-combined.img.gz
url=https://downloads.openwrt.org/releases/25.12.6/targets/x86/64
mkdir -p "$source_dir"
if prepare_sources; then
  move_if_present "$SOURCES/$archive" "$source_dir/$archive"
  move_if_present "$SOURCES/sha256sums" "$source_dir/sha256sums"
  fetch_file "$url/$archive" "$source_dir/$archive"
  fetch_file "$url/sha256sums" "$source_dir/sha256sums"
  # Verify the release image against OpenWrt's published SHA-256 list.
  (cd "$source_dir" && grep -E "[ *]$archive$" sha256sums | sha256sum -c -)
fi
if ! prepare_images; then exit 0; fi
if [[ "${QEMUWEB_PREPARE_FORCE:-0}" != 1 ]]; then
  move_if_present "$IMAGES/openwrt-25.12.6-x86-64-qemunet.vdi" "$vdi"
fi
if [[ ! -s "$raw" ]]; then
  [[ -s "$source_dir/$archive" ]] || { echo "Missing source archive: $source_dir/$archive (run --sources first)." >&2; exit 1; }
  require_commands qemu-system-x86_64 qemu-img python3 base64
  temp_dir="$(mktemp -d "$RUNTIME/.openwrt-prepare.XXXXXX")"
  disk="$temp_dir/openwrt.raw"
  serial_socket="$temp_dir/openwrt-serial.sock"
  serial_log="$temp_dir/openwrt-serial.log"
  guest_script="$temp_dir/openwrt-prepare.sh"
  # OpenWrt has no adduser applet in this image. Create the regular lab account
  # explicitly, keep root passwordless, and persist the common hostname in UCI.
  cat > "$guest_script" <<'OPENWRT_PREPARE'
#!/bin/sh
set -eu
sed -i 's#^root:[^:]*:#root::#' /etc/shadow
sed -i '/^toto:/d' /etc/passwd
sed -i '/^toto:/d' /etc/group
sed -i '/^toto:/d' /etc/shadow
printf '%s\n' 'toto:x:1000:1000:toto:/home/toto:/bin/ash' >> /etc/passwd
printf '%s\n' 'toto:x:1000:' >> /etc/group
printf '%s\n' 'toto:$6$qemuweb$0QuT0CJj087ILV95eOwdT3u2MSv50m/qOO1ZcldVMPUpYOZwd0af9jbRPllLcoY5e1LrOK0EvYTVno41TJNIb1:0:0:99999:7:::' >> /etc/shadow
mkdir -p /home/toto
chown 1000:1000 /home/toto
if uci -q get 'system.@system[0]' >/dev/null; then
  uci set 'system.@system[0].hostname=qemuweb'
else
  uci set 'system.qemuweb=system'
  uci set 'system.qemuweb.hostname=qemuweb'
fi
uci commit system
printf 'qemuweb\n' > /proc/sys/kernel/hostname
# eth0 is OpenWrt's LAN port; the second temporary NIC supplies DHCP on the
# default eth1 WAN during image preparation. Neither NIC is part of the base.
attempt=0
until ip -4 route show default | grep -q 'dev eth1'; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || { echo 'OpenWrt preparation WAN did not get a route' >&2; exit 1; }
  sleep 1
done
apk -U add tcpdump nano
# The stock image has no hostname command, while the default start.sh uses it.
# Provide the get/set form needed by the guest startup script and lab console.
if ! command -v hostname >/dev/null 2>&1; then
  cat > /usr/bin/hostname <<'HOSTNAME_TOOL'
#!/bin/sh
case "$#" in
  0) cat /proc/sys/kernel/hostname ;;
  1) printf '%s\n' "$1" > /proc/sys/kernel/hostname ;;
  *) echo 'Usage: hostname [name]' >&2; exit 2 ;;
esac
HOSTNAME_TOOL
  chmod 755 /usr/bin/hostname
fi
for tool in ifconfig ping ip route traceroute nslookup nc tcpdump nano hostname; do
  command -v "$tool" >/dev/null || { echo "Missing OpenWrt tool: $tool" >&2; exit 1; }
done
# This lab image has one guest NIC at runtime. Keep its LAN address directly
# on eth0 instead of OpenWrt's stock br-lan bridge.
[ "$(uci -q get 'network.@device[0].name')" = br-lan ] || { echo 'Unexpected OpenWrt LAN device layout' >&2; exit 1; }
uci delete 'network.@device[0]'
uci set 'network.lan.device=eth0'
uci commit network
# A plain lab image must not hand out addresses on a static-IP-only LAN.
# Keep OpenWrt's LAN interface, but disable its stock DHCPv4, DHCPv6 and RA.
if uci -q get dhcp.lan >/dev/null; then
  uci set 'dhcp.lan.ignore=1'
  uci set 'dhcp.lan.dhcpv6=disabled'
  uci set 'dhcp.lan.ra=disabled'
fi
if uci -q get 'dhcp.@dnsmasq[0]' >/dev/null; then
  uci set 'dhcp.@dnsmasq[0].port=0'
fi
uci commit dhcp
/etc/init.d/odhcpd disable
OPENWRT_PREPARE
  cat >> "$guest_script" <<'OPENWRT_HOOK'
mkdir -p /usr/local/sbin
cat > /usr/local/sbin/qemuweb-guest-start <<'GUEST_HOOK'
OPENWRT_HOOK
  cat "$ROOT/scripts/prepare/resources/guest-start.sh" >> "$guest_script"
  cat >> "$guest_script" <<'OPENWRT_HOOK'
GUEST_HOOK
cat > /etc/init.d/qemuweb-guest-start <<'INIT_HOOK'
#!/bin/sh /etc/rc.common
START=99
start() { /usr/local/sbin/qemuweb-guest-start >/dev/ttyS0 2>&1; }
INIT_HOOK
chmod 755 /usr/local/sbin/qemuweb-guest-start /etc/init.d/qemuweb-guest-start
/etc/init.d/qemuweb-guest-start enable
# OpenWrt has no systemd machine-id generator; the guest hook creates a
# per-host value on the first boot from this generic image.
: > /etc/machine-id
test ! -s /etc/machine-id
sync
echo QEMUWEB_OPENWRT_PREPARED
OPENWRT_HOOK
  payload="$(base64 -w 0 "$guest_script")"
  gzip -dc "$source_dir/$archive" > "$disk"
  qemu-system-x86_64 -machine q35 -accel "$(prep_acceleration)" -m 256 -smp 1 \
    -display none -monitor none -serial "unix:$serial_socket,server=on,wait=off" -no-reboot \
    -drive "file=$disk,if=virtio,format=raw" -boot order=c \
    -netdev user,id=prep-lan,restrict=on -device virtio-net-pci,netdev=prep-lan \
    -netdev user,id=prep-wan -device virtio-net-pci,netdev=prep-wan \
    >"$temp_dir/qemu.stdout" 2>"$temp_dir/qemu.stderr" &
  qemu_pid=$!
  trap 'kill -TERM "$qemu_pid" 2>/dev/null || true; wait "$qemu_pid" 2>/dev/null || true' EXIT
  python3 - "$serial_socket" "$serial_log" "$payload" <<'PY'
import base64, os, re, shlex, socket, sys, time
socket_path, log_path, payload = sys.argv[1:]
deadline = time.monotonic() + 900
while not os.path.exists(socket_path):
    if time.monotonic() >= deadline: raise RuntimeError('OpenWrt serial socket unavailable')
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
            if not chunk: raise RuntimeError('OpenWrt serial console closed')
            log.write(chunk); log.flush(); buffer = (buffer + chunk)[-65536:]
            for index, pattern in enumerate(compiled):
                if pattern.search(buffer): return index
    raise RuntimeError('OpenWrt preparation timed out')
wait_for([rb'Please press Enter to activate this console'])
# The activation message appears before OpenWrt finishes loading late modules;
# an Enter sent immediately can be lost. Wait for the final network module.
wait_for([rb'NET: Registered PF_PPPOX protocol family'])
time.sleep(.2)
sock.sendall(b'\r')
prompt = rb'root@[^:\r\n]+:[^#\r\n]*#\s'
wait_for([prompt])
# OpenWrt has neither a base64 applet nor a large canonical serial input buffer.
# Decode on the host and rebuild the script with short, shell-quoted lines.
def command_at_prompt(command):
    global buffer
    buffer = b''
    sock.sendall(command.encode() + b'\r')
    wait_for([prompt])
command_at_prompt(': :; rm -f /tmp/qemuweb-prepare.sh')
script = base64.b64decode(payload).decode()
for line in script.splitlines():
    command_at_prompt(f"printf '%s\\n' {shlex.quote(line)} >>/tmp/qemuweb-prepare.sh")
command = 'sh /tmp/qemuweb-prepare.sh; status=$?; echo QEMUWEB_OPENWRT_STATUS_$status'
buffer = b''
sock.sendall(command.encode() + b'\r')
if wait_for([rb'QEMUWEB_OPENWRT_STATUS_0', rb'QEMUWEB_OPENWRT_STATUS_[1-9][0-9]*']) != 0:
    raise RuntimeError('OpenWrt customization failed')
sock.sendall(b'poweroff\r')
sock.close()
PY
  for _ in $(seq 1 60); do
    if ! kill -0 "$qemu_pid" 2>/dev/null; then break; fi
    sleep 1
  done
  if kill -0 "$qemu_pid" 2>/dev/null; then kill -TERM "$qemu_pid"; fi
  wait "$qemu_pid" || true
  trap - EXIT
  chmod 444 "$disk"
  mv "$disk" "$raw"
  rm -rf "$temp_dir"
fi
chmod 444 "$raw"
make_vdi "$raw" "$vdi"
echo "OpenWrt base ready: $raw"
