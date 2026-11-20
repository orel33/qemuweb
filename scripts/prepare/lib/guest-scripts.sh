#!/usr/bin/env bash
# Texts of the scripts typed into the Alpine and OpenWrt build VMs (sourced after common.sh).

# Alpine installer VM: the script typed into it, and the text it is built from.
# alpine_guest_script FILE writes the script: install to a virtio disk, create lab accounts, make the serial
# console usable on every boot. With a proxy (PROXY_URL), the guest gets it for setup-alpine (PROXYOPTS, which
# setup-alpine exports as http_proxy, https_proxy and ftp_proxy for the installation) and for the apk call
# that follows, and the finished image must not keep it (see the check in the second part).
alpine_guest_script() {
  local file="$1" proxy_answer=none
  if [[ -n "$PROXY_URL" ]]; then proxy_answer="$(shell_quote "$(guest_proxy_url)")"; fi
  {
    printf '#!/bin/sh\nset -eu\n'
    guest_proxy_exports
    if [[ -n "$PROXY_URL" ]]; then printf 'QEMUNET_PROXY=%s\n' "$(shell_quote "$(guest_proxy_url)")"; fi
    cat <<'ALPINE_PREPARE'
passwd -d root
if ! id toto >/dev/null 2>&1; then adduser -D -s /bin/ash toto; fi
echo 'toto:toto' | chpasswd
lbu add /home/toto
grep -qxF ttyS0 /etc/securetty || echo ttyS0 >> /etc/securetty
grep -q '^ttyS0::respawn:' /etc/inittab || echo 'ttyS0::respawn:/sbin/getty -L ttyS0 115200 vt100' >> /etc/inittab
cat > /tmp/qemunet-answers <<'ANSWERS'
KEYMAPOPTS=none
HOSTNAMEOPTS=qemuweb
DEVDOPTS=mdev
INTERFACESOPTS="auto lo
iface lo inet loopback

auto eth0
iface eth0 inet dhcp
hostname qemuweb
"
TIMEZONEOPTS="UTC"
ALPINE_PREPARE
    printf 'PROXYOPTS=%s\n' "$proxy_answer"
    cat <<'ALPINE_PREPARE'
APKREPOSOPTS="-1"
USEROPTS=none
SSHDOPTS=none
NTPOPTS=none
DISKOPTS="-m sys -s 0 /dev/vda"
LBUOPTS=none
APKCACHEOPTS=none
export KERNELOPTS="quiet console=ttyS0,115200"
ANSWERS
echo QEMUNET_ALPINE_PHASE_SETUP
ERASE_DISKS=/dev/vda setup-alpine -e -f /tmp/qemunet-answers
ALPINE_PREPARE
    cat <<'ALPINE_HOOK'
target=''
for partition in /dev/vda3 /dev/vda2 /dev/vda4; do
  if mount "$partition" /mnt 2>/dev/null; then
    if [ -f /mnt/etc/alpine-release ]; then target=/mnt; break; fi
    umount /mnt
  fi
done
[ -n "$target" ] || { echo 'Alpine installed root partition not found'; exit 1; }
# Install the lab tools into the disk installation, not the temporary live ISO.
# traceroute is in Alpine's community repository.
if ! grep -Eq '^[^#].*/community/?$' "$target/etc/apk/repositories"; then
  printf '%s\n' 'https://dl-cdn.alpinelinux.org/alpine/v3.24/community' >> "$target/etc/apk/repositories"
fi
echo QEMUNET_ALPINE_PHASE_TOOLS
apk --root "$target" --no-cache add \
  net-tools iputils-ping iproute2 tcpdump traceroute bind-tools netcat-openbsd nano
chroot "$target" /bin/sh -c '
  for tool in ifconfig ping ip tcpdump traceroute dig nc nano; do
    command -v "$tool" >/dev/null || { echo "Missing Alpine tool: $tool" >&2; exit 1; }
  done
'
# The build proxy must not stay in the image, which is used on other networks. setup-alpine records the
# proxy it was given (PROXYOPTS) in a profile script that is copied to the disk, and nothing else should: remove
# it, then check that the proxy is nowhere in the installed /etc (the guest script stops here if it is).
rm -f "$target/etc/profile.d/proxy.sh"
# (BusyBox sed has no I flag: the case is spelled out.)
for f in "$target/etc/profile" "$target/etc/environment"; do
  if [ -f "$f" ]; then sed -i '/_[Pp][Rr][Oo][Xx][Yy]=/d' "$f"; fi
done
if [ -n "${QEMUNET_PROXY:-}" ] && grep -rIqF -- "$QEMUNET_PROXY" "$target/etc"; then
  echo 'Alpine: the build proxy is still recorded in the installed system' >&2; exit 1
fi
echo QEMUNET_ALPINE_PHASE_FINISH
mkdir -p "$target/usr/local/sbin" "$target/etc/init.d" "$target/etc/runlevels/default"
cat > "$target/usr/local/sbin/qemuweb-guest-start" <<'GUEST_HOOK'
ALPINE_HOOK
    cat "$ROOT/scripts/prepare/resources/guest-start.sh"
    cat <<'ALPINE_HOOK'
GUEST_HOOK
cat > "$target/etc/init.d/qemuweb-guest-start" <<'INIT_HOOK'
#!/sbin/openrc-run
description="Run QemuWeb guest startup media"
depend() { after local; }
start() { ebegin "QemuWeb guest startup"; /usr/local/sbin/qemuweb-guest-start >/dev/ttyS0 2>&1; eend $?; }
INIT_HOOK
chmod 755 "$target/usr/local/sbin/qemuweb-guest-start" "$target/etc/init.d/qemuweb-guest-start"
ln -sf /etc/init.d/qemuweb-guest-start "$target/etc/runlevels/default/qemuweb-guest-start"
# Keep the published image generic. The guest hook fills this file on the
# first boot of each host's separate working disk.
: > "$target/etc/machine-id"
test ! -s "$target/etc/machine-id"
umount "$target"
sync
echo QEMUNET_ALPINE_PREPARED
ALPINE_HOOK
  } > "$file"
}

