# QemuNet to Qemuweb roadmap

This plan tracks the migration of QemuNet's virtual networks to QemuWeb. Version 0.1.0 provides local QEMU hosts, VDE switches and browser consoles; it does not yet manage a LAN as one durable object. Production at CREMI also requires OpenID Connect authentication, isolated sessions for concurrent users, and execution on a remote Linux server. VirtualBox network parity and graphical guests remain later decisions.

## Engine roadmap — project direction

This is the primary engine roadmap for QemuWeb. Keep the execution layer extensible, while implementing and maintaining engines in this order:

1. **QEMU/KVM — primary target.** This is the preferred engine for Linux VMs and VDE-connected LANs. Require KVM when the user selects this mode; report an error if it is unavailable rather than silently changing acceleration.
2. **QEMU/TCG — fallback mode.** Keep it available as an explicit software-emulation fallback for hosts where KVM cannot be used. It is not the preferred routine engine.
3. **VirtualBox — first alternative engine.** Maintain its existing VM support as well as practical, including compatibility with the prepared OS images and lifecycle controls. Keep in mind that its ability to run concurrently with QEMU/KVM depends on host hypervisor constraints.
4. **VMware — future hypervisor.** Preserve room for a future adapter, disk conversion/profile and console integration; do not make it a current implementation target.
5. **Docker / Podman — lightweight VDE terminals.** The current built-in VDE terminal uses `podman unshare` as a rootless user-namespace helper with Bubblewrap; it does not run inside a Podman container. Keep Dockerfile-based container endpoints as a separate future option for reproducible terminals. Any such endpoint must work as an ordinary user without `sudo`, host-level `CAP_NET_ADMIN`, a host TAP/bridge, or host network changes. Validate direct switch attachment, packet exchange and cleanup before choosing a container network design.

## v0.1.0 baseline on `main`

- Create QEMU or VirtualBox hosts and VDE switches from dialogs, optionally starting them immediately. Clone a host with its base system, engine, settings and interfaces; rename it in Settings. A stopped host's launch settings can be edited before its next start. The full launch command remains visible.
- Display one, two or four independent xterm.js console panes and navigate through pages of sessions. QEMU hosts also expose logs and an interactive monitor; a running switch exposes its `vdeterm` management terminal through Socket.IO and `node-pty`.
- Give a new QEMU host one disconnected Ethernet card by default. Before first launch, configure up to four cards and connect them to a VDE switch. Each card gets a MAC address; each connected card gets a distinct VDE port. Debian 13 Legacy uses `e1000`, while Debian 13 Cloud uses `virtio-net-pci`. Stop and Resume preserve these assignments. VirtualBox networking and connections outside the VDE LAN are disabled.
- Resolve configured executable paths from `.env.local` and `.env`, then check required commands at server startup. This is a strict availability check, not yet a per-engine capability report.

A switch and two Debian 13 Legacy hosts have been manually validated exchanging pings. The exact IP configuration, switch port inspection and Stop/Resume results still need a repeatable recorded check. VDE does not provide DHCP; a `169.254/16` address comes from guest link-local configuration and does not by itself establish two-host connectivity. Switches, hosts and disks are still managed as individual sessions tied to the current server process.

The lightweight VDE terminal is available from the bottom session bar. It runs a shell in a Bubblewrap filesystem view and a `vdens` network namespace attached to one running switch. Two terminal sessions have exchanged pings in a local manual test; repeat the complete UI flow after the rebase. See [VDE Light Terminal handoff](vde-light-terminal-handoff.md) for its implementation, requirements, validation and remaining work.

### Next LAN checkpoint

1. Start `s1` and two `debian13-legacy` hosts with their `e1000` cards connected to it. Record both serial consoles and `port/allprint` showing two occupied ports.
2. Assign explicit guest addresses, for example `192.168.10.1/24` and `192.168.10.2/24`; record bidirectional ping and the commands used.
3. Stop and resume both hosts, confirming disk contents and switch assignments survive. Keep this as a repeatable LAN example before whole-network controls and hot attachment.

## Target workflow

