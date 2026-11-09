#!/usr/bin/env bash
set -euo pipefail
# The cloud-based Debian image shares its provisioning logic with other
# Debian cloud profiles; the ID selects its own source and output image paths.
source "$(dirname "$0")/debian-common.sh"
parse_prepare_mode "$@"

# Preserve already prepared artifacts when upgrading from the former
# `debian13` identifier to the explicit `debian13-cloud` identifier.
if prepare_sources; then
  move_if_present "$SOURCES/debian13/debian-13-genericcloud-amd64.qcow2" "$SOURCES/debian13-cloud/debian-13-genericcloud-amd64.qcow2"
  move_if_present "$SOURCES/debian13/SHA512SUMS" "$SOURCES/debian13-cloud/SHA512SUMS"
  rmdir "$SOURCES/debian13" 2>/dev/null || true
fi
if prepare_images && [[ "${QEMUWEB_PREPARE_FORCE:-0}" != 1 ]]; then
  move_if_present "$IMAGES/debian13.raw" "$IMAGES/debian13-cloud.raw"
  move_if_present "$IMAGES/debian13.vdi" "$IMAGES/debian13-cloud.vdi"
fi

prepare_debian_image debian13-cloud
