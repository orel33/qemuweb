# Tests

Run commands from the repository root. `./scripts/run-tests.sh --list` shows the available scenarios and prints a short reminder when one starts. `npm test` selects only `test/unit/*.test.js`; the integration scripts must be run explicitly. The integration tests start their own QemuWeb server and guests, then remove the sessions they created.

## Unit tests (`test/unit/`)

Command: `./scripts/run-tests.sh unit` or `npm test`.

| File | Purpose |
|---|---|
| `guest-media.test.js` | Validate startup files and resource paths; check that separate read-only ISOs contain the right script and resources when `genisoimage` and `isoinfo` are available. |
| `host-settings-naming.test.js` | Check automatic host names and the Host Settings Close button. |
| `pud84-ui.test.js` | Check the position of Exit All in the host/switch toolbar. |
| `resource-metrics.test.js` | Parse CPU and memory metrics for Linux processes and VirtualBox. |
| `session-log.test.js` | Check log replay, clearing and history limits. |
| `tcg09-graphic.test.js` | Build the network graph from example topologies and check links, positions and states. |
| `topology.test.js` | Parse and format example topologies; reject invalid references and directives. |
| `vbr06-ui.test.js` | Check the QEMU monitor behavior and Console/Monitor/Log views. |

## Integration tests (`test/integration/`)

These scenarios require QEMU and prepared RAW images. LAN2 and LAN4 require a QEMU build with VDE support and the VDE tools. LAN2 uses KVM when available and falls back to QEMU/TCG otherwise; `lan2-tcg` forces TCG. LAN4 uses KVM by default and can use TCG with `LAN4_ENGINE=qemu-tcg`.

| Command | Script | Purpose |
|---|---|---|
| `./scripts/run-tests.sh lan2` | `lan2-integration.js` | Boot two Debian 13 Legacy guests on one VDE switch; verify distinct ports and MACs, serial login, static IPs, bidirectional ping, and Stop/Resume. Requires `images/debian13-legacy.raw`. |
| `./scripts/run-tests.sh lan2-tcg` | `lan2-integration.js` | Run the same LAN2 scenario with QEMU software emulation. |
| `./scripts/run-tests.sh lan4-startup` | `lan4-startup-templates.js` | Boot four Debian 13 Legacy guests on one VDE switch with automatic startup ISOs. Verify the default `start.sh` keeps `@HOSTNAME@`, `@IFNAME0@` and `@SWPORT0@`, each guest receives `192.168.0.<its VDE port>/24` without serial configuration, and all 12 directed ping paths work. Requires `images/debian13-legacy.raw` and about 4 GiB of guest memory. |
| `./scripts/run-tests.sh gts16-lan2` | `lan2-integration.js` | Extend LAN2 with a per-host startup ISO, companion resource, guest script output, persistent disk state, and edited media after Reboot. |
| `./scripts/run-tests.sh gts16-profiles` | `gts16-profiles.js` | Check startup ISO execution, resources, Reboot and Stop/Resume on Alpine, Debian Cloud and OpenWrt; also check concurrent OpenWrt isolation and missing-media/script errors. Requires their three prepared RAW images. |
| `./scripts/run-tests.sh guest-network` | `guest-network.js` | Boot two guests of each selected system on VDE. Check passwordless root login, `eth0` (including OpenWrt's direct LAN without `br-lan`), startup and interactive `hostname`, static addresses, ping both ways and `tcpdump` request/reply capture on both guests. Requires the selected prepared RAW images and QEMU/KVM. Prints each serial command and a per-check summary; exits nonzero for failed checks. |

To run the profile scenario for Debian Legacy alone, use `GTS16_PROFILES=debian13-legacy npm run test:gts16-profiles`. To keep a live LAN2 log, use `./scripts/run-tests.sh lan2 2>&1 | tee lan2.log`.

To keep the LAN4 guest commands and replies, use `./scripts/run-tests.sh lan4-startup 2>&1 | tee lan4-startup.log`. Set `LAN4_TIMEOUT_MS` for slower boots. The scenario starts an isolated test server and removes its hosts and switch when finished; it does not rebuild the base image.

To narrow the network diagnostic, set `GUEST_NETWORK_PROFILES` to comma-separated IDs, for example `GUEST_NETWORK_PROFILES=openwrt ./scripts/run-tests.sh guest-network`. Set `GUEST_NETWORK_ENGINE=qemu-tcg` for software emulation or `GUEST_NETWORK_TIMEOUT_MS` for slower boots. Keep the command and guest output with `./scripts/run-tests.sh guest-network 2>&1 | tee guest-network.log`. This test uses only temporary working disks and an isolated test server; it does not rebuild or overwrite the base images.
