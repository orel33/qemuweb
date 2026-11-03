#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="$ROOT/runtime"
ALPINE_VERSION=3.24.3
ALPINE="alpine-virt-$ALPINE_VERSION-x86_64.iso"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64"
DEBIAN_SOURCE="debian-13-genericcloud-amd64.qcow2"
DEBIAN_URL="https://cloud.debian.org/images/cloud/trixie/latest"
DEBIAN_RAW="debian-13-qemunet-amd64.raw"
DEBIAN_VDI="debian-13-qemunet-amd64.vdi"
OPENWRT_GZ="openwrt-25.12.6-x86-64-generic-ext4-combined.img.gz"
OPENWRT_URL="https://downloads.openwrt.org/releases/25.12.6/targets/x86/64"
OPENWRT_RAW="${OPENWRT_GZ%.gz}"
OPENWRT_VDI="openwrt-25.12.6-x86-64-qemunet.vdi"
PREP_QEMU_PID=""
PREP_DIR=""
mkdir -p "$RUNTIME"

cleanup() {
  if [[ -n "$PREP_QEMU_PID" ]] && kill -0 "$PREP_QEMU_PID" 2>/dev/null; then
    kill -TERM "$PREP_QEMU_PID" 2>/dev/null || true
    wait "$PREP_QEMU_PID" 2>/dev/null || true
  fi
  if [[ -n "$PREP_DIR" && -d "$PREP_DIR" ]]; then rm -rf "$PREP_DIR"; fi
}
trap cleanup EXIT

fetch() {
  local url="$1" target="$2"
  if [[ ! -s "$target" ]]; then curl -fL --retry 3 "$url" -o "$target"; fi
}

fetch "$ALPINE_URL/$ALPINE" "$RUNTIME/$ALPINE"
fetch "$ALPINE_URL/$ALPINE.sha256" "$RUNTIME/$ALPINE.sha256"
(cd "$RUNTIME" && sha256sum -c "$ALPINE.sha256")

fetch "$DEBIAN_URL/$DEBIAN_SOURCE" "$RUNTIME/$DEBIAN_SOURCE"
fetch "$DEBIAN_URL/SHA512SUMS" "$RUNTIME/debian-SHA512SUMS"
(cd "$RUNTIME" && grep -E "[ *]$DEBIAN_SOURCE$" debian-SHA512SUMS | sha512sum -c -)

fetch "$OPENWRT_URL/$OPENWRT_GZ" "$RUNTIME/$OPENWRT_GZ"
fetch "$OPENWRT_URL/sha256sums" "$RUNTIME/openwrt-sha256sums"
(cd "$RUNTIME" && grep -E "[ *]$OPENWRT_GZ$" openwrt-sha256sums | sha256sum -c -)
if [[ ! -s "$RUNTIME/$OPENWRT_RAW" ]]; then gzip -dk "$RUNTIME/$OPENWRT_GZ"; fi

if [[ ! -s "$RUNTIME/$DEBIAN_RAW" ]]; then
  for command in qemu-system-x86_64 qemu-img genisoimage python3; do
    command -v "$command" >/dev/null || { echo "Outil requis pour préparer Debian : $command" >&2; exit 1; }
  done

  PREP_DIR="$(mktemp -d "$RUNTIME/.debian-prepare.XXXXXX")"
  chmod 700 "$PREP_DIR"
  local_overlay="$PREP_DIR/debian-bootstrap.qcow2"
  seed_iso="$PREP_DIR/debian-seed.iso"
  serial_log="$PREP_DIR/debian-serial.log"
  qmp_socket="$PREP_DIR/debian-qmp.sock"
  user_data="$PREP_DIR/user-data"
  meta_data="$PREP_DIR/meta-data"
  network_config="$PREP_DIR/network-config"

  cat > "$user_data" <<'CLOUD_CONFIG'
#cloud-config
hostname: qemunet-demo
manage_etc_hosts: true
ssh_pwauth: true
users:
  - default
  - name: demo
    groups: [sudo]
    shell: /bin/bash
    lock_passwd: false
chpasswd:
  expire: false
  users:
    - {name: demo, password: serial-demo, type: text}
write_files:
  - path: /etc/systemd/network/20-qemunet.network
    permissions: '0644'
    content: |
      [Match]
      Name=en*
      [Network]
      DHCP=yes
runcmd:
  - [systemctl, enable, serial-getty@ttyS0.service]
  - [systemctl, enable, systemd-networkd.service]
  - [touch, /etc/cloud/cloud-init.disabled]
  - [sh, -c, 'echo QEMUNET_IMAGE_PREPARED >/dev/ttyS0']
CLOUD_CONFIG
  cat > "$meta_data" <<EOF_META
instance-id: qemunet-base-$(date +%s)
local-hostname: qemunet-demo
EOF_META
  cat > "$network_config" <<'NETWORK_CONFIG'
version: 2
ethernets:
  all-interfaces:
    match:
      name: "en*"
    dhcp4: true
