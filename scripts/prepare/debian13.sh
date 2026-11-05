#!/usr/bin/env bash
set -euo pipefail
# The cloud-based Debian image shares its provisioning logic with other
# Debian cloud profiles; the ID selects its own source and output image paths.
source "$(dirname "$0")/debian-common.sh"
prepare_debian_image debian13
