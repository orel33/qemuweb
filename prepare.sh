#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="$ROOT/runtime"
ALPINE_VERSION=3.24.3
ALPINE="alpine-virt-$ALPINE_VERSION-x86_64.iso"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64"
DEBIAN="debian-13-genericcloud-amd64.qcow2"
DEBIAN_URL="https://cloud.debian.org/images/cloud/trixie/latest"
OPENWRT="openwrt-25.12.6-x86-64-generic-ext4-combined.img.gz"
OPENWRT_URL="https://downloads.openwrt.org/releases/25.12.6/targets/x86/64"
mkdir -p "$RUNTIME"

fetch() {
  local url="$1" target="$2"
  if [[ ! -s "$target" ]]; then curl -fL --retry 3 "$url" -o "$target"; fi
}

fetch "$ALPINE_URL/$ALPINE" "$RUNTIME/$ALPINE"
fetch "$ALPINE_URL/$ALPINE.sha256" "$RUNTIME/$ALPINE.sha256"
(cd "$RUNTIME" && sha256sum -c "$ALPINE.sha256")

fetch "$DEBIAN_URL/$DEBIAN" "$RUNTIME/$DEBIAN"
fetch "$DEBIAN_URL/SHA512SUMS" "$RUNTIME/debian-SHA512SUMS"
(cd "$RUNTIME" && grep -E "[ *]$DEBIAN$" debian-SHA512SUMS | sha512sum -c -)

fetch "$OPENWRT_URL/$OPENWRT" "$RUNTIME/$OPENWRT"
fetch "$OPENWRT_URL/sha256sums" "$RUNTIME/openwrt-sha256sums"
(cd "$RUNTIME" && grep -E "[ *]$OPENWRT$" openwrt-sha256sums | sha256sum -c -)
if [[ ! -s "$RUNTIME/${OPENWRT%.gz}" ]]; then gzip -dk "$RUNTIME/$OPENWRT"; fi

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
    "label": "Debian 13 cloud",
    "description": "Image cloud légère, disque éphémère",
    "kind": "cloud",
    "disk": "$DEBIAN",
    "format": "qcow2",
    "memory": 1024,
    "login": "demo / serial-demo",
    "network": "DHCP local restreint dans QEMU ; NAT dans VirtualBox"
  },
  {
    "id": "openwrt",
    "label": "OpenWrt 25.12 x86-64",
    "description": "Routeur Linux x86-64, disque éphémère",
    "kind": "disk",
    "disk": "${OPENWRT%.gz}",
    "format": "raw",
    "memory": 256,
    "login": "root, sans mot de passe au premier accès",
    "network": "Désactivé"
  }
]
JSON

echo "Images prêtes dans $RUNTIME : Alpine, Debian 13 et OpenWrt."
echo "Pour Debian : genisoimage et qemu-img sont requis ; VirtualBox est optionnel."
