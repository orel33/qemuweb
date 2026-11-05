#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"

source_dir="$SOURCES/openwrt"
raw="$IMAGES/openwrt.raw"
vdi="$IMAGES/openwrt.vdi"
archive=openwrt-25.12.6-x86-64-generic-ext4-combined.img.gz
url=https://downloads.openwrt.org/releases/25.12.6/targets/x86/64
mkdir -p "$source_dir"
move_if_present "$SOURCES/$archive" "$source_dir/$archive"
move_if_present "$SOURCES/sha256sums" "$source_dir/sha256sums"
move_if_present "$IMAGES/openwrt-25.12.6-x86-64-qemunet.vdi" "$vdi"
fetch_file "$url/$archive" "$source_dir/$archive"
fetch_file "$url/sha256sums" "$source_dir/sha256sums"
(cd "$source_dir" && grep -E "[ *]$archive$" sha256sums | sha256sum -c -)
if [[ ! -s "$raw" ]]; then
  gzip -dc "$source_dir/$archive" > "$raw.tmp"
  chmod 444 "$raw.tmp"
  mv "$raw.tmp" "$raw"
fi
chmod 444 "$raw"
make_vdi "$raw" "$vdi"
echo "OpenWrt base ready: $raw"
