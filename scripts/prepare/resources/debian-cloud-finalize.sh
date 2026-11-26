#!/bin/sh
# Last step of the debian13-cloud build, run once in the build VM after cloud-init has finished (it cannot
# purge cloud-init while cloud-init runs it): disable the optional services and timers, remove what a lab
# host does not need, check the result, clean the caches and give the free blocks back to the image.
# Prints QEMUNET_IMAGE_PREPARED on success, QEMUNET_IMAGE_SETUP_FAILED on any failure
# (scripts/prepare/lib/common.sh watches the serial console for both).
set -eu

report_failure() {
  status=$?
  [ "$status" -eq 0 ] || echo QEMUNET_IMAGE_SETUP_FAILED >/dev/ttyS0
}
trap report_failure EXIT

export DEBIAN_FRONTEND=noninteractive
echo QEMUNET_IMAGE_CLEANUP >/dev/ttyS0

# Installed but not started at boot: each one can still be started by hand (systemctl start <unit>).
# systemd-networkd-wait-online would make a service started by hand wait 2 minutes for an address.
services='ssh.service dnsmasq.service isc-dhcp-server.service inetutils-inetd.service openvpn.service
  apache2.service apache-htcacheclean.service named.service systemd-timesyncd.service
  systemd-networkd-wait-online.service e2scrub_reap.service'
timers='apt-daily.timer apt-daily-upgrade.timer apt-listchanges.timer dpkg-db-backup.timer man-db.timer
  e2scrub_all.timer fstrim.timer'
for unit in $services $timers; do
  systemctl disable "$unit"
done

# An explicit list, never 'apt-get autoremove': the packages asked for, then the dependencies that only
# they needed. Nothing else may be removed, so the removal is simulated first.
removals='cloud-init cloud-initramfs-growroot cloud-utils cloud-image-utils qemu-utils unattended-upgrades
  locales libc-l10n
  dhcpcd-base eject genisoimage libaio1t64 python3-attr python3-blinker python3-configobj python3-dbus
  python3-distro-info python3-jinja2 python3-json-pointer python3-jsonpatch python3-jsonschema
  python3-jsonschema-specifications python3-jwt python3-markupsafe python3-oauthlib python3-referencing
  python3-rpds-py'
installed=''
for package in $removals; do
  if dpkg-query -W -f='${db:Status-Status}\n' "$package" 2>/dev/null | grep -qx installed; then
    installed="$installed $package"
  fi
done
planned=$(apt-get -s purge $installed | awk '$1 == "Purg" || $1 == "Remv" { print $2 }')
for package in $planned; do
  case " $installed " in
    *" $package "*) ;;
    *) echo "The purge would also remove $package: update the list in debian-cloud-finalize.sh."; exit 1 ;;
  esac
done
apt-get -y -o DPkg::Lock::Timeout=300 purge $installed

# What cloud-init generated at run time and no package owns. QemuWeb writes its own versions of the two
# settings to keep (no Recommends for apt, SSH password login).
rm -rf /etc/cloud /var/lib/cloud /var/log/cloud-init.log /var/log/cloud-init-output.log
rm -f /etc/netplan/50-cloud-init.yaml /etc/apt/apt.conf.d/94cloud-init-config \
  /etc/ssh/sshd_config.d/50-cloud-init.conf
# The build proxy must not stay in the image, which is used on other networks.
rm -f /etc/apt/apt.conf.d/90cloud-init-aptproxy
rm -rf /var/log/unattended-upgrades
cat > /etc/hosts <<'HOSTS'
127.0.0.1 localhost
127.0.1.1 qemuweb

# The following lines are desirable for IPv6 capable hosts
::1 localhost ip6-localhost ip6-loopback
ff02::1 ip6-allnodes
ff02::2 ip6-allrouters
HOSTS
# Policy of the build only: see debian-common.sh.
rm -f /usr/sbin/policy-rc.d

update-grub

# Checks of the finished system.
grep -q 'net.ifnames=0' /boot/grub/grub.cfg
test -x /usr/sbin/ifconfig
for command in ping tcpdump nano vim nmap scapy openvpn nc dhclient dhcpd dnsmasq apache2ctl named sshd ssh curl wget; do
  command -v "$command" >/dev/null || { echo "Missing command in the image: $command"; exit 1; }
done
dpkg -s qemu-guest-agent netcat-openbsd isc-dhcp-client ca-certificates >/dev/null
for package in cloud-init qemu-utils unattended-upgrades locales libc-l10n; do
  if dpkg-query -W -f='${db:Status-Status}\n' "$package" 2>/dev/null | grep -qx installed; then
    echo "Package still installed: $package"; exit 1
  fi
done
for unit in $services $timers; do
  if systemctl is-enabled --quiet "$unit"; then echo "Unit still enabled: $unit"; exit 1; fi
done
systemctl is-enabled --quiet systemd-networkd.service qemuweb-start.service
test -s /etc/qemu/qemu-ga.conf
grep -qx 'kernel.printk = 3 4 1 3' /etc/sysctl.d/10-console.conf
ls /etc/ssh/ssh_host_*_key >/dev/null

# APT caches and package lists: 'apt update' creates them again.
apt-get clean
rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin
mkdir -p /var/lib/apt/lists/partial
rm -rf /var/log/journal/*

# The image is a template: no fixed machine ID.
: > /etc/machine-id
mkdir -p /var/lib/dbus
rm -f /var/lib/dbus/machine-id
ln -s /etc/machine-id /var/lib/dbus/machine-id
test ! -s /etc/machine-id
test "$(readlink /var/lib/dbus/machine-id)" = /etc/machine-id

# Discard the free blocks: the build disk passes them on (discard=unmap), so the RAW image has holes there.
rm -f /usr/local/sbin/qemuweb-image-finalize
sync
fstrim -av

echo QEMUNET_IMAGE_PREPARED >/dev/ttyS0
