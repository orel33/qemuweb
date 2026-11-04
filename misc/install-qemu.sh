#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || "$1" != /* || "$1" == / || ! -d "$1" ]]; then
  echo "Usage: $0 BASE_DIR (e.g. /opt or /opt/)" >&2
  echo "Builds in BASE_DIR/qemu-VERSION/build and installs in BASE_DIR/qemu-VERSION/bin." >&2
  echo "BASE_DIR must already exist." >&2
  exit 2
fi
base_dir="${1%/}"

check_dependencies() {
  local cmd
  for cmd in cc make ninja python3 pkg-config curl tar xz bzip2 bison flex grep sort tail nproc mktemp; do
    command -v "$cmd" >/dev/null || return 1
  done
  python3 -m venv --help >/dev/null 2>&1 || return 1
  pkg-config --exists glib-2.0 pixman-1 slirp || return 1
  printf '#include <libvdeplug.h>\nint main(void) { return 0; }\n' | cc -x c - -lvdeplug -o /dev/null 2>/dev/null
}

if ! check_dependencies; then
  if ! command -v apt-get >/dev/null; then
    echo "Missing build dependencies: GCC, Ninja, Python venv, GLib, Pixman, libslirp or libvdeplug development files." >&2
    exit 1
  fi
  echo "Installing build dependencies (Debian/Ubuntu)..."
  if (( EUID == 0 )); then
    apt-get update
    apt-get install -y --no-install-recommends build-essential ca-certificates curl xz-utils bzip2 bison flex ninja-build python3 python3-venv pkg-config libglib2.0-dev libpixman-1-dev libslirp-dev libvdeplug-dev
  else
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends build-essential ca-certificates curl xz-utils bzip2 bison flex ninja-build python3 python3-venv pkg-config libglib2.0-dev libpixman-1-dev libslirp-dev libvdeplug-dev
  fi
  check_dependencies || { echo "Required build dependencies are still missing." >&2; exit 1; }
fi

workdir="$(mktemp -d /tmp/qemu-build.XXXXXX)"
trap 'rm -rf -- "$workdir"' EXIT

# The official directory lists all stable release archives.
archive="$(curl -fsSL https://download.qemu.org/ |
  grep -oE 'qemu-[0-9]+(\.[0-9]+){2}\.tar\.xz' |
  sort -Vu | tail -n 1)"
[[ -n "$archive" ]] || { echo "Could not determine the latest stable QEMU version." >&2; exit 1; }
version="${archive%.tar.xz}"
install_root="$base_dir/$version"
build_root="$install_root/build"
source_dir="$build_root/source"
object_dir="$build_root/obj"
[[ ! -e "$install_root" ]] || { echo "Destination already exists: $install_root" >&2; exit 1; }

echo "Downloading $version; build: $build_root; install: $install_root/bin"
curl -fL --retry 3 "https://download.qemu.org/$archive" -o "$workdir/$archive"

if [[ -w "$base_dir" || $EUID -eq 0 ]]; then
  mkdir -- "$install_root"
else
  sudo mkdir -- "$install_root"
  sudo chown -- "$(id -u):$(id -g)" "$install_root"
fi
mkdir -p -- "$source_dir" "$object_dir"
tar -xf "$workdir/$archive" -C "$source_dir" --strip-components=1

cd "$object_dir"
"$source_dir/configure" \
  --prefix="$install_root" \
  --datadir="$build_root/share" \
  --sysconfdir="$build_root/etc" \
  --libdir="$build_root/lib" \
  --libexecdir="$build_root/libexec" \
  --target-list=x86_64-softmmu \
  --without-default-features \
  --enable-vde --enable-slirp --enable-pixman --enable-kvm --enable-tcg \
  --disable-tools --disable-docs --disable-guest-agent
make -j "$(nproc)"
make install

"$install_root/bin/qemu-system-x86_64" --version
"$install_root/bin/qemu-system-x86_64" -netdev help 2>&1 | grep -Eq '(^|[[:space:]])vde([[:space:]]|$)' || {
  echo "The installed QEMU binary does not provide the VDE backend." >&2
  exit 1
}
echo "QEMU with VDE installed at $install_root/bin/qemu-system-x86_64"
