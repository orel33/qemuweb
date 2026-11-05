#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGES="$ROOT/images"
SOURCES="$ROOT/sources"
RUNTIME="$ROOT/runtime"
mkdir -p "$IMAGES" "$SOURCES" "$RUNTIME"

require_commands() {
  for command in "$@"; do
    command -v "$command" >/dev/null || { echo "Required preparation tool not found: $command" >&2; exit 1; }
  done
}

fetch_file() {
  local url="$1" target="$2"
  if [[ ! -s "$target" ]]; then curl -fL --retry 3 "$url" -o "$target"; fi
}

move_if_present() {
  local source="$1" destination="$2"
  [[ -e "$destination" || ! -e "$source" ]] && return 0
  mkdir -p "$(dirname "$destination")"
  mv -- "$source" "$destination"
}

make_vdi() {
  local raw="$1" vdi="$2"
  [[ -s "$vdi" ]] && return 0
  qemu-img convert -p -f raw -O vdi "$raw" "$vdi.tmp"
  chmod 444 "$vdi.tmp"
  mv "$vdi.tmp" "$vdi"
}

prep_acceleration() {
  if command -v VBoxManage >/dev/null 2>&1 && [[ -n "$(VBoxManage list runningvms 2>/dev/null || true)" ]]; then
    printf 'tcg'
  elif [[ -r /dev/kvm && -w /dev/kvm ]]; then
    printf 'kvm'
  else
    printf 'tcg'
  fi
}