# OpenWrt build VM. openwrt_guest_script FILE writes the script typed into it. With a proxy (PROXY_URL) the
# script exports http_proxy, https_proxy and ftp_proxy (apk and uclient-fetch read them) before the package
# index is fetched. The proxy is NOT recorded in the image: the variables only live in the shell of this
# script, which runs from /tmp, and apk keeps no proxy setting in /etc/apk.
openwrt_guest_script() {
  local file="$1"
  {
    printf '#!/bin/sh\nset -eu\n'
    guest_proxy_exports
    cat <<'OPENWRT_PREPARE'
echo QEMUWEB_OPENWRT_PHASE_"SYSTEM"
sed -i 's#^root:[^:]*:#root::#' /etc/shadow
sed -i '/^toto:/d' /etc/passwd
sed -i '/^toto:/d' /etc/group
sed -i '/^toto:/d' /etc/shadow
printf '%s\n' 'toto:x:1000:1000:toto:/home/toto:/bin/ash' >> /etc/passwd
printf '%s\n' 'toto:x:1000:' >> /etc/group
printf '%s\n' 'toto:$6$qemuweb$0QuT0CJj087ILV95eOwdT3u2MSv50m/qOO1ZcldVMPUpYOZwd0af9jbRPllLcoY5e1LrOK0EvYTVno41TJNIb1:0:0:99999:7:::' >> /etc/shadow
mkdir -p /home/toto
chown 1000:1000 /home/toto
if uci -q get 'system.@system[0]' >/dev/null; then
  uci set 'system.@system[0].hostname=qemuweb'
else
  uci set 'system.qemuweb=system'
  uci set 'system.qemuweb.hostname=qemuweb'
fi
uci commit system
printf 'qemuweb\n' > /proc/sys/kernel/hostname
# eth0 is OpenWrt's LAN port; the second temporary NIC supplies DHCP on the
# default eth1 WAN during image preparation. Neither NIC is part of the base.
attempt=0
until ip -4 route show default | grep -q 'dev eth1'; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || { echo 'OpenWrt preparation WAN did not get a route' >&2; exit 1; }
  sleep 1
done
echo QEMUWEB_OPENWRT_PHASE_"APK"
# A package index or download that hangs would otherwise wait for the 900 s limit of the driver:
# stop apk after 3 minutes when the busybox of the image has timeout, and fail with a clear message.
apk_run=apk
if command -v timeout >/dev/null 2>&1; then apk_run='timeout 180 apk'; fi
$apk_run -U add tcpdump nano || { echo 'OpenWrt preparation: apk could not install tcpdump and nano from the package feeds (check the proxy)' >&2; exit 1; }
echo QEMUWEB_OPENWRT_PHASE_"CONFIG"
# The stock image has no hostname command, while the default start.sh uses it.
# Provide the get/set form needed by the guest startup script and lab console.
if ! command -v hostname >/dev/null 2>&1; then
  cat > /usr/bin/hostname <<'HOSTNAME_TOOL'
#!/bin/sh
case "$#" in
  0) cat /proc/sys/kernel/hostname ;;
  1) printf '%s\n' "$1" > /proc/sys/kernel/hostname ;;
  *) echo 'Usage: hostname [name]' >&2; exit 2 ;;
