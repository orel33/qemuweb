# Live addresses with the QEMU guest agent (study GAG01)

Goal: show the address of a running host, with its prefix (`192.168.0.1/24`), in the Graphic view, on the
interface it belongs to (`eth0`, `eth1`, ...), updated when the guest changes it, cleared when the host stops.

This note holds the measurements behind the design (the QEMU command line, the images, the safety rules, the
alternatives). Everything marked **measured** was run on a throwaway QEMU machine (qcow2 overlays of the base
images, QEMU 8.2.2 with KVM, a temporary directory, cleaned up afterwards, nothing under `images/` written).
Everything marked **read** comes from the code, the manuals or the images read offline. **Not verified** says
what nobody has run yet.

## 1. Verdict

**GO for QEMU**, on every system, once the agent is in the image and the channel is on the command line.

| System | Agent in the shipped image | Works with the channel | Verdict |
|:--|:--|:--|:--|
| debian13-legacy | yes (`qemu-guest-agent` 1:10.0.13, added by the Debian installer on a QEMU machine) | measured | GO now |
| debian13-cloud | no (its 4 dependencies are there) | measured after `apt-get install` | GO after the image build installs it |
| alpine | no | measured after `apk add qemu-guest-agent` (11.0.3) | GO after the build installs it |
| openwrt | no | measured after `apk add qemu-ga` (10.1.2) and a reboot | GO after the build installs it |

**VirtualBox**: no qemu-ga channel exists; the equivalent is the Guest Additions guest properties
(section 9), not measured (VirtualBox was not started). The code for it stays inert (`guestAgent:vbox` is
false everywhere).

A guest that has no agent simply shows no address: the poller gets no answer, backs off, and the Graphic
view shows nothing. No error is raised.

## 2. What must be added to the QEMU command line (question 1)

Read in `runner/engines/qemu.js` and measured:

```text
-chardev socket,id=qga,path=<node dir>/qga.sock,server=on,wait=off
-device virtio-serial-pci
-device virtserialport,chardev=qga,name=org.qemu.guest_agent.0
```

- They go in `qemuArgs()` after the serial ports, only when the system's resolved `guestAgent` is true
  for the engine. The three options exist in QEMU 8.2.2 (`-device virtserialport,help`,
  `-device virtio-serial-pci,help`) and the machine booted with them on q35 for all four systems.
- The channel must be declared at boot (the NET03/CAP01 finding: a PCI device cannot be hot-added on
  `pcie.0`). `virtio-serial-pci` plugs into `pcie.0` like the virtio NIC and disk do; it needs no
  `pcie-root-port`.
- `qga.sock` is 8 characters, shorter than `serial0.sock` (12): the 107-byte check of
  `common/runtime-dir.js` only has to list it. QEMU removes the socket file when it exits (**measured**: a
  connection after the process exited fails with ENOENT, which is how the runner can tell "host gone").
- Cost, **measured** on debian13-legacy (3 boots with and 3 without the channel):

| | Without | With |
|:--|:--|:--|
| Boot to login prompt (s) | 33.2, 28.8, 29.7 | 33.9, 33.7, 30.8 |
| Guest MemAvailable (MB) | 794, 795, 794 | 793, 792, 788 |
| QEMU process RSS on the host (MB) | 378, 380, 378 | 385, 375, 385 |

  The boot time and the host RSS differences are inside the run-to-run noise (about 4 s and 7 MB); the guest
  loses 2 to 6 MB, which is the `qemu-ga` process (RSS 4.7 MB Debian legacy, 4.3 Debian cloud, 1.9 Alpine,
  2.9 OpenWrt). One more Unix socket and one PCI device per host.

## 3. Images (question 2)