1. Sign in for production use, select or provide a topology, inspect the machines and links, and start the whole network.
2. See host A, switch `s1`, and host B in console panes. Each host has its serial console and QEMU monitor; the switch has its VDE management console. Follow network-level status and startup errors in one place.
3. Configure guest interfaces, verify traffic between hosts, stop or resume the network, and explicitly discard or save its state. Another user's networks stay separate; one user can own several networks at once.

The local two-host connectivity milestone has been reached manually. The next milestone is a **two-host LAN managed as one network**: create its switch and hosts together, show their links, and control their lifecycle from the browser. The four-host `demo/lan.topo` is the next compatibility target. A switch alone does not configure guest IP addresses; the verification scenario must supply them explicitly or through guest startup scripts.

The switch session represents the VDE process, not another VM. Its interactive terminal follows `xterm.js ↔ Socket.IO ↔ node-pty ↔ vdeterm ↔ vde_switch -M`, matching QemuNet's optional `-y` mode. It is separate from both a guest shell and the QEMU monitor. Changing the visible pane must not start or stop the switch or its hosts.

## Startup discovery and capability checks

The current startup check resolves commands from `.env.local`, `.env` and `PATH` and stops the server when a required command is missing. It supports a user-installed QEMU, for example under `/opt`. The next step is a per-engine capability report exposed to the UI. Paths remain server configuration, never arbitrary paths submitted by a browser user.

- **Executables and dependencies:** find QEMU, `qemu-img`, `vde_switch` and optional tools required by enabled features; find `VBoxManage` only when VirtualBox is configured. Run lightweight version/help probes with timeouts to catch missing shared libraries and unusable binaries, not just missing files. Check the runtime and image directories for needed access; report missing prepared base images separately by system.
- **QEMU capabilities:** inspect the selected QEMU build for required machine and network backends, especially VDE; inspect `qemu-img` for the formats needed for RAW bases and QCOW2 overlays. Record exact paths and versions. A VDE LAN is unavailable if either QEMU's VDE backend or `vde_switch` is unavailable, while unrelated engines remain usable.
- **Acceleration:** report host CPU virtualization flags (`vmx` or `svm`), `/dev/kvm` presence and permissions, and whether the selected QEMU build can actually use KVM. CPU flags alone do not prove KVM is available. Offer TCG independently when supported; do not silently change a user's KVM selection to TCG.
- **Per-engine result:** check VirtualBox runtime support as well as `VBoxManage`, then publish `available`, `unavailable` or `degraded` with a reason for QEMU/KVM, QEMU/TCG, QEMU/VDE LAN and VirtualBox. Show these results at startup and in Settings, and disable unavailable choices. Recheck capabilities that can change at runtime, such as `/dev/kvm` access or conflicts with active VMs, immediately before launch.

The preflight is a reusable framework, not a record of the current developer machine. Installation and repair guidance should identify the failing component, while an optional missing engine must not prevent the server from serving its other modes.

This later capability report should let optional engines be unavailable without blocking unrelated modes.

## Delivery order

