#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# Keep generated images, downloaded source files, and temporary build state
# separate so preparation scripts can be rerun safely.
IMAGES="$ROOT/images"
SOURCES="$ROOT/sources"
RUNTIME="$ROOT/runtime"
mkdir -p "$IMAGES" "$SOURCES" "$RUNTIME"

parse_prepare_mode() {
  if (( $# > 1 )); then
    echo 'Usage: scripts/prepare/<system>.sh [--sources | --images]' >&2
    exit 2
  fi
  case "${1:---all}" in
    --all) PREPARE_MODE=all ;;
    --sources) PREPARE_MODE=sources ;;
    --images) PREPARE_MODE=images ;;
    *) echo "Unknown preparation mode: $1" >&2; exit 2 ;;
  esac
}

prepare_sources() { [[ "$PREPARE_MODE" != images ]]; }
prepare_images() { [[ "$PREPARE_MODE" != sources ]]; }

require_commands() {
  # Check tools only when a script actually needs to build an image.
  for command in "$@"; do
    if [[ "$command" == genisoimage ]]; then
      if command -v genisoimage >/dev/null || command -v mkisofs >/dev/null; then
        continue
      fi
    fi
    command -v "$command" >/dev/null || { echo "Required preparation tool not found: $command" >&2; exit 1; }
  done
}

fetch_file() {
  local url="$1" target="$2"
  # Reuse an existing non-empty download; this makes interrupted runs cheap to resume.
  if [[ -s "$target" ]]; then
    echo "  Reuse source: $target"
  else
    echo "  Download: $url -> $target"
    curl -fL --retry 3 "$url" -o "$target"
  fi
}

move_if_present() {
  local source="$1" destination="$2"
  # Migrate older top-level source/image files into the per-system layout once.
  [[ -e "$destination" || ! -e "$source" ]] && return 0
  mkdir -p "$(dirname "$destination")"
  mv -- "$source" "$destination"
}

make_vdi() {
  local raw="$1" vdi="$2"
  # Keep RAW as the canonical image and derive VDI only when it is missing.
  [[ -s "$vdi" ]] && return 0
  qemu-img convert -p -f raw -O vdi "$raw" "$vdi.tmp"
  chmod 444 "$vdi.tmp"
  mv "$vdi.tmp" "$vdi"
}

base64_encode_file() {
  local file="$1"
  base64 < "$file" | tr -d '\r\n'
}

prep_acceleration() {
  local target_arch="${1:-x86_64}"
  local qemu_bin="qemu-system-x86_64"
  if [[ "$target_arch" == 'aarch64' || "$target_arch" == 'arm64' ]]; then
    qemu_bin="qemu-system-aarch64"
  fi
  # Avoid nested KVM when VirtualBox is already running; otherwise use hardware
  # acceleration when available (KVM on Linux, HVF on macOS) and fall back to TCG.
  if command -v VBoxManage >/dev/null 2>&1 && [[ -n "$(VBoxManage list runningvms 2>/dev/null || true)" ]]; then
    printf 'tcg'
  elif [[ -r /dev/kvm && -w /dev/kvm ]] && [[ "$target_arch" == 'x86_64' || "$(uname -m)" == 'aarch64' || "$(uname -m)" == 'arm64' ]]; then
    printf 'kvm'
  elif [[ "$(uname -s)" == 'Darwin' ]] && "$qemu_bin" -accel help 2>/dev/null | grep -qw 'hvf'; then
    printf 'hvf'
  else
    printf 'tcg'
  fi
}

find_edk2_firmware() {
  local candidates=(
    "${QEMU_EFI_AARCH64:-}"
    "/opt/homebrew/share/qemu/edk2-aarch64-code.fd"
    "/usr/local/share/qemu/edk2-aarch64-code.fd"
    "/usr/share/qemu-efi-aarch64/QEMU_EFI.fd"
    "/usr/share/AAVMF/AAVMF_CODE.fd"
    "/usr/share/edk2/aarch64/QEMU_EFI.silent.fd"
    "/usr/share/edk2/aarch64/QEMU_EFI.fd"
  )
  for c in "${candidates[@]}"; do
    if [[ -n "$c" && -r "$c" ]]; then
      printf '%s' "$c"
      return 0
    fi
  done
  echo "ARM64 EFI firmware (edk2-aarch64-code.fd / QEMU_EFI.fd) not found" >&2
  return 1
}
