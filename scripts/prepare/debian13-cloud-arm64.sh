#!/usr/bin/env bash
set -euo pipefail
# Provisioning logic for Debian 13 Cloud (ARM64)
source "$(dirname "$0")/lib/debian-common.sh"
parse_prepare_mode "$@"

prepare_debian_image debian13-cloud-arm64
