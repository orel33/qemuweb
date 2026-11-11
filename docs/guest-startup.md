# Guest startup media (GTS16, v0.4.0)

The v0.4.0 validation covers Debian 13 Legacy under QEMU. NQX72 tracks QEMU validation for the newly rebuilt Debian 13 Cloud, Alpine and OpenWrt bases. VirtualBox guest validation is tracked by VBH54, and companion-file editing by FUR92.

Each host can have its own ISO, labeled `QWEBSTART`, attached read-only when enabled. The guest hook finds that label, mounts the ISO read-only at `/mnt/cdrom`, and runs `/mnt/cdrom/start.sh` with `/bin/sh` near the end of boot. Relative paths in `start.sh` resolve from `/mnt/cdrom`, so `cat config/example.txt` reads a companion file. The script runs as root **inside the guest**. It never runs on the Web server. The Host Log records host-side ISO creation and attachment, without copying guest boot messages. On Debian, script output and exit status remain available with `journalctl -b -u qemuweb-start.service`; the normal `[ OK ] Finished ...` boot status remains on serial. The Web console filters the technical `QEMUWEB_START_BEGIN` and `QEMUWEB_START_EXIT` lines from all guest profiles. Alpine and OpenWrt still show the script's own output on serial; failures remain visible as `QEMUWEB_START_ERROR`. The OpenWrt RAW/VDI pair has been rebuilt with a `hostname` get/set command and a direct `eth0` LAN, with no `br-lan`. Two KVM hosts passed the startup hostname and bidirectional LAN diagnostic.

Use Host Settings → Startup to edit or import `start.sh`. Edits remain in the dialog until **OK** saves the script to `runtime/<session-id>/<host-id>/startup/start.sh` on the server; **Cancel** leaves it unchanged. The host's `host.json` keeps startup options such as **Auto-build and attach startup disk**, but no script or companion-file content. Another browser can read the saved script while that server session is active. Existing companion files remain intact when the Web editor saves `start.sh`; editing those files in the Web interface is planned for a later FUR92 milestone. Files placed directly under a host's `startup/` directory also appear on its next rebuilt ISO, including files in relative subdirectories. The server rejects symlinks, unsafe relative paths and files beyond the startup-media limits (64 KiB for `start.sh`, 1 MiB per companion file, 32 companion files and 4 MiB total).

When automatic CD-ROM attachment is enabled, Start, Resume, Reboot and Reset build a fresh read-only ISO from that host's `startup/` directory before launching QEMU or VirtualBox. The build copies the startup files into a temporary staging directory, replaces `@HOSTNAME@` in the staged `start.sh` with the shell-quoted current host name, then removes the staging directory. The saved `startup/start.sh` keeps the template unchanged. Expert previews the `genisoimage` command and planned ISO path. The built `startup-<generation>.iso` stays in the host directory outside `startup/` while needed. A running host keeps its current media until a restart. An empty script removes `start.sh` and produces a missing-script error on boot, including after a Web edit. A normal server shutdown removes each host directory, including its `startup/`, `host.json` and ISO files; restoring them after a server restart is a later roadmap stage.

A newly created host starts with `#!/bin/sh` and `hostname @HOSTNAME@`. The Startup tab lists `@HOSTNAME@` as the currently supported template value. Saving a nonempty `start.sh` adds a final newline if needed. The generation number in `startup-<generation>.iso` keeps the currently attached ISO separate from the next one while a host restarts. The server removes older ISO generations once the new launch no longer needs them.

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

`bash scripts/prepare.sh` deliberately reuses nonempty RAW and VDI images; it does not inject the hook into older bases. Existing bases and their differential disks remain untouched by the application. To upgrade a base, run `bash scripts/prepare.sh --system <system> --force` for the chosen system. It warns, saves the old pair in `images/backups/`, builds a new RAW/VDI pair, and restores the old pair if preparation fails. It does not block running VMs, but **replacing a base while an old QCOW2/VDI differential disk depends on it can make that disk unusable on the next launch**. Exit affected hosts first, or migrate their service inside the guest if their disks must be kept. Verify `QEMUWEB_START_EXIT 0` in the Debian guest journal, or the script's expected output on Alpine/OpenWrt serial, before discarding backups. Rebuilding requires the usual source downloads and image preparation tools; it can take substantial time.

The rebuilt `images/alpine.{raw,vdi}`, `images/debian13-cloud.{raw,vdi}` and `images/openwrt.{raw,vdi}` pairs are local artifacts excluded from Git and its tags. Each image is self-contained and has no backing file. `--force` saves the previous pair in `images/backups/` for recovery; those older files can be removed after the new base is accepted and no differential disk needs the old one. Never resume an existing differential disk against a replacement base. VirtualBox validation remains VBH54.

