#!/bin/sh
# Installed inside each prepared guest. Run again manually after remounting media.
set -u
target=/mnt/cdrom
# The marker lives on the OpenWrt working disk. Remove only RHV62-owned UCI
# sections on every boot, including boots with no startup ISO attached.
if [ -f /etc/qemuweb-dhcp-dns-managed ] && command -v uci >/dev/null 2>&1; then
  uci -q delete network.qemuweb_lan || true
  uci -q delete dhcp.qemuweb_lan || true
  uci -q delete dhcp.qemuweb_dns || true
  uci commit network
  uci commit dhcp
  /etc/init.d/network reload
  /etc/init.d/dnsmasq restart
  rm -f /etc/qemuweb-dhcp-dns-managed
fi
label=QWEBSTART
mkdir -p "$target"
if mountpoint -q "$target" 2>/dev/null || grep -q " $target " /proc/mounts; then
  umount "$target" || { echo 'QEMUWEB_START_ERROR cannot unmount old media'; exit 1; }
fi
device=''
for attempt in 1 2 3; do
  for candidate in /dev/disk/by-label/QWEBSTART /dev/sr0 /dev/sr1 /dev/cdrom; do
    [ -e "$candidate" ] || continue
    # ISO9660 volume ID occupies bytes 40-71 of the primary volume descriptor.
    # This also works on minimal OpenWrt/Alpine images without blkid or udev.
    volume_id=$(dd if="$candidate" bs=1 skip=32808 count=32 2>/dev/null | tr -d ' ')
    if [ "$volume_id" = "$label" ]; then device=$candidate; break; fi
  done
  [ -n "$device" ] && break
  [ "$attempt" = 3 ] || sleep 1
done
if [ -z "$device" ]; then
  echo "QEMUWEB_START_ERROR ISO label $label missing"
  exit 1
fi
if ! mount -t iso9660 -o ro "$device" "$target"; then
  echo "QEMUWEB_START_ERROR cannot mount $device at $target"
  exit 1
fi
if [ -f "$target/pre-start.sh" ]; then
  echo 'QEMUWEB_START_BEGIN /mnt/cdrom/pre-start.sh'
  (cd "$target" && /bin/sh "$target/pre-start.sh")
  status=$?
  echo "QEMUWEB_START_EXIT $status"
  if [ "$status" -ne 0 ]; then
    echo 'QEMUWEB_START_ERROR /mnt/cdrom/pre-start.sh failed'
    exit "$status"
  fi
fi
if [ ! -f "$target/start.sh" ]; then
  echo 'QEMUWEB_START_ERROR /mnt/cdrom/start.sh missing'
  exit 1
fi
echo 'QEMUWEB_START_BEGIN /mnt/cdrom/start.sh'
(cd "$target" && /bin/sh "$target/start.sh")
status=$?
echo "QEMUWEB_START_EXIT $status"
exit "$status"
