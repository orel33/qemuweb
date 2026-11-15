#!/usr/bin/env bash
set -euo pipefail
# Provisioning logic for Alpine Linux (x86_64)
source "$(dirname "$0")/lib/alpine-common.sh"
prepare_alpine_image alpine "$@"
