# From QemuNet to Qemuweb

QemuNet starts a network of QEMU virtual machines from a topology file. Its traditional text interface opens an xterm window for each machine. Qemuweb explores the same kind of interactive serial console in a browser, using xterm.js and a Node.js server. The current Qemuweb demo can run multiple independent VMs, but does not yet reproduce QemuNet's topology-driven VDE LAN.

The proposed implementation sequence is in the [migration roadmap](ROADMAP.md).

## How QemuNet starts a LAN

The example in [qemunet-lan.txt](qemunet-lan.txt) was started with:

```sh
./qemunet.sh -x -t demo/lan.topo
```

It checks the host and QEMU capabilities, loads `qemunet.cfg`, and creates a temporary session directory and a `~/qemunet-session` link to it. The session includes the topology, switch sockets, VM disks, shared directories and PID files. The session stays active until interrupted.

The example then starts the VDE switch `s1` and creates a separate QCOW2 overlay for each VM, backed by the same Debian 10 RAW image. It connects `immortal`, `opeth`, `syl` and `grave` to ports 1 through 4 of `s1`, respectively. Each QEMU process gets an e1000 network card with its own MAC address. The switch connects the virtual Ethernet interfaces; guest IP configuration is a separate concern.

Each VM also receives a host directory through virtio-9p. QemuNet launches QEMU in an xterm window, with KVM and 200 MiB of RAM in this example. It supplies the Linux kernel and initrd directly and passes kernel arguments including `root=/dev/sda1`, `net.ifnames=0`, `console=ttyS0` and `console=tty0`. The full commands and example paths are in the startup trace.

## From xterm to xterm.js

In QemuNet, `xterm -e qemu-system-x86_64 … -nographic` runs QEMU inside the terminal. With no explicit `-serial`, `-nographic` connects QEMU's first serial port and its monitor to standard input and output. The kernel's `console=ttyS0` sends console output to that serial port; a guest `getty` on `ttyS0` provides the login prompt. The QEMU monitor is distinct from the guest shell and can be selected with `Ctrl+A`, then `C`.

Qemuweb keeps the guest serial console but changes its host-side connection:

```text
guest ttyS0 <-> QEMU serial Unix socket <-> Node.js server <-> Socket.IO <-> xterm.js in browser
```

The browser sends keystrokes through the server to QEMU; serial output travels back to the terminal. QEMU uses `-display none` to hide video and an explicit `-serial unix:…,server=on,wait=off` to expose the serial port. A separate Unix socket exposes the QEMU monitor to the web interface. QEMU listens on these sockets, and the server connects; `wait=off` lets the VM boot without waiting for a client. The guest still needs serial-console and login configuration: hiding video alone does not provide either.

## Comparison and migration

| Area | QemuNet LAN example | Qemuweb demo today |
|---|---|---|
| Session | A topology file defines a LAN and starts its switches and VMs together. | The user starts VMs individually in browser tabs; no topology-driven LAN. |
| Console | One local xterm per VM; `-nographic` connects serial and monitor to its terminal. | One xterm.js terminal per tab; serial and monitor use separate Unix sockets. |
| Network | VDE switch, explicit port and e1000 MAC address for each VM. | QEMU user networking is restricted by default; OpenWrt has networking disabled. No VDE LAN is assembled. |
| Disk | Per-VM QCOW2 overlay backed by a shared RAW image. | Per-VM QCOW2 overlay backed by a prepared RAW image. Reset or closing the tab discards the overlay. |
| Boot | Host supplies kernel, initrd and kernel arguments directly. | Prepared images boot from disk; serial access is configured in the images. |
| Other resources | Per-VM virtio-9p host share and QEMU PID file. | Node tracks the VM process; the demo does not set up the QemuNet 9p share. |

The web console therefore replaces the local terminal connection, not the QEMU guest or its serial port. Migrating a full QemuNet LAN also requires bringing topology parsing, switch creation and port/MAC assignment, per-VM shares and coordinated session lifecycle into the web workflow. The current demo already demonstrates per-VM disks, process management and browser consoles; it should not be assumed to provide those LAN features yet.

See the [README](../README.md) for Qemuweb setup, supported images and VM lifecycle controls. The comparison above describes the QEMU backend; Qemuweb also supports VirtualBox.
