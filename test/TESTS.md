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

These scenarios require QEMU and prepared RAW images. The LAN2 scenarios also require a QEMU build with VDE support and the VDE tools. LAN2 uses KVM when available and falls back to QEMU/TCG otherwise; `lan2-tcg` forces TCG.

| Command | Script | Purpose |
|---|---|---|
| `./scripts/run-tests.sh lan2` | `lan2-integration.js` | Boot two Debian 13 Legacy guests on one VDE switch; verify distinct ports and MACs, serial login, static IPs, bidirectional ping, and Stop/Resume. Requires `images/debian13-legacy.raw`. |
| `./scripts/run-tests.sh lan2-tcg` | `lan2-integration.js` | Run the same LAN2 scenario with QEMU software emulation. |
| `./scripts/run-tests.sh gts16-lan2` | `lan2-integration.js` | Extend LAN2 with a per-host startup ISO, companion resource, guest script output, persistent disk state, and edited media after Reboot. |
| `./scripts/run-tests.sh gts16-profiles` | `gts16-profiles.js` | Check startup ISO execution, resources, Reboot and Stop/Resume on Alpine, Debian Cloud and OpenWrt; also check concurrent OpenWrt isolation and missing-media/script errors. Requires their three prepared RAW images. |

To run the profile scenario for Debian Legacy alone, use `GTS16_PROFILES=debian13-legacy npm run test:gts16-profiles`. To keep a live LAN2 log, use `./scripts/run-tests.sh lan2 2>&1 | tee lan2.log`.