| Stage | Work | Done when |
|---|---|---|
| 0. Startup discovery and preflight | **Partial:** configured paths and strict command checks work. Next, probe QEMU/KVM, QEMU/TCG, QEMU/VDE and VirtualBox separately; publish executable paths, versions and reasons for unavailable modes. | A broken executable or missing dependency disables only the affected mode with a clear diagnostic; the interface offers only verified modes. |
| 1. Define the network contract | Specify an internal network model (`network`, `owner`, `switches`, `hosts`, ordered interfaces), its API and ownership of session files. A switch has its own process, management socket, state, log and session identity. Allow several networks per owner and unique internal IDs independent of user-visible names. Parse a restricted QemuNet `.topo` subset as data: `SWITCH` and `HOST <system> <name> <switch>...`. Validate names, system IDs, switch references, duplicate names and limits before starting any process. Do not execute topology text as shell code. | Valid LAN and two-LAN examples produce the expected graph and stable port/MAC assignments; malformed input starts nothing. The current individual-host flow still works. |
| 2. Network runtime | **Partial:** individual VDE processes, QEMU VDE interfaces, port/MAC assignments and manual two-host connectivity work. Record the LAN check, then give each network its own runtime directory, start/stop switches and hosts as a unit, and handle partial startup failure. | The LAN starts and stops as one unit; repeated or failed starts leave no orphan processes. |
| 3. Browser workflow | **Partial:** host, switch and lightweight VDE terminal creation; interface selection; interactive `vdeterm`; host cloning; Settings; and paged console panes work. Add a network view with topology preview, connected-host/port display, network-level state and log, and whole-network actions. | The two-host LAN can be created, inspected, stopped and resumed as one network entirely from the browser. Individual host, switch and terminal controls remain available. |
| 4. Live attachment | Allow a VM to join an already running VDE switch. A newly started VM can connect in its launch arguments; for an already running QEMU VM, add a VDE backend and a new virtual NIC through the QEMU monitor. Prepare a suitable hotplug-capable bus at VM startup, track assigned ports/MACs, and keep the topology and UI in sync. Treat removal or replacement of an existing NIC as a separate operation because it can disrupt the guest. | With `s1` and a VM already running, the user attaches a new NIC from the web UI, sees the new guest interface and switch port, configures an IP, and exchanges packets without restarting either process. Unsupported VM configurations report why hotplug cannot proceed. |
| 5. Guest setup and compatibility | Provide a documented way to set hostnames and IPs, initially through an opt-in per-host startup directory mounted by virtio-9p where the guest supports it. Map QemuNet system IDs to prepared QemuWeb images; do not assume the old Debian 10 kernel/initrd and the current Debian 13 disk boot are interchangeable. Extend the topology parser only after the basic LAN works. | The four-host demo can boot from supported prepared images with predictable names and IPs; its guest and switch consoles work, and the guests communicate without manual reconfiguration each run. |
| 6. Durable network sessions | Separate **Stop** (keep overlays), **Resume** (same overlays), **Reset** (fresh overlays) and **Delete** (remove network files). Persist owner and network metadata alongside the session state, rather than relying only on the server's in-memory map. Add a versioned, explicit export/import format for topology, guest setup and overlays. Validate imported paths and referenced base images. | One owner can stop and resume two independent LANs with their disk changes; an exported LAN can be restored after a server restart and its connectivity still works. |
| 7. CREMI identity and multi-user isolation | Integrate the CREMI OpenID Connect provider with a server-side login session. Derive the stable user key from the validated issuer and subject claims. Scope every network, VM, switch, overlay, console, monitor, log and export to its owner. Authenticate WebSocket connections and authorize each room subscription and command. Define user quotas, concurrent-session limits, logout/expiry behavior and administrator policy. | Two CREMI users can run separate LANs concurrently, and one user can run multiple LANs. Neither user can list, subscribe to, read, command, reset or delete the other's resources by guessing IDs or calling APIs directly. Session expiry blocks further commands according to the agreed policy. |
| 8. Remote execution | Run the QemuWeb backend on one remote Linux server that owns the images, overlays, QEMU and VDE processes, and Unix sockets. Serve the browser UI over the CREMI-approved authenticated HTTPS entry point; relay host serial streams and switch management traffic through that backend. Define storage location, access rights, reconnect behavior and server restart recovery. | From another computer, an authorized user starts the two-host LAN on the remote server, uses all three consoles, verifies host connectivity, and stops or resumes the LAN. No QEMU/VDE socket is exposed to the network; a dropped browser connection does not stop the LAN. |
| 9. Advanced QemuNet features | Extend the existing multi-interface host and multi-switch support to whole-network topologies. Then add hubs, switch-to-switch trunks, VLAN configuration and selected legacy archive import according to demonstrated use. Define an explicit compatibility list for `.topo` keywords and archive contents. | `twolans.topo` and a chosen routed/DMZ example pass documented connectivity tests; unsupported legacy constructs produce clear errors. |

## Engineering rules for network sessions