| | debian13-legacy | debian13-cloud | alpine 3.24 | openwrt 25.12 |
|:--|:--|:--|:--|:--|
| Package | `qemu-guest-agent` 1:10.0.13 | same, `apt-get install --no-install-recommends` | `qemu-guest-agent` 11.0.3 (community, already enabled in the image) | `qemu-ga` 10.1.2 |
| Already in the image | **yes** (installer, read from `/var/lib/dpkg/status`) | no | no | no |
| Added size | 0 | about 4 MB (root used 1006 to 1010 MB; Installed-Size 3745 KB; no new dependency) | agent 946 KiB + glib, numactl, liburing (9 packages with the OpenRC subpackage; total not isolated) | about 6 MB (root 25064 to 31044 KB; 9 packages: libevdev, libudev-zero, virtio-console-helper, ...) |
| Starts how | udev rule `60-qemu-guest-agent.rules` starts the unit when the virtio port appears; without the channel it never starts | same (static unit, the rule starts it) | OpenRC `qemu-guest-agent`; `rc-update add qemu-guest-agent default` | procd `qemu-ga`, started by the hotplug script `10-qemu-ga`; `/etc/init.d/qemu-ga enable` |
| Kernel side | `virtio_console` in the Debian kernel | same | `virtio_console` builtin (linux-virt) | `virtio_console` builtin |
| Gotcha | none | `apt` does not start it right after the install (static unit): it appears at the next boot | none | the package must be installed **before** the boot: its helper creates `/dev/virtio-ports/org.qemu.guest_agent.0` at hotplug time; without the symlink `qemu-ga` fails with "error opening channel" |
| Guest login to first answer | measured: first `guest-ping` answered about 4 s after the login prompt | answers after the next boot (first ping 34.5 s after `reboot`, boot included) | first ping 12.4 s after `reboot` | answers at the first call after boot (not timed) |
| Agent version | 10.0.13 | 10.0.13 | 11.0.3 | 10.1.2 |

`guest-info` shows 43 commands enabled on a default install (Alpine 42): **including** `guest-exec`,
`guest-file-*`, `guest-set-user-password`, `guest-shutdown` and `guest-ssh-add-authorized-keys`. See section 6.

