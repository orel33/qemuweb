#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
IMAGES="$ROOT/images"
RUNTIME="$ROOT/runtime"
ALPINE_VERSION=3.24.3
ALPINE_ISO="alpine-virt-$ALPINE_VERSION-x86_64.iso"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64"
ALPINE_RAW="alpine-$ALPINE_VERSION-qemunet-x86_64.raw"
ALPINE_VDI="alpine-$ALPINE_VERSION-qemunet-x86_64.vdi"
DEBIAN_SOURCE="debian-13-genericcloud-amd64.qcow2"
DEBIAN_URL="https://cloud.debian.org/images/cloud/trixie/latest"
DEBIAN_RAW="debian-13-qemunet-v2-amd64.raw"
DEBIAN_VDI="debian-13-qemunet-v2-amd64.vdi"
OPENWRT_GZ="openwrt-25.12.6-x86-64-generic-ext4-combined.img.gz"
OPENWRT_URL="https://downloads.openwrt.org/releases/25.12.6/targets/x86/64"
OPENWRT_RAW="${OPENWRT_GZ%.gz}"
OPENWRT_VDI="openwrt-25.12.6-x86-64-qemunet.vdi"
PREP_QEMU_PID=""
PREP_DIR=""
mkdir -p "$IMAGES" "$RUNTIME"

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

# Migration sans copie des images créées par les versions précédentes du projet.
# Les anciens serveurs peuvent continuer à utiliser leur lien dans runtime/.
for legacy_file in \
  "$ALPINE_ISO" "$ALPINE_ISO.sha256" "$ALPINE_RAW" "$ALPINE_VDI" \
  "$DEBIAN_SOURCE" debian-SHA512SUMS "$DEBIAN_RAW" "$DEBIAN_VDI" \
  "$OPENWRT_GZ" openwrt-sha256sums "$OPENWRT_RAW" "$OPENWRT_VDI"; do
  if [[ ! -e "$IMAGES/$legacy_file" && -f "$RUNTIME/$legacy_file" ]]; then
    ln "$RUNTIME/$legacy_file" "$IMAGES/$legacy_file"
  fi
done

fetch "$ALPINE_URL/$ALPINE_ISO" "$IMAGES/$ALPINE_ISO"
fetch "$ALPINE_URL/$ALPINE_ISO.sha256" "$IMAGES/$ALPINE_ISO.sha256"
(cd "$IMAGES" && sha256sum -c "$ALPINE_ISO.sha256")

fetch "$DEBIAN_URL/$DEBIAN_SOURCE" "$IMAGES/$DEBIAN_SOURCE"
fetch "$DEBIAN_URL/SHA512SUMS" "$IMAGES/debian-SHA512SUMS"
(cd "$IMAGES" && grep -E "[ *]$DEBIAN_SOURCE$" debian-SHA512SUMS | sha512sum -c -)

fetch "$OPENWRT_URL/$OPENWRT_GZ" "$IMAGES/$OPENWRT_GZ"
fetch "$OPENWRT_URL/sha256sums" "$IMAGES/openwrt-sha256sums"
(cd "$IMAGES" && grep -E "[ *]$OPENWRT_GZ$" openwrt-sha256sums | sha256sum -c -)
if [[ ! -s "$IMAGES/$OPENWRT_RAW" ]]; then gzip -dk "$IMAGES/$OPENWRT_GZ"; fi

if [[ ! -s "$IMAGES/$ALPINE_RAW" ]]; then
  for command in qemu-system-x86_64 qemu-img python3 base64; do
    command -v "$command" >/dev/null || { echo "Outil requis pour préparer Alpine : $command" >&2; exit 1; }
  done

  PREP_DIR="$(mktemp -d "$RUNTIME/.alpine-prepare.XXXXXX")"
  chmod 700 "$PREP_DIR"
  alpine_disk="$PREP_DIR/alpine.raw"
  serial_socket="$PREP_DIR/alpine-serial.sock"
  serial_log="$PREP_DIR/alpine-serial.log"
  guest_script="$PREP_DIR/alpine-prepare.sh"

  cat > "$guest_script" <<'ALPINE_PREPARE'
#!/bin/sh
set -eu

passwd -d root
if ! id toto >/dev/null 2>&1; then
  adduser -D -s /bin/ash toto
fi
echo 'toto:toto' | chpasswd
lbu add /home/toto

