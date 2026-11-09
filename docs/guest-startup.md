# Guest startup media (GTS16, v0.4.0)

Each host can have its own ISO, labeled `QWEBSTART`, attached read-only when enabled. The guest hook finds that label, mounts the ISO read-only at `/mnt/cdrom`, and runs `/mnt/cdrom/start.sh` with `/bin/sh` near the end of boot. Relative paths in `start.sh` resolve from `/mnt/cdrom`, so `cat config/example.txt` reads a companion file. The script runs as root **inside the guest**. It never runs on the Web server. The Host Log records host-side ISO creation and attachment, without copying guest boot messages. On Debian, script output and exit status remain available with `journalctl -b -u qemuweb-guest-start.service`; the normal `[ OK ] Finished ...` boot status remains on serial. The Web console filters the technical `QEMUWEB_START_BEGIN` and `QEMUWEB_START_EXIT` lines from all guest profiles. Alpine and OpenWrt still show the script's own output on serial; failures remain visible as `QEMUWEB_START_ERROR`.

Use Host Settings → Startup to edit or import `start.sh`. Edits are saved immediately in this browser's `localStorage`, per host. The **Auto-build and attach startup CD-ROM** checkbox is saved alongside the script. When enabled, Start, Resume, Reboot and Reset send the script to the server, build a fresh read-only ISO, and attach it before launching QEMU or VirtualBox. Expert previews the `genisoimage` command before the disk and hypervisor commands and shows the planned ISO path. The temporary staging directory in this preview is a placeholder; the Host Log shows the exact command and path at launch. A running host keeps its current media until a restart. The script stays in the browser until launch; another browser does not see unsent edits. Clearing browser storage loses them. Empty `start.sh` is allowed and intentionally produces a missing-script error on boot. The script limit is 64 KiB. Existing companion files in a host session are preserved, but the Startup tab currently edits only `start.sh`.

Edits made while a VM runs take effect on **Reboot** or Stop followed by Resume, while keeping the current differential disk. A new host starts with a minimal `#!/bin/sh` script and no CD-ROM unless the checkbox is enabled. The two hosts of a LAN can use different scripts, for example:

```sh
#!/bin/sh
hostname marie
ip addr add 10.0.0.1/24 dev eth0
ip link set eth0 up
cat config/message.txt
```

Adjust the interface name for the selected guest and use `10.0.0.2/24` on the second host. For persistent static configuration, have the script edit the guest's network configuration and restart its network service; `ip addr add` alone is applied after each boot but does not persist on disk.

The hook waits at most two seconds for labeled media. Missing ISO, missing script, mount failure and nonzero script status appear promptly in the Debian guest journal; Alpine and OpenWrt show `QEMUWEB_START_ERROR` on serial. A failed hook does not block login. On Debian, `systemctl restart qemuweb-guest-start.service` reruns the hook; on Alpine, `rc-service qemuweb-guest-start restart`; on OpenWrt, `/etc/init.d/qemuweb-guest-start restart`. The hook unmounts an old `/mnt/cdrom` mount before mounting the currently attached ISO. If a hypervisor operator swaps media while the VM is powered on, this manual restart provides a hot run; Host Settings itself applies saved changes at the next VM launch.

## Existing prepared bases

`bash prepare.sh` deliberately skips nonempty RAW and VDI images; it does not inject the hook into older bases. Existing bases and their differential disks remain untouched by the application. To upgrade a base, first stop and remove hosts that use it (or keep their disks for an explicit guest-side migration); **do not replace a RAW/VDI base underneath an existing QCOW2/VDI differential disk**. Back up `images/<system>.raw` and `images/<system>.vdi`, move those two files out of `images/`, then run `bash scripts/prepare/<system>.sh` for each of `debian13-legacy`, `debian13-cloud`, `alpine` and `openwrt`. The script generates a new base and VDI while leaving the backup intact. Verify `QEMUWEB_START_EXIT 0` in the Debian guest journal, or the script's expected output on Alpine/OpenWrt serial, before discarding backups. Rebuilding requires the usual source downloads and image preparation tools; it can take substantial time.

For one system at a time, after closing its hosts:

```sh
system=debian13-legacy # repeat for debian13-cloud, alpine, openwrt
mkdir -p "backups/$system"
mv "images/$system.raw" "images/$system.vdi" "backups/$system/"
bash "scripts/prepare/$system.sh"
```

If preparation fails, remove any incomplete new files from `images/` and move the saved pair back from `backups/$system/`. Keep the backup until the new base has passed a boot test. The test commands are `npm run test:gts16-profiles` for Alpine, Debian Cloud and OpenWrt, and `GTS16_PROFILES=debian13-legacy npm run test:gts16-profiles` for Debian Legacy. `npm run test:gts16-lan2` also checks Debian Legacy LAN2, Stop/Resume, and an edited script after Reboot; it needs a QEMU build with VDE support.

For an existing differential disk you need to keep, install `scripts/prepare/guest-start.sh` in that guest as `/usr/local/sbin/qemuweb-guest-start` and install the native service shown in its preparation script. That changes only the guest's differential disk. Reboot the host to attach its ISO. New hosts from the old base still require a rebuilt base.