esac
HOSTNAME_TOOL
  chmod 755 /usr/bin/hostname
fi
for tool in ifconfig ping ip route traceroute nslookup nc tcpdump nano hostname; do
  command -v "$tool" >/dev/null || { echo "Missing OpenWrt tool: $tool" >&2; exit 1; }
done
# This lab image has one guest NIC at runtime. Keep its LAN address directly
# on eth0 instead of OpenWrt's stock br-lan bridge.
[ "$(uci -q get 'network.@device[0].name')" = br-lan ] || { echo 'Unexpected OpenWrt LAN device layout' >&2; exit 1; }
uci delete 'network.@device[0]'
uci set 'network.lan.device=eth0'
# The stock config gives lan 192.168.1.1/24 (static ipaddr/netmask, plus
# ip6assign). Every host would then share that address until start.sh runs, and
# two hosts on one switch would conflict. Remove the stock address so the lab
# LAN stays unconfigured until the startup script assigns one. proto becomes
# "none" so netifd brings the device up without any address.
# "uci delete" exits with 1 when the option does not exist (recent releases write
# a CIDR "list ipaddr" and no separate netmask), which set -e would turn into a
# failed build: tolerate it here and verify the result below.
for option in ipaddr netmask ip6assign; do uci -q delete "network.lan.$option" || true; done
uci set network.lan.proto=none
uci commit network
[ "$(uci -q get network.lan.proto)" = none ] || { echo 'OpenWrt LAN proto not none' >&2; exit 1; }
if uci -q get network.lan.ipaddr >/dev/null; then echo 'OpenWrt LAN still has a static address' >&2; exit 1; fi
# A plain lab image must not hand out addresses on a static-IP-only LAN.
# Disable DHCPv4, DHCPv6 and RA for the lan section (uci set creates it when it is
# missing) and dnsmasq's DNS/DHCP service when its section exists, then verify.
uci set 'dhcp.lan=dhcp'
uci set 'dhcp.lan.interface=lan'
uci set 'dhcp.lan.ignore=1'
uci set 'dhcp.lan.dhcpv6=disabled'
uci set 'dhcp.lan.ra=disabled'
if uci -q get 'dhcp.@dnsmasq[0]' >/dev/null; then uci set 'dhcp.@dnsmasq[0].port=0'; fi
uci commit dhcp
[ "$(uci -q get dhcp.lan.ignore)" = 1 ] || { echo 'OpenWrt LAN DHCP was not disabled' >&2; exit 1; }
if uci -q get 'dhcp.@dnsmasq[0]' >/dev/null && [ "$(uci -q get 'dhcp.@dnsmasq[0].port')" != 0 ]; then
  echo 'OpenWrt dnsmasq was not disabled' >&2; exit 1
fi
/etc/init.d/odhcpd disable
OPENWRT_PREPARE
    cat <<'OPENWRT_HOOK'
mkdir -p /usr/local/sbin
cat > /usr/local/sbin/qemuweb-guest-start <<'GUEST_HOOK'
OPENWRT_HOOK
    cat "$ROOT/scripts/prepare/resources/guest-start.sh"
    cat <<'OPENWRT_HOOK'
GUEST_HOOK
cat > /etc/init.d/qemuweb-guest-start <<'INIT_HOOK'
#!/bin/sh /etc/rc.common
START=99
start() { /usr/local/sbin/qemuweb-guest-start >/dev/ttyS0 2>&1; }
INIT_HOOK
chmod 755 /usr/local/sbin/qemuweb-guest-start /etc/init.d/qemuweb-guest-start
/etc/init.d/qemuweb-guest-start enable
# OpenWrt has no systemd machine-id generator; the guest hook creates a
# per-host value on the first boot from this generic image.
: > /etc/machine-id
test ! -s /etc/machine-id
sync
echo QEMUWEB_OPENWRT_PREPARED
OPENWRT_HOOK
  } > "$file"
}