grep -qxF 'ttyS0' /etc/securetty || echo 'ttyS0' >> /etc/securetty
grep -q '^ttyS0::respawn:' /etc/inittab || echo 'ttyS0::respawn:/sbin/getty -L ttyS0 115200 vt100' >> /etc/inittab

cat > /tmp/qemunet-answers <<'ANSWERS'
KEYMAPOPTS=none
HOSTNAMEOPTS=alpine
DEVDOPTS=mdev
INTERFACESOPTS="auto lo
iface lo inet loopback

auto eth0
iface eth0 inet dhcp
hostname alpine
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
sync
echo QEMUNET_ALPINE_PREPARED
ALPINE_PREPARE
  guest_payload="$(base64 -w 0 "$guest_script")"

  qemu-img create -f raw "$alpine_disk" 2G
  if command -v VBoxManage >/dev/null 2>&1 && [[ -n "$(VBoxManage list runningvms 2>/dev/null || true)" ]]; then
    prep_accel=tcg
  elif [[ -r /dev/kvm && -w /dev/kvm ]]; then
    prep_accel=kvm
  else
    prep_accel=tcg
  fi

  qemu-system-x86_64 \
    -machine q35 -accel "$prep_accel" -m 768 -smp 1 \
    -display none -monitor none -serial "unix:$serial_socket,server=on,wait=off" \
    -no-reboot -drive "file=$alpine_disk,if=virtio,format=raw" \
    -drive "file=$IMAGES/$ALPINE_ISO,media=cdrom,readonly=on" -boot order=d \
    -nic user,model=virtio-net-pci \
    >"$PREP_DIR/qemu.stdout" 2>"$PREP_DIR/qemu.stderr" &
  PREP_QEMU_PID=$!

  echo "Préparation Alpine $ALPINE_VERSION : installation de l’ISO officielle dans une base RAW…"
  python3 - "$serial_socket" "$serial_log" "$guest_payload" <<'PY'
import re
import socket
import sys
import time

socket_path, log_path, payload = sys.argv[1:]
deadline = time.monotonic() + 900

while not __import__('os').path.exists(socket_path):
    if time.monotonic() >= deadline:
        raise RuntimeError('socket série Alpine indisponible')
    time.sleep(0.1)

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(socket_path)
sock.settimeout(1)
buffer = b''

def wait_for(patterns):
    global buffer
    compiled = [re.compile(pattern) for pattern in patterns]
    with open(log_path, 'ab') as log:
        while time.monotonic() < deadline:
            try:
                chunk = sock.recv(4096)
            except TimeoutError:
                continue
            if not chunk:
                raise RuntimeError('console série Alpine fermée prématurément')
            log.write(chunk)
            log.flush()
            buffer = (buffer + chunk)[-65536:]
            for index, pattern in enumerate(compiled):
                if pattern.search(buffer):
                    return index
    raise RuntimeError('expiration du délai de préparation Alpine')

wait_for([rb'login:\s*$'])
sock.sendall(b'root\r')
wait_for([rb':~#\s*$'])
command = f"echo {payload} | base64 -d >/tmp/qemunet-prepare.sh && sh /tmp/qemunet-prepare.sh; status=$?; echo QEMUNET_ALPINE_STATUS_$status"
sock.sendall(command.encode() + b'\r')
result = wait_for([rb'QEMUNET_ALPINE_STATUS_0', rb'QEMUNET_ALPINE_STATUS_[1-9][0-9]*'])
if result != 0:
    raise RuntimeError('le script d’installation Alpine a échoué')
sock.close()
PY
  # L’image est synchronisée par le script invité. QEMU est arrêté côté hôte :
  # l’ISO live ne garantit pas de quitter l’émulateur après poweroff sur ttyS0.
  kill -TERM "$PREP_QEMU_PID"
  wait "$PREP_QEMU_PID"
  PREP_QEMU_PID=""
  chmod 444 "$alpine_disk"
  mv "$alpine_disk" "$IMAGES/$ALPINE_RAW"
  rm -rf "$PREP_DIR"
  PREP_DIR=""
  echo "Base Alpine RAW prête en lecture seule : $IMAGES/$ALPINE_RAW"
fi

if [[ ! -s "$IMAGES/$DEBIAN_RAW" ]]; then
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
disable_root: false
users:
  - default
  - name: demo
    groups: [sudo]
    shell: /bin/bash
    lock_passwd: false
  - name: toto
    groups: [sudo]
    shell: /bin/bash
    lock_passwd: false