- Keep the current serial path (`guest ttyS0` ↔ QEMU Unix socket ↔ Node ↔ Socket.IO ↔ xterm.js). Give the QEMU monitor its own socket for each host.
- Keep the switch terminal path distinct (`browser xterm.js` ↔ `Socket.IO` ↔ `node-pty` ↔ `vdeterm` ↔ VDE management Unix socket). Relay bytes directly between xterm.js and the pseudo-terminal; never pass browser input through a shell. Keep a bounded transcript for reconnection and propagate terminal resizing.
- Use VDE for the first LAN to reproduce QemuNet's switch and port behavior. Require a successful preflight for the selected engine before creating a network session.
- Connecting a VM at launch to an existing switch and attaching a new NIC to a running VM are distinct operations. The latter uses QEMU `netdev_add` followed by `device_add`; `set_link` only changes link state. Test the chosen NIC and `q35` PCIe root-port layout on the installed QEMU version before exposing live attachment in the UI.
- Make generated QEMU arguments and port/MAC assignments visible for diagnosis. Use argument arrays when spawning processes; accept topology text only through the validated parser.
- Treat a network as the lifecycle boundary. A host failure must be visible without silently deleting the other hosts' disks. A partially created network must be recoverable or cleanly removed.
- Design API and event routing around an owner from Stage 1. The current single-VM demo accepts client-provided session IDs and broadcasts some events globally; those paths must be changed before multi-user deployment. A browser session and a virtual-network session are different objects.
- Keep the web server bound to loopback while it has no authentication. Stages 7–8 add CREMI identity and the approved HTTPS entry point before remote access. The browser must reach only the web API and event stream; Unix sockets and image files stay on the server.

## CREMI production contract

- Confirm the CREMI identity provider's OpenID Connect issuer, client registration, redirect URLs and claims. Use the authorization-code flow with PKCE and validate the returned identity; keep application sessions in secure server-side storage with protected cookies. Do not treat a display name or email address as the stable owner ID.
- Authorize **every** HTTP request and Socket.IO event against the authenticated owner, including session discovery, console subscriptions and input, QEMU monitor commands, VDE commands, logs, uploads, exports and deletion. Avoid global broadcasts of user-specific state.
- Give each network an isolated runtime directory and unique IDs for its hosts and switches. Enforce per-user and server-wide limits for VM count, memory, disk and running time so concurrent users cannot exhaust the host.
- Specify whether logout or login expiry merely disconnects the browser or also stops VMs; keep that behavior consistent with session recovery. Record sufficient audit events for ownership and lifecycle diagnosis without recording passwords typed in guest consoles.

## Decisions to settle before implementation

1. Should topology-driven networks accept a pasted/uploaded QemuNet `.topo` file, offer built-in examples, or both? A built-in two-host example is sufficient for the next network milestone; file import is needed for compatibility.
2. The repeatable two-host checkpoint uses manual static IP commands. For the later four-host demo, should guest setup use 9p `start.sh` directories or a prepared image mechanism?
3. When should legacy `.tgz` session import be supported? The proposed order establishes a versioned Qemuweb export first, then imports selected legacy archives with explicit compatibility checks.
4. For remote execution, should the first deployment place the Qemuweb backend directly on the VM host (the proposed simple path), or should a separate central controller manage one or more worker hosts? The first choice supports one remote server; multi-server scheduling can follow later.
5. What are the CREMI OpenID Connect issuer and deployment constraints (registered client, reverse proxy, allowed claims or groups)? This information is needed for Stage 7, but not for the local LAN prototype.
6. What are the expected per-user limits and the policy when a user logs out, a browser disconnects, or a login session expires while VMs are running?

The immediate work is to record the two-host LAN check, define a network object and add whole-network lifecycle controls. Stage 0 capability discovery can proceed alongside it. [From QemuNet to Qemuweb](qemunet-to-qemuweb.md) records the architecture comparison; [qemunet-lan.txt](qemunet-lan.txt) captures the four-host startup trace. Authentication design should follow the [OpenID Connect Core specification](https://openid.net/specs/openid-connect-core-1_0.html) and the [OAuth 2.0 security best current practice](https://www.rfc-editor.org/rfc/rfc9700.html). QEMU documents [VDE backends](https://www.qemu.org/docs/master/system/qemu-manpage.html), [monitor commands](https://www.qemu.org/docs/master/system/monitor.html) and the [PCIe root-port requirement for hotplug on `q35`](https://www.qemu.org/docs/master/devel/vfio-mdpy.html).