For one system at a time, preferably after exiting its hosts:

```sh
bash scripts/prepare.sh --system debian13-legacy --force
```

Keep the backup until the new base has passed a boot test. With explicit test approval, run `npm run test:gts16-profiles` for Alpine, Debian Cloud and OpenWrt, and `GTS16_PROFILES=debian13-legacy npm run test:gts16-profiles` for Debian Legacy. The default profile test makes 13 guest boots: three per profile for initial launch, edited Reboot and Stop/Resume; two simultaneous OpenWrt hosts for ISO isolation; and two OpenWrt failure cases for missing script and media. Allow roughly 5–10 minutes with KVM, longer with TCG. The test reads a distinct resource and persistent disk marker after each restart. Missing-media and missing-script behavior on Alpine and Debian Cloud still needs manual verification. `npm run test:gts16-lan2` checks Debian Legacy LAN2 and needs a QEMU build with VDE support.

For an existing differential disk you need to keep, install `scripts/prepare/resources/guest-start.sh` in that guest as `/usr/local/sbin/qemuweb-guest-start` and install the native service shown in its preparation script. That changes only the guest's differential disk. Reboot the host to attach its ISO. New hosts from the old base still require a rebuilt base.

The Debian service now has the shorter name `qemuweb-start.service` and description `Run start.sh`. Existing prepared images keep the old name until their guest service is migrated or the base is rebuilt. To migrate an existing Debian guest without replacing its disk, copy `scripts/prepare/resources/qemuweb-start.service` into the guest as `/etc/systemd/system/qemuweb-start.service`, then run there:

```sh
systemctl disable --now qemuweb-guest-start.service
rm -f /etc/systemd/system/qemuweb-guest-start.service
systemctl daemon-reload
systemctl enable qemuweb-start.service
```

The new name appears in the boot status after the next reboot.

## OpenWrt LAN DHCP/DNS role (RHV62)

For an OpenWrt host, **Network → OpenWrt LAN DHCP/DNS** enables one DHCPv4 and local DNS service on Ethernet 0. Connect Ethernet 0 to a switch first, then enter the LAN IPv4 address/prefix, first and last DHCP pool address, and local domain. The server rejects network/broadcast addresses, a pool outside the subnet or containing the server address, malformed domains, and a second QemuWeb-managed DHCP/DNS host on the same switch. Other DHCP servers outside QemuWeb cannot be detected reliably. The service supplies the LAN address as DNS and sends no default gateway; external DNS forwarding needs a separately configured upstream connection.

The validated role lives in `host.json`. Clicking **OK** writes a complete `startup/pre-start.sh` beside the user-editable `startup/start.sh`. While this role is enabled, QemuWeb owns and regenerates `pre-start.sh` on each OK; edit `start.sh` for user commands. Other hosts can keep a manually supplied `pre-start.sh`. The next automatic ISO build packages both files from `startup/`. The guest hook mounts this ISO once, runs `pre-start.sh` first, then runs `start.sh`. Saving `start.sh` in the Web editor preserves the generated file and any other companion files. The role requires **Auto-build and attach startup disk**. Changes apply on the next host start or reboot.

The OpenWrt image prepared by `scripts/prepare/openwrt.sh` has direct `eth0`, no default DHCPv4 or LAN DNS service, and no IPv6 router advertisements. Rebuild an older OpenWrt RAW/VDI pair with `bash scripts/prepare.sh --system openwrt --force` after stopping hosts whose working disks depend on the old base. The generated script creates only the `network.qemuweb_lan`, `dhcp.qemuweb_dns` and `dhcp.qemuweb_lan` UCI sections and a marker on the guest disk. An early OpenWrt init service removes these sections before dnsmasq starts on every later boot. The late startup hook also cleans them on manual reruns before looking for media. Disabling the role therefore takes effect even if the ISO is detached and the working disk is preserved, without an early DHCP response window. Other guest UCI sections remain untouched.

With test approval, validate creation and editing through Host Settings, then reboot an enabled host and two clients on the same switch. Confirm that the clients receive distinct pool addresses, option 6 points to the OpenWrt LAN address, option 3 supplies no gateway, and each client resolves the other's DHCP name in the chosen domain. Disable the role, detach the ISO, reboot while keeping the working disk, and confirm that the managed UCI sections and DHCP/DNS service are gone. Run `node --test test/unit/openwrt-lan-role.test.js` for role validation and generated commands.
