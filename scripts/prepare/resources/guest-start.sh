#!/bin/sh
# Installed inside each prepared guest. Run again manually after remounting media.
set -u
target=/mnt/cdrom
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
if [ ! -f "$target/start.sh" ]; then
  echo 'QEMUWEB_START_ERROR /mnt/cdrom/start.sh missing'
  exit 1
fi
echo 'QEMUWEB_START_BEGIN /mnt/cdrom/start.sh'
(cd "$target" && /bin/sh "$target/start.sh")
status=$?
echo "QEMUWEB_START_EXIT $status"
exit "$status"
