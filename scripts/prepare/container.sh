#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
parse_prepare_mode "$@"

source_dir="$SOURCES/container"
b2c_img_dir="$IMAGES/b2c"
raw="$IMAGES/container.raw"
vdi="$IMAGES/container.vdi"

kernel_name="linux-x86_64-qemu"
initrd_name="initramfs.linux_amd64.cpio.xz"
version="v0.9.10"
base_url="https://gitlab.freedesktop.org/mupuf/boot2container/-/releases/$version/downloads"

kernel_sha256="dc43b12fb09124617cfc102fdd468050d7cd2868f3ce8203e6b28141f2c6fd77"
initrd_sha256="a5af790c115e2dd6ea43a43232110087368384701197dc139ebe2cf7b8732955"

host_arch="$(uname -m)"
if [[ "$host_arch" == 'arm64' || "$host_arch" == 'aarch64' ]]; then
  kernel_name="linux-arm64-qemu"
  initrd_name="initramfs.linux_arm64.cpio.xz"
  kernel_sha256="8dbeacb8367c96b1372144d661ba8a9009dd40a620d1f3fa3464c4a7808c4056"
  initrd_sha256="ee0863f6f7dab1dab50535bb03b2970a9b218484fca8ef95f18ef7563f87c886"
fi

mkdir -p "$source_dir"

if prepare_sources; then
  # Check for known local copies first to speed up preparation if available
  local_fallback="/Users/ramet/Work/iut/gitlabiut/virtual/b2c"
  if [[ ! -s "$source_dir/$kernel_name" && -s "$local_fallback/$kernel_name" ]]; then
    echo "  Copying local kernel from $local_fallback..."
    cp "$local_fallback/$kernel_name" "$source_dir/$kernel_name"
  fi
  if [[ ! -s "$source_dir/$initrd_name" && -s "$local_fallback/$initrd_name" ]]; then
    echo "  Copying local initramfs from $local_fallback..."
    cp "$local_fallback/$initrd_name" "$source_dir/$initrd_name"
  fi

  fetch_file "$base_url/$kernel_name" "$source_dir/$kernel_name"
  fetch_file "$base_url/$initrd_name" "$source_dir/$initrd_name"

  echo "$kernel_sha256  $source_dir/$kernel_name" | shasum -a 256 -c -
  echo "$initrd_sha256  $source_dir/$initrd_name" | shasum -a 256 -c -
fi

if ! prepare_images; then exit 0; fi

mkdir -p "$b2c_img_dir"
cp -p "$source_dir/$kernel_name" "$b2c_img_dir/$kernel_name"
cp -p "$source_dir/$initrd_name" "$b2c_img_dir/$initrd_name"

if [[ ! -s "$raw" ]]; then
  require_commands qemu-img
  echo "  Creating 10G sparse cache disk for container..."
  qemu-img create -f raw "$raw" 10G
fi

make_vdi "$raw" "$vdi"
