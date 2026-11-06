#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="$ROOT/runtime"
VERSION=3.24.3
ISO="alpine-virt-$VERSION-x86_64.iso"
BASE_URL="https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64"
mkdir -p "$RUNTIME"

if [[ ! -s "$RUNTIME/$ISO" ]]; then
  curl -fL --retry 3 "$BASE_URL/$ISO" -o "$RUNTIME/$ISO"
fi
curl -fL --retry 3 "$BASE_URL/$ISO.sha256" -o "$RUNTIME/$ISO.sha256"
(cd "$RUNTIME" && sha256sum -c "$ISO.sha256")

echo "Prêt : $RUNTIME/$ISO"
echo "La console Alpine live se connecte sur ttyS0 ; aucun disque ni réseau n’est requis."