NETWORK_CONFIG

  qemu-img create -f qcow2 -F qcow2 -b "$RUNTIME/$DEBIAN_SOURCE" "$local_overlay"
  genisoimage -quiet -output "$seed_iso" -volid cidata -joliet -rock "$user_data" "$meta_data" "$network_config"
  if [[ -r /dev/kvm && -w /dev/kvm ]]; then prep_accel=kvm; else prep_accel=tcg; fi
  qemu-system-x86_64 \
    -machine q35 -accel "$prep_accel" -m 1024 -smp 1 \
    -display none -monitor none -qmp "unix:$qmp_socket,server=on,wait=off" -serial "file:$serial_log" \
    -no-reboot -drive "file=$local_overlay,if=virtio,format=qcow2" \
    -drive "file=$seed_iso,media=cdrom,readonly=on" -boot order=c -nic user,restrict=on \
    >"$PREP_DIR/qemu.stdout" 2>"$PREP_DIR/qemu.stderr" &
  PREP_QEMU_PID=$!

  echo "Préparation Debian 13 : premier démarrage isolé pour intégrer le compte demo et la console série…"
  prepared=0
  for _ in $(seq 1 300); do
    if grep -q 'QEMUNET_IMAGE_PREPARED' "$serial_log" 2>/dev/null && grep -q 'Cloud-init v.* finished at' "$serial_log" 2>/dev/null; then
      prepared=1
      break
    fi
    if ! kill -0 "$PREP_QEMU_PID" 2>/dev/null; then break; fi
    sleep 1
  done
  if [[ "$prepared" != 1 ]]; then
    echo "Échec de la préparation cloud-init Debian. Dernière sortie série :" >&2
    tail -n 60 "$serial_log" 2>/dev/null || true
    cat "$PREP_DIR/qemu.stderr" >&2 || true
    exit 1
  fi

  python3 - "$qmp_socket" <<'PY'
import json
import socket
import sys

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.settimeout(15)
sock.connect(sys.argv[1])
stream = sock.makefile('rwb', buffering=0)

def receive_reply(command_id):
    while True:
        line = stream.readline()
        if not line:
            raise RuntimeError('QMP fermé avant la réponse')
        message = json.loads(line)
        if message.get('id') == command_id:
            if 'error' in message:
                raise RuntimeError(message['error'])
            return

# Le premier message est l’accueil QMP.
json.loads(stream.readline())
stream.write(b'{"execute":"qmp_capabilities","id":1}\r\n')
receive_reply(1)
stream.write(b'{"execute":"system_powerdown","id":2}\r\n')
receive_reply(2)
stream.close()
sock.close()
PY
  wait "$PREP_QEMU_PID"
  PREP_QEMU_PID=""
  rm -f "$RUNTIME/$DEBIAN_RAW.tmp"
  qemu-img convert -p -f qcow2 -O raw "$local_overlay" "$RUNTIME/$DEBIAN_RAW.tmp"
  chmod 444 "$RUNTIME/$DEBIAN_RAW.tmp"
  mv "$RUNTIME/$DEBIAN_RAW.tmp" "$RUNTIME/$DEBIAN_RAW"
  rm -rf "$PREP_DIR"
  PREP_DIR=""
  echo "Base Debian RAW prête en lecture seule : $RUNTIME/$DEBIAN_RAW"
fi

if [[ ! -s "$RUNTIME/$DEBIAN_VDI" ]]; then
  rm -f "$RUNTIME/$DEBIAN_VDI.tmp"
  qemu-img convert -p -f raw -O vdi "$RUNTIME/$DEBIAN_RAW" "$RUNTIME/$DEBIAN_VDI.tmp"
  chmod 444 "$RUNTIME/$DEBIAN_VDI.tmp"
  mv "$RUNTIME/$DEBIAN_VDI.tmp" "$RUNTIME/$DEBIAN_VDI"
fi
if [[ ! -s "$RUNTIME/$OPENWRT_VDI" ]]; then
  rm -f "$RUNTIME/$OPENWRT_VDI.tmp"
  qemu-img convert -p -f raw -O vdi "$RUNTIME/$OPENWRT_RAW" "$RUNTIME/$OPENWRT_VDI.tmp"
  chmod 444 "$RUNTIME/$OPENWRT_VDI.tmp"
  mv "$RUNTIME/$OPENWRT_VDI.tmp" "$RUNTIME/$OPENWRT_VDI"
fi
chmod 444 "$RUNTIME/$ALPINE" "$RUNTIME/$DEBIAN_RAW" "$RUNTIME/$DEBIAN_VDI" "$RUNTIME/$OPENWRT_RAW" "$RUNTIME/$OPENWRT_VDI"

cat > "$RUNTIME/catalog.json" <<JSON
[
  {
    "id": "alpine",
    "label": "Alpine Linux 3.24",
    "description": "Console live, sans disque ni réseau",
    "kind": "iso",
    "iso": "$ALPINE",
    "memory": 512,
    "login": "root, sans mot de passe",
    "network": "Désactivé"
  },
  {
    "id": "debian13",
    "label": "Debian 13",
    "description": "Image RAW préparée, disque de travail éphémère",
    "kind": "raw",
    "disk": "$DEBIAN_RAW",
    "vdi": "$DEBIAN_VDI",
    "format": "raw",
    "memory": 1024,
    "login": "demo / serial-demo",
    "qemuNic": "user,restrict=on",
    "vboxNic": "nat",
    "network": "DHCP restreint dans QEMU ; NAT dans VirtualBox"
  },
  {
    "id": "openwrt",
    "label": "OpenWrt 25.12 x86-64",
    "description": "Image RAW, disque de travail éphémère",
    "kind": "raw",
    "disk": "$OPENWRT_RAW",
    "vdi": "$OPENWRT_VDI",
    "format": "raw",
    "memory": 256,
    "login": "Entrée puis root, sans mot de passe",
    "network": "Désactivé"
  }
]
JSON

echo "Bases prêtes et en lecture seule dans $RUNTIME."
echo "QEMU utilisera des overlays QCOW2 ; VirtualBox des disques différentiels VDI."
