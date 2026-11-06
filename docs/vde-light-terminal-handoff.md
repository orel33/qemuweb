# VDE Light Terminal — Handoff

## Purpose and branch

This note records the lightweight VDE terminal prototype on `feature/vde-light-terminal`, so work can resume later without relying on chat history.

The branch adds a terminal session that acts as a small Linux endpoint on a running VDE switch. It is intended for commands such as `ip`, `ping` and `tcpdump`, without booting a VM or creating a host TAP/bridge. The terminal gets a private VDE port from the allocator shared with VM interfaces. It is integrated into the current multi-console interface: create a terminal from the bottom bar, select a switch in the terminal network controls, and use Play/Stop/Exit.

Relevant commits:

- `a06ecd3 feat: add lightweight VDE terminal` — terminal API, `vdens` attachment, port allocation and lifecycle, rebased on current `main`.
- `33aee6e Add filesystem isolation to VDE terminal` — rootless Bubblewrap filesystem view, Podman user namespace helper, VDE socket relocation and cleanup.
- The current working tree also integrates terminal creation and lifecycle controls into the multi-console UI from `main`.

The feature branch has been rebased on `origin/main`. The shared main checkout may be used by another task. Continue this work in the feature branch or a separate worktree; do not switch or commit these changes onto `main`.

## Current implementation

The browser terminal uses xterm.js over Socket.IO. On the server, `node-pty` launches this process chain:

```text
xterm.js ↔ Socket.IO ↔ server.js ↔ node-pty ↔ podman unshare ↔ bwrap ↔ vdens ↔ bash
                                                        │        │
                                              filesystem view   VDE net namespace
                                                                  ↕
                                                           VDE Unix socket
```

`server.js` starts `podman unshare bwrap`, then starts `vdens` with the selected switch's VDE URL and a reserved port, and finally a login Bash shell. Bubblewrap exposes selected host system tools and libraries read-only, creates temporary `/home`, `/root`, `/tmp` and `/run`, and mounts only the selected switch socket directory for writable socket access. The host home directory and project tree are not mounted in the shell view. `vdens` attaches `vde0` to the selected switch. The terminal must be attached to a running switch; it cannot create a VDE LAN on its own.

VDE provides Ethernet switching but no DHCP service. The user must bring `vde0` up and configure an IP address manually. A VDE switch is not a guest shell: its separate management terminal is still `vdeterm`.

The VDE runtime socket directory is stored under the operating system temporary directory with a per-user and per-checkout name. The switch socket directory permissions allow the sandbox to connect while preventing it from managing the directory. `killall.sh` also finds and cleans switches and temporary VDE runtime files belonging to this checkout.

## Is the prototype usable?

**Yes, as a local developer prototype for manual network tests.** The feature has been exercised with a temporary QemuWeb server and a temporary switch. Two isolated terminal sessions attached to the same switch and exchanged ping packets successfully. The shell showed only its isolated home under `/home`, did not expose `/home/orel` or the project directory, and showed `lo` plus `vde0`. `bash`, `ip`, `ping` and `tcpdump` were available in the tested host environment. After rebasing, the server preflight, systems endpoint, static terminal controls and create/start/stop/delete API flow were exercised on a separate port; a Socket.IO client also sent a shell command and received its output. Temporary sessions and the test server were cleaned up afterward.

The prototype is not yet a packaged or production-ready sandbox. The integrated UI should be retested in a real browser; the API lifecycle has been checked, but browser interaction and actual terminal input after the rebase still need confirmation. Rootless Podman/Bubblewrap setup must be available on every host running QemuWeb. Filesystem namespace isolation should not be treated as a complete security boundary for untrusted users or public multi-user deployment.

## Requirements

The host needs the existing Node/QemuWeb dependencies plus:

- `podman`, configured rootless for the account running QemuWeb, with usable subordinate UID/GID ranges;
- `bubblewrap` (`bwrap`);
- `vdens` and the VDE tools (`vde_switch`, `vdeterm`); `node-pty` is provided through npm dependencies.

The executable names are configurable through `.env` / `.env.local`; startup preflight now checks `PODMAN` and `BWRAP` too. The README contains the user-facing installation requirements. Useful host-side diagnostics when resuming development include `podman unshare id`, `bwrap --version`, and the QemuWeb startup preflight output.

## Known limits and follow-up work

1. **Retest the complete UI flow.** Start QemuWeb, create/start a switch, create a VDE terminal tab, select the switch, start the terminal, configure `vde0`, and ping another endpoint. Check stop/resume, closing the terminal tab, and stopping a switch with an attached terminal.
2. **Test setup failures.** Confirm the UI reports clear errors for missing Podman/Bubblewrap, broken rootless Podman configuration or subordinate ID ranges, missing `vdens`, and a stopped/missing switch socket. Verify failed starts release their reserved ports and partial runtime directories.
3. **Test cleanup and isolation edges.** Exercise repeated starts/stops, QemuWeb shutdown, `killall.sh` dry run/cleanup, multiple switches, and two checkouts by the same user. Confirm one terminal sees only its selected switch socket and cannot remove it.
4. **Review the filesystem view across distributions.** Current read-only mounts target common `/usr` and `/etc` paths plus `/dev` and `/proc`; commands that depend on other host paths may fail. Verify Debian/Ubuntu layouts and decide whether to add controlled read-only mounts or a prepared minimal root filesystem.
5. **Clarify the security target before multi-user exposure.** The current design is for a trusted local developer. Audit the Bubblewrap options, user/group mapping, exposed devices and host binaries before using it as a security boundary for untrusted users or a remote service.
6. **Document rootless setup and troubleshooting.** Add distro-specific Podman subordinate-ID setup only after choosing the supported host distributions. Keep this separate from the VM image preparation process.
7. **Consider a reproducible endpoint rootfs later.** The current shell uses read-only host tools and therefore inherits the host's command set and library layout. A minimal prepared filesystem or rootless container image could make the endpoint more consistent, but should preserve direct VDE attachment and ordinary-user operation.

The existing network roadmap remains in [ROADMAP.md](ROADMAP.md). Its Docker/Podman container endpoint investigation is separate from this implementation: this prototype uses `podman unshare` only to provide a rootless user namespace for Bubblewrap; it does not launch a Podman container or build an endpoint from a Dockerfile.