How `scripts/prepare` installs it (implemented in this version, **not run**: the images are rebuilt by the user): the
Debian legacy preseed lists packages in `pkgsel/include` (add `qemu-guest-agent` explicitly, today it only
comes from the installer's QEMU detection); the Debian cloud cloud-init has a `packages:` list (add it);
Alpine has the `apk --root "$target" add` line (add it, then `ln -s` the OpenRC service in
`etc/runlevels/default`); OpenWrt has `apk -U add tcpdump nano` in its guest script (add `qemu-ga` and enable
the service). Each build also writes `/etc/qemu/qemu-ga.conf` with the allowlist (section 6).

## 4. What the agent returns (questions 1 and 6 of the goal)

**Measured**, debian13-legacy after `ip addr add 10.1.2.3/24 dev eth0`:

```json
{"return": [
 {"name": "lo", "hardware-address": "00:00:00:00:00:00",
  "ip-addresses": [{"ip-address-type": "ipv4", "ip-address": "127.0.0.1", "prefix": 8},
                   {"ip-address-type": "ipv6", "ip-address": "::1", "prefix": 128}],
  "statistics": {"tx-packets": 0, "rx-bytes": 0, "...": 0}},
 {"name": "eth0", "hardware-address": "52:54:00:aa:bb:01",
  "ip-addresses": [{"ip-address-type": "ipv4", "ip-address": "10.1.2.3", "prefix": 24},
                   {"ip-address-type": "ipv6", "ip-address": "fe80::5054:ff:feaa:bb01", "prefix": 64}],
  "statistics": {"...": 0}}]}
```

- **Address and prefix, per interface, with name and MAC**: yes, on all four systems (the same code, `getifaddrs`
  and `/sys/class/net`). 670 bytes for two interfaces. Debian cloud with DHCP from the user-mode network gave
  `eth0 52:54:00:12:34:56: 10.0.2.15/24`, `fec0::5054:ff:fe12:3456/64`, `fe80::.../64`. Alpine: after
  `ip addr add 192.168.7.9/28` and `ip addr del 10.0.2.15/24` the reply was exactly
  `eth0 [192.168.7.9/28]`.
- **Matching**: the runner knows the MAC of each NIC (`node.networkInterfaces[n].mac`); the reply's
  `hardware-address` is the key (lower-case compare), the name (`eth0`) the fallback. The images use
  `net.ifnames=0`, so names are `ethN` on Debian, Alpine and OpenWrt (OpenWrt's `eth0` is the LAN port, with only
  a link-local address until the startup script assigns one).
- Other read-only commands, **measured** on Debian: `guest-get-host-name` (`{"host-name":"qemuweb"}`),
  `guest-get-osinfo` (name, pretty-name, version, kernel-release), `guest-get-time`, `guest-get-vcpus`,
  `guest-get-memory-blocks`, `guest-get-fsinfo` (mount point, total and used bytes), `guest-info` (the list of
  supported commands and the version). Worth showing later: host name, OS (`pretty-name`). Not worth the polling
  cost for now: time, vcpus, memory blocks, fsinfo.

## 5. When the replies are reliable (question 3)

- **Latency**: **measured** 0.1 s per call (3 ms for the very first), every command, on all systems. A poll is
  one `guest-sync-delimited` handshake plus one command over one connection: two round trips.
- **Change shows up**: the agent reads the kernel on every call, so a new address (DHCP lease, `ip addr add`,
  static at boot) is in the next reply. There is **no event or push** in `qemu-ga`; `guest-exec` of
  `ip monitor` would be a poll too, and `guest-exec` must stay disabled. The change therefore shows up after at most
  one polling interval. Interval: 2 s while a Graphic view or console of the session is open, 10 s otherwise is the
  proposal; at 30 sessions with 5 hosts each that is at most 75 calls per second on the machine, each 670 bytes and
  a few tens of microseconds of runner CPU (**estimate**, not measured under load); the wait is the agent's 0.1 s,
  not CPU.
- **Agent not ready**: the agent starts late (Debian: with the udev rule, 4 s after the login prompt; Alpine,
  OpenWrt: with the runlevel). Until then a call gets **no answer**. The state is "unknown", not an error.
- **Agent stopped or absent** (**measured**: `systemctl stop`, and Alpine/OpenWrt before installing it): the
  socket still accepts the connection, the sync request is never answered, the call times out at the caller's
  deadline (3 s in the test; 2 s proposed). Back to normal on the first call after the agent restarts
  (0.02 s). A request left unanswered does not poison the next one: each call starts with
  `guest-sync-delimited` and a fresh id.
- **Reboot** (**measured**, Debian): QEMU stays, the socket stays; the ping fails 1.7 s after the reboot command
  and answers again 37.8 s later (the boot). The poller must drop the old addresses at the first failure.
- **Stop of the host** (**measured**): QEMU exits and **removes `qga.sock`**; `connect()` then fails with ENOENT.
  The runner already knows the host stopped (`child.once('exit')`) and clears the addresses there.
- A note on the first reboot test: the guest seemed stuck and `system_powerdown` did not end the machine within
  60 s (`qemu exited=None`). The cause was the test harness: it stopped reading the serial socket while it polled
  the agent, so the guest blocked writing to its console. With the serial read the reboot and the powerdown
  worked. The runner always reads the serial sockets, so the agent channel is unaffected.

## 6. Trust and safety (question 4)

The guest is untrusted and a student is root in it: the channel is a guest-to-host surface. Four walls:

1. **Allowlist in the runner** (the real wall, because the guest owns the agent and can replace it): the runner
   sends only `guest-sync-delimited`, `guest-ping`, `guest-info`, `guest-network-get-interfaces` (later
   `guest-get-host-name`, `guest-get-osinfo`), from a fixed table, with no argument from outside. Nothing else
   is forwardable: no API takes a command name.
2. **Allowlist in the agent** (second wall, protects against a mistake in the first, **measured** on Debian and
   Alpine): `/etc/qemu/qemu-ga.conf` with
   `[general]` / `allow-rpcs=guest-sync,guest-sync-delimited,guest-ping,guest-info,guest-network-get-interfaces,...`.
   After a restart `guest-info` lists only those commands, and `guest-exec`, `guest-file-open`, `guest-shutdown`,
   `guest-set-user-password` all answer `CommandNotFound ... has been disabled: the command is not allowed`.
   `allow-rpcs` (manual page `qemu-ga(8)`) is better than the old blocklist: everything not listed is off, so a
   command added by a later QEMU stays off. Debian 13 has no `/etc/default/qemu-guest-agent`; the default
   configuration path `/etc/qemu/qemu-ga.conf` works on an unmodified unit. **Not verified** on OpenWrt. It must
   be written **inside the image** (the build scripts do it); the host cannot enforce it, because root in the
   guest can edit the file or run its own program on the port.
3. **Hostile replies** (**measured**, Debian guest with the real agent stopped and a script of ours on
   `/dev/virtio-ports/org.qemu.guest_agent.0`):
   - *Forged data*: the script answered the sync, then returned `8.8.8.8/24`, an `<img onerror>` as an address and
     a 1000-character `<script>` as an interface name. A naive reader accepts all of it. It cannot be prevented
     (the guest says what it wants, as `ip addr` would): the value is informational only.
   - *Endless reply without a newline*: the guest wrote about **900 MB/s**; a naive reader holding the reply
     reached 9 GB in 10 s (QEMU's own RSS did not grow: 393 MB before and after). The runner reads with a hard
     cap (64 KB per reply, 256 KB per second of connection) and a deadline, and drops the connection.
   - *Never answering*: the call times out at the deadline (3.02 s measured); the poller backs off.
4. **Validation before anything reaches a browser**: strict patterns (IPv4 dotted quad checked with `net.isIPv4`,
   prefix an integer 0 to 32, IPv6 with `net.isIPv6` and prefix 0 to 128, interface name `^[A-Za-z0-9_.:@-]{1,15}$`,
   MAC `^([0-9a-f]{2}:){5}[0-9a-f]{2}$`), at most 16 interfaces and 8 addresses per interface, host name and OS
   strings printable ASCII up to 64 characters. The browser puts them in the page with `textContent` (never
   `innerHTML`). A value that fails the check is dropped, not repaired.
5. **Never used for anything else**: the address is not used for routing, matching other nodes, or any decision. A
   guest that lies about its MAC only changes what is shown on **its own** host (the match is limited to the NICs of
   that node).
6. **Rate limit**: at most one call in flight per host and one poll per second per host, with a global cap, so a
   guest cannot make the runner busy; a guest that answers slowly is simply polled slowly.
7. **Socket access**: the node directory is created with the default umask; the socket mode follows it. GAG
   creates the node directory with mode 0700 when the agent is on so that no other local user can connect to
   `qga.sock`. The browser user never reaches the file: there is no route that opens it.

## 7. Alternatives without software in the guest (question 5)

| | Guest agent | Passive wire learning (`filter-dump`) | Both |
|:--|:--|:--|:--|
| What it sees | The kernel's real state: every address with its prefix, even one set by hand and never used | Only what was said on the wire: DHCP (address and mask are in the server's reply), ARP, IPv6 neighbour discovery | Agent first; the wire fills in while the agent is silent |
| **Measured** on Debian with user-mode DHCP and `filter-dump` | | The pcap held DHCP Request/Reply, ARP who-has/is-at, IPv6 solicitations and router advertisement. An address added with `ip addr add 10.0.2.77/24 dev eth0` produced **no packet** until it was used, so it never appeared. | |
| Prefix | yes | DHCP only (option 1); ARP gives no prefix | the agent's |
| Coverage by image | the four systems, after the build change | every guest, nothing to install | all |
| Forgeable by the guest | yes | yes (it can send any ARP) | yes |
| Cost | 1 socket, one PCI device, 2 to 5 MB per guest, polling | a capture running all the time on every NIC (disk and CPU), a parser, an extra `object_add` per host; the CAP01 filter is limited to 4 per node | both costs |
| Work | M | L (pcap walker exists in `runner/pcap.js`, a DHCP/ARP parser does not) | agent + L |

The other two ideas: a command typed on the serial console is rejected (it types into the student's terminal),
and a startup script that reports needs every lab to do it. Verdict: **build the agent now**; keep the wire as a
later fallback only if a system must be shown without an agent (nothing needs it today: all four systems can
carry the agent).

## 8. What to show (question 6)

Worth the cost now: the **IPv4 address with prefix on the host end of each link** in the Graphic view (global IPv6
addresses can follow, link-local never). Cheap additions to the same reply: host name and OS in the host tooltip.
Not now: uptime (not in the agent's read-only list worth enabling), fsinfo, vcpus. Later: the same fields in Host
Settings (read-only) and in Admin for an observed session.

Data shape (runner → server → browser), one place:

```text
node state:  addresses: { "0": ["192.168.0.1/24"], "1": [] }   // key = NIC index; empty when stopped
             guest:     { hostname?: "qemuweb", os?: "Debian GNU/Linux 13 (trixie)" }   // optional, later
event:       'guest-info' {nodeId, addresses, guest}         // sent only when the value changed
REST read:   GET /api/nodes (already lists the node state) carries the same fields
```

## 9. VirtualBox (additions A and B of the brief)

Out of scope for the measurement (VirtualBox must not be started); written from the documentation and the code:

- The equivalent is the Guest Additions property store: `VBoxManage guestproperty enumerate <vm> --patterns
  '/VirtualBox/GuestInfo/Net/*'` gives `/Net/Count`, and for each index N `/Net/N/V4/IP`, `/V4/Broadcast`,
  `/V4/Netmask`, `/MAC` (12 hex digits, no colons), `/Name` and `/Status`. A new address shows up after the
  Guest Additions service refreshes the property (interval not measured). `guestproperty wait` can push, but each
  wait is a long-running child process: a polled `enumerate` is simpler.
- Netmask `255.255.255.0` to prefix `24`: count the leading one-bits, refuse a non-contiguous mask.
- The MAC of each NIC is exposed (`/MAC`), and `runner/engines/vbox.js` sets each MAC itself
  (`--macaddress<N>`), so matching by MAC works the same.
- Availability: the Guest Additions need `virtualbox-guest-utils` or the Guest Additions ISO (kernel modules);
  Debian, possibly; Alpine (`virtualbox-guest-additions`), uncertain; OpenWrt, no. **Not verified**: the
  packages and their version against the VirtualBox of the user. The images' `guestAgent:vbox` stay false.
- Poll cost: one `VBoxManage` process per call (about 50 to 100 ms of CPU), so the interval must be longer than
  for QEMU (10 s).
- A later, authorised VirtualBox measurement must check: that Guest Additions installs in each image, the keys and
  their update delay after `ip addr add`, the MAC format, IPv6 keys, what a stopped or crashed VM returns, the
  time of one `enumerate`, and the effect of installing them on boot time and image size.

## 10. Profile keyword (addition B)

`guestAgent:qemu` and `guestAgent:vbox`, booleans, resolved by the existing suffix scheme
(`common/system-config.js`: `key:engine`, then `key`, then the parent). The keyword says that the **image**
contains the agent of that engine: it is a capability of the image, so it is not in `editableKeys`, not in Host
Settings, not in `host.json`. `systems.default` sets both to false, the four systems set `guestAgent:qemu` true (their builds in
`scripts/prepare` install the agent; an image built before has the channel but no agent, which shows no address),
and a profile that ends without a boolean is refused at start. Alternatives considered: a string naming the agent (`"qemu-ga"`) was dropped because nothing
branches on the name; a host-level switch was dropped because a student cannot add a package to the image from the
page. Files that know the profile keys: `common/system-config.js` (the `keywords` set and `validateProfile`),
`runner/catalog.js` and `runner/commands/settings.js` (expose it as `guestAgent` for the session's engine),
`docs/json-files.md`, `test/unit/guest-agent-config.test.js`. `CONFIG_SCHEMA_VERSION` is now 2: a `config.json`
of version 1 is refused at start (beta: no migration; a custom file is edited by hand).

## 11. Design and tasks (implemented in GAG01; the table lists what was done)

| Task | Size |
|:--|:--|
| M1 Keyword, validation, exposure, this note | S |
| M2 Channel in `qemuArgs`, `qga.sock` in the paths, the 107-byte check and the socket cleanup, node directory 0700 | S |
| M2 `runner/guest-agent.js`: connection, handshake, allowlist, caps and deadline, polling with back-off, parser and validator, MAC matching, events | M |
| M2 VirtualBox poller behind the same interface (inert) | S |
| M3 Graphic view: label next to the host end of the link, tooltip, live update, clear on stop | M |
| M4 `scripts/prepare` for the four systems, allowlist file, docs | M |
| Tests: fake channel with the recorded replies, hostile cases, parser, matching, budget | M |
| Later: wire fallback (`filter-dump` parse), Host Settings and Admin fields, VirtualBox measurement | L |

## 12. From the shell

`scripts/guest-agent.sh [--runtime DIR] [--port PORT] [--json] [HOST] ping|info|interfaces` asks the agent of a
running host without talking to the socket by hand. It is a thin wrapper around `scripts/guest-agent.js`, which reuses
`queryAgent` (runner/guest-agent.js: handshake, 2 s deadline, 64 KB cap) and the validation of
`common/guest-addresses.js`, so `interfaces` shows what the browser shows. Only the three commands exist
(`guest-ping`, `guest-info`, `guest-network-get-interfaces`): any other word, raw JSON or extra argument is a usage
error (status 2) and nothing is sent.

| Command | Output |
|:--|:--|
| `ping` | `ok` |
| `info` | `guest agent version: 10.0.13` and `enabled commands (N): ...`, the commands the agent reports as enabled; a `WARNING` line when one of them is `guest-exec`, `guest-file-*`, `guest-shutdown`... (the image is not restricted, section 6) |
| `interfaces` | the table `NIC  NAME  MAC  ADDRESS/PREFIX` (`-` for an interface with no NIC or no address), then `The Graphic view shows:` and one `NIC n: address, ...` line per NIC; `--json` prints `{interfaces, shown}` |

`HOST` is a node ID (`h-...`), a host name or a unique prefix of either (names come from `host.json`); with no
`HOST`, the only host that has a `qga.sock` is used. Several matches are listed and the command stops (status 2): it
never guesses. The runtime directory is the default one of the local runner of the port (`/tmp/qw-<login>/l-<port>`, port 3002) or
`--runtime`. The runner polls the same socket every 5 s and the channel serves one client at a time: a refused or
closed connection is retried 3 times, 1 s apart, and the command says so. Replies are never printed as received
(validated strings only, control characters removed). Status: 0 ok, 1 error or no answer, 2 usage or ambiguity.

```
$ scripts/guest-agent.sh alice interfaces
NIC  NAME  MAC                ADDRESS/PREFIX
-    lo    00:00:00:00:00:00  -
0    eth0  52:54:00:aa:bb:01  10.1.2.3/24

The Graphic view shows:
  NIC 0: 10.1.2.3/24
```

`bash scripts/prepare.sh --list` also tells, offline, whether each raw image carries the agent: `guest agent: yes
(restricted)` (the binary and `/etc/qemu/qemu-ga.conf` with its `allow-rpcs` line), `yes (NOT restricted)` (the binary
without that configuration: rebuild), `no` or `unknown`
(`debugfs` missing, unreadable image or partition table, 10 s limit). The binary is looked for in `/usr/sbin/qemu-ga`
(Debian) and `/usr/bin/qemu-ga` (the Alpine and OpenWrt packages; not verified on those two images: a `no` there
means neither place has it).

## 13. Open risks

- The images shipped with this version do not carry the allowlist file until they are rebuilt (`prepare.sh --system <id> --force`).
  Until then the Debian legacy agent runs with all its commands enabled (the runner still sends only the four).
- `allow-rpcs` was not exercised on OpenWrt; the agent versions differ per system (10.0 to 11.0).
- Polling cost under 30 busy sessions is an estimate.
- The boot-time figures are noisy; the channel's cost is below the noise.
- A student with root can stop the agent, replace it, or lie: the address is a display hint, nothing more.
- VirtualBox: nothing measured. An Alpine or OpenWrt image that now has the agent enabled, started under VirtualBox
  (no virtio-serial channel), logs a failed start of the agent at each boot; harmless, not measured.
- The builds in `scripts/prepare` were changed but not run: the first rebuild of each image must be checked
  (`guest-info` lists only the three allowed commands; the address shows on the Graphic view).
