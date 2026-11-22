#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
source "$(dirname "$0")/lib/guest-scripts.sh"
parse_prepare_mode "$@"
# Alpine's inputs and outputs live under its own ID, while older files are
# moved into this layout to preserve existing downloads and prepared images.
source_dir="$SOURCES/alpine"
raw="$IMAGES/alpine.raw"
vdi="$IMAGES/alpine.vdi"
version=3.24.3
iso="alpine-virt-$version-x86_64.iso"
repo_url="https://dl-cdn.alpinelinux.org/alpine/v3.24"
url="$repo_url/releases/x86_64"
mkdir -p "$source_dir"
if prepare_sources; then
  move_if_present "$SOURCES/$iso" "$source_dir/$iso"
  move_if_present "$SOURCES/$iso.sha256" "$source_dir/$iso.sha256"
  fetch_file "$url/$iso" "$source_dir/$iso"
  fetch_file "$url/$iso.sha256" "$source_dir/$iso.sha256"
  # Do not build from an ISO unless its publisher-provided checksum matches.
  (cd "$source_dir" && sha256sum -c "$iso.sha256")
fi
if ! prepare_images; then exit 0; fi
if [[ "${QEMUWEB_PREPARE_FORCE:-0}" != 1 ]]; then
  move_if_present "$IMAGES/alpine-$version-qemunet-x86_64.raw" "$raw"
  move_if_present "$IMAGES/alpine-$version-qemunet-x86_64.vdi" "$vdi"
fi

if [[ ! -s "$raw" ]]; then
  [[ -s "$source_dir/$iso" ]] || { echo "Missing source ISO: $source_dir/$iso (run --sources first)." >&2; exit 1; }
  require_commands qemu-system-x86_64 qemu-img python3 base64
  # Fail in seconds, before any VM starts, when the installer could not reach the Alpine servers: the mirror
  # list that setup-alpine reads, then the package indexes of the two repositories the build uses.
  check_build_urls alpine 'the Alpine servers' "https://mirrors.alpinelinux.org/mirrors.txt" \
    "$repo_url/main/x86_64/APKINDEX.tar.gz" "$repo_url/community/x86_64/APKINDEX.tar.gz"
  guest_proxy_note
  PREPARE_NETWORK_HOST='dl-cdn.alpinelinux.org or mirrors.alpinelinux.org'
  temp_dir="$(mktemp -d "$RUNTIME/.alpine-prepare.XXXXXX")"
  disk="$temp_dir/alpine.raw"
  serial_socket="$temp_dir/alpine-serial.sock"
  serial_log="$temp_dir/alpine-serial.log"
  guest_script="$temp_dir/alpine-prepare.sh"
  # The script that runs inside the temporary Alpine VM (see lib/guest-scripts.sh), with the proxy if any.
  alpine_guest_script "$guest_script"
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
  # On any exit before the disk is published, stop the VM and drop the temporary disk (about
  # 100 MB). After a failure keep the small serial log and guest script, which show where the
  # preparation stopped, and print their location.
  cleanup_alpine_prepare() {
    local status=$?
    if [[ -n "${driver_pid:-}" ]]; then kill -TERM "$driver_pid" 2>/dev/null || true; fi
    kill -TERM "$qemu_pid" 2>/dev/null || true
    wait "$qemu_pid" 2>/dev/null || true
    rm -f "$disk"
    if (( status != 0 )); then echo "Alpine preparation files preserved in $temp_dir" >&2
    else rm -rf "$temp_dir"; fi
  }
  trap cleanup_alpine_prepare EXIT
  # The driver runs in the background: it writes the serial log, which watch_vm (lib/common.sh) reads to
  # draw the progress line and to stop the build at once on a failure that will not recover.
  python3 - "$serial_socket" "$serial_log" "$payload" <<'PY' &
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
  driver_pid=$!
  build_log_info "Installing Alpine in a VM" "$serial_log"
  if ! watch_vm 'Alpine build' "$driver_pid" "$serial_log" "$ALPINE_DONE" 1 300 ALPINE_FAILURES ALPINE_PHASES; then
    driver_pid=''
    exit 1   # the VM is stopped and the log directory kept by cleanup_alpine_prepare
  fi
  wait "$driver_pid"   # the driver exited 0 once the build script reported success
  driver_pid=''
  kill -TERM "$qemu_pid"
  wait "$qemu_pid" || true
  trap - EXIT
  chmod 444 "$disk"
  # Publish the completed disk only after the guest preparation has succeeded.
  mv "$disk" "$raw"
  rm -rf "$temp_dir"
fi
chmod 444 "$raw"
make_vdi "$raw" "$vdi"
echo "Alpine base ready: $raw"
