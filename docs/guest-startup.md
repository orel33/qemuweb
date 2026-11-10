# Guest startup media (GTS16, v0.4.0)

The v0.4.0 validation covers Debian 13 Legacy under QEMU. NQX72 tracks QEMU validation for the newly rebuilt Debian 13 Cloud, Alpine and OpenWrt bases. VirtualBox guest validation is tracked by VBH54, and companion-file editing by FUR92.

Each host can have its own ISO, labeled `QWEBSTART`, attached read-only when enabled. The guest hook finds that label, mounts the ISO read-only at `/mnt/cdrom`, and runs `/mnt/cdrom/start.sh` with `/bin/sh` near the end of boot. Relative paths in `start.sh` resolve from `/mnt/cdrom`, so `cat config/example.txt` reads a companion file. The script runs as root **inside the guest**. It never runs on the Web server. The Host Log records host-side ISO creation and attachment, without copying guest boot messages. On Debian, script output and exit status remain available with `journalctl -b -u qemuweb-start.service`; the normal `[ OK ] Finished ...` boot status remains on serial. The Web console filters the technical `QEMUWEB_START_BEGIN` and `QEMUWEB_START_EXIT` lines from all guest profiles. Alpine and OpenWrt still show the script's own output on serial; failures remain visible as `QEMUWEB_START_ERROR`.

Use Host Settings → Startup to edit or import `start.sh`. Edits remain in the dialog until **OK** sends the host configuration to the server; **Cancel** discards them. The server saves the script as `guestMedia.script` in `runtime/<session-id>/<host-id>/host.json`, alongside the **Auto-build and attach startup CD-ROM** setting and any companion files. Another browser can read the saved script while that server session is active. When automatic CD-ROM attachment is enabled, Start, Resume, Reboot and Reset build a fresh read-only ISO before launching QEMU or VirtualBox. Expert previews the `genisoimage` command and planned ISO path. The server writes `start.sh` into the host's temporary `iso-stage/` directory for that command, then removes the directory; the built `startup-<generation>.iso` remains in the host directory while needed. A running host keeps its current media until a restart. Empty `start.sh` is allowed and intentionally produces a missing-script error on boot. The script limit is 64 KiB. Existing companion files in a host session are preserved, but the Startup tab currently edits only `start.sh`. A normal server shutdown removes each host directory, including its `host.json` and ISO files; restoring them after a server restart is a later roadmap stage.

Edits made while a VM runs take effect on **Reboot** or Stop followed by Resume, while keeping the current differential disk. A new host starts with a minimal `#!/bin/sh` script and no CD-ROM unless the checkbox is enabled. The two hosts of a LAN can use different scripts, for example:

```sh
#!/bin/sh
hostname marie
ip addr add 10.0.0.1/24 dev eth0
ip link set eth0 up
cat config/message.txt
```

Adjust the interface name for the selected guest and use `10.0.0.2/24` on the second host. For persistent static configuration, have the script edit the guest's network configuration and restart its network service; `ip addr add` alone is applied after each boot but does not persist on disk.

The hook waits at most two seconds for labeled media. Missing ISO, missing script, mount failure and nonzero script status appear promptly in the Debian guest journal; Alpine and OpenWrt show `QEMUWEB_START_ERROR` on serial. A failed hook does not block login. On Debian, `systemctl restart qemuweb-start.service` reruns the hook; on Alpine, `rc-service qemuweb-guest-start restart`; on OpenWrt, `/etc/init.d/qemuweb-guest-start restart`. The hook unmounts an old `/mnt/cdrom` mount before mounting the currently attached ISO. If a hypervisor operator swaps media while the VM is powered on, this manual restart provides a hot run; Host Settings itself applies saved changes at the next VM launch.

## Existing prepared bases

`bash prepare.sh` deliberately reuses nonempty RAW and VDI images; it does not inject the hook into older bases. Existing bases and their differential disks remain untouched by the application. To upgrade a base, run `bash prepare.sh --system <system> --force` for the chosen system. It warns, saves the old pair in `images/backups/`, builds a new RAW/VDI pair, and restores the old pair if preparation fails. It does not block running VMs, but **replacing a base while an old QCOW2/VDI differential disk depends on it can make that disk unusable on the next launch**. Exit affected hosts first, or migrate their service inside the guest if their disks must be kept. Verify `QEMUWEB_START_EXIT 0` in the Debian guest journal, or the script's expected output on Alpine/OpenWrt serial, before discarding backups. Rebuilding requires the usual source downloads and image preparation tools; it can take substantial time.

The rebuilt `images/alpine.{raw,vdi}`, `images/debian13-cloud.{raw,vdi}` and `images/openwrt.{raw,vdi}` pairs are local artifacts excluded from Git and its tags. Each image is self-contained and has no backing file. `--force` saves the previous pair in `images/backups/` for recovery; those older files can be removed after the new base is accepted and no differential disk needs the old one. Never resume an existing differential disk against a replacement base. VirtualBox validation remains VBH54.

For one system at a time, preferably after exiting its hosts:

```sh
bash prepare.sh --system debian13-legacy --force
```

Keep the backup until the new base has passed a boot test. With explicit test approval, run `npm run test:gts16-profiles` for Alpine, Debian Cloud and OpenWrt, and `GTS16_PROFILES=debian13-legacy npm run test:gts16-profiles` for Debian Legacy. The default profile test makes 13 guest boots: three per profile for initial launch, edited Reboot and Stop/Resume; two simultaneous OpenWrt hosts for ISO isolation; and two OpenWrt failure cases for missing script and media. Allow roughly 5–10 minutes with KVM, longer with TCG. The test reads a distinct resource and persistent disk marker after each restart. Missing-media and missing-script behavior on Alpine and Debian Cloud still needs manual verification. `npm run test:gts16-lan2` checks Debian Legacy LAN2 and needs a QEMU build with VDE support.

For an existing differential disk you need to keep, install `scripts/prepare/guest-start.sh` in that guest as `/usr/local/sbin/qemuweb-guest-start` and install the native service shown in its preparation script. That changes only the guest's differential disk. Reboot the host to attach its ISO. New hosts from the old base still require a rebuilt base.

The Debian service now has the shorter name `qemuweb-start.service` and description `Run start.sh`. Existing prepared images keep the old name until their guest service is migrated or the base is rebuilt. To migrate an existing Debian guest without replacing its disk, copy `scripts/prepare/qemuweb-start.service` into the guest as `/etc/systemd/system/qemuweb-start.service`, then run there:

```sh
systemctl disable --now qemuweb-guest-start.service
rm -f /etc/systemd/system/qemuweb-guest-start.service
systemctl daemon-reload
systemctl enable qemuweb-start.service
```

The new name appears in the boot status after the next reboot.
