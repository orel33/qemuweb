#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
source "$(dirname "$0")/lib/guest-scripts.sh"
parse_prepare_mode "$@"

# Keep the downloaded release archive and checksum file under the OpenWrt ID;
# migrate older top-level files if present.
source_dir="$SOURCES/openwrt"
raw="$IMAGES/openwrt.raw"
vdi="$IMAGES/openwrt.vdi"
archive=openwrt-25.12.6-x86-64-generic-ext4-combined.img.gz
release_url=https://downloads.openwrt.org/releases/25.12.6
url=$release_url/targets/x86/64
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
  # Fail in seconds, before any VM starts, when the package feeds that the VM's apk reads (the distfeeds
  # of the image: this release, x86_64, base and packages) are not reachable through the proxy.
  check_build_urls openwrt 'the OpenWrt package feeds' \
    "$release_url/packages/x86_64/base/packages.adb" "$release_url/packages/x86_64/packages/packages.adb"
  guest_proxy_note
  PREPARE_NETWORK_HOST='downloads.openwrt.org'
  temp_dir="$(mktemp -d "$RUNTIME/.openwrt-prepare.XXXXXX")"
  disk="$temp_dir/openwrt.raw"
  serial_socket="$temp_dir/openwrt-serial.sock"
  serial_log="$temp_dir/openwrt-serial.log"
  guest_script="$temp_dir/openwrt-prepare.sh"
  # The script that runs inside the temporary OpenWrt VM (see lib/guest-scripts.sh), with the proxy if any.
  openwrt_guest_script "$guest_script"
  payload="$(base64 -w 0 "$guest_script")"
  gzip -dc "$source_dir/$archive" > "$disk"
  qemu-system-x86_64 -machine q35 -accel "$(prep_acceleration)" -m 256 -smp 1 \
    -display none -monitor none -serial "unix:$serial_socket,server=on,wait=off" -no-reboot \
    -drive "file=$disk,if=virtio,format=raw" -boot order=c \
    -netdev user,id=prep-lan,restrict=on -device virtio-net-pci,netdev=prep-lan \
    -netdev user,id=prep-wan -device virtio-net-pci,netdev=prep-wan \
    >"$temp_dir/qemu.stdout" 2>"$temp_dir/qemu.stderr" &
  qemu_pid=$!
  # On any exit before the disk is published, stop the VM and drop the temporary disk (about
  # 100 MB). After a failure keep the small serial log and guest script, which show where the
  # preparation stopped, and print their location.
  cleanup_openwrt_prepare() {
    local status=$?
    if [[ -n "${driver_pid:-}" ]]; then kill -TERM "$driver_pid" 2>/dev/null || true; fi
    kill -TERM "$qemu_pid" 2>/dev/null || true
    wait "$qemu_pid" 2>/dev/null || true
    rm -f "$disk"
    if (( status != 0 )); then echo "OpenWrt preparation files preserved in $temp_dir" >&2
    else rm -rf "$temp_dir"; fi
  }
  trap cleanup_openwrt_prepare EXIT
  # The driver runs in the background: it writes the serial log, which watch_vm (lib/common.sh) reads to
  # draw the progress line and to stop the build at once on a failure that will not recover.
  python3 - "$serial_socket" "$serial_log" "$payload" <<'PY' &
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
    print(buffer.decode(errors='replace')[-3000:], file=sys.stderr)
    raise RuntimeError('OpenWrt customization failed')
sock.sendall(b'poweroff\r')
sock.close()
PY
  driver_pid=$!
  build_follow_info "Customizing OpenWrt in a VM" "$serial_log" "$serial_socket" serial
  if ! watch_vm 'OpenWrt build' "$driver_pid" "$serial_log" "$OPENWRT_DONE" 1 300 OPENWRT_FAILURES OPENWRT_PHASES; then
    driver_pid=''
    exit 1   # the VM is stopped and the log directory kept by cleanup_openwrt_prepare
  fi
  wait "$driver_pid"   # the driver exited 0 once the build script reported success
  driver_pid=''
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