chpasswd:
  expire: false
  users:
    - {name: demo, password: serial-demo, type: text}
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

  qemu-img create -f qcow2 -F qcow2 -b "$IMAGES/$DEBIAN_SOURCE" "$local_overlay"
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
  rm -f "$IMAGES/$DEBIAN_RAW.tmp"
  qemu-img convert -p -f qcow2 -O raw "$local_overlay" "$IMAGES/$DEBIAN_RAW.tmp"
  chmod 444 "$IMAGES/$DEBIAN_RAW.tmp"
  mv "$IMAGES/$DEBIAN_RAW.tmp" "$IMAGES/$DEBIAN_RAW"
  rm -rf "$PREP_DIR"
  PREP_DIR=""
  echo "Base Debian RAW prête en lecture seule : $IMAGES/$DEBIAN_RAW"
fi

if [[ ! -s "$IMAGES/$DEBIAN_VDI" ]]; then
  rm -f "$IMAGES/$DEBIAN_VDI.tmp"
  qemu-img convert -p -f raw -O vdi "$IMAGES/$DEBIAN_RAW" "$IMAGES/$DEBIAN_VDI.tmp"
  chmod 444 "$IMAGES/$DEBIAN_VDI.tmp"
  mv "$IMAGES/$DEBIAN_VDI.tmp" "$IMAGES/$DEBIAN_VDI"
fi
if [[ ! -s "$IMAGES/$ALPINE_VDI" ]]; then
  rm -f "$IMAGES/$ALPINE_VDI.tmp"
  qemu-img convert -p -f raw -O vdi "$IMAGES/$ALPINE_RAW" "$IMAGES/$ALPINE_VDI.tmp"
  chmod 444 "$IMAGES/$ALPINE_VDI.tmp"
  mv "$IMAGES/$ALPINE_VDI.tmp" "$IMAGES/$ALPINE_VDI"
fi
if [[ ! -s "$IMAGES/$OPENWRT_VDI" ]]; then
  rm -f "$IMAGES/$OPENWRT_VDI.tmp"
  qemu-img convert -p -f raw -O vdi "$IMAGES/$OPENWRT_RAW" "$IMAGES/$OPENWRT_VDI.tmp"
  chmod 444 "$IMAGES/$OPENWRT_VDI.tmp"
  mv "$IMAGES/$OPENWRT_VDI.tmp" "$IMAGES/$OPENWRT_VDI"
fi
chmod 444 "$IMAGES/$ALPINE_ISO" "$IMAGES/$ALPINE_RAW" "$IMAGES/$ALPINE_VDI" "$IMAGES/$DEBIAN_RAW" "$IMAGES/$DEBIAN_VDI" "$IMAGES/$OPENWRT_RAW" "$IMAGES/$OPENWRT_VDI"

cat > "$IMAGES/catalog.json" <<JSON
[
  {
    "id": "alpine",
    "hostname": "alpine",
    "label": "Alpine Linux 3.24",
    "description": "Image RAW préparée, disque de travail éphémère",
    "kind": "raw",
    "disk": "$ALPINE_RAW",
    "vdi": "$ALPINE_VDI",
    "format": "raw",
    "memory": 512,
    "login": "root, sans mot de passe ; toto / toto",
    "qemuNic": "user,restrict=on",
    "vboxNic": "nat",
    "network": "DHCP restreint dans QEMU ; NAT dans VirtualBox"
  },
  {
    "id": "debian13",
    "hostname": "qemunet-demo",
    "label": "Debian 13",
    "description": "Image RAW préparée, disque de travail éphémère",
    "kind": "raw",
    "disk": "$DEBIAN_RAW",
    "vdi": "$DEBIAN_VDI",
    "format": "raw",
    "memory": 1024,
    "login": "root, sans mot de passe ; toto / toto ; demo / serial-demo",
    "qemuNic": "user,restrict=on",
    "vboxNic": "nat",
    "network": "DHCP restreint dans QEMU ; NAT dans VirtualBox"
  },
  {
    "id": "openwrt",
    "hostname": "OpenWrt",
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

echo "Bases prêtes et en lecture seule dans $IMAGES."
echo "QEMU utilisera des overlays QCOW2 ; VirtualBox des disques différentiels VDI."
