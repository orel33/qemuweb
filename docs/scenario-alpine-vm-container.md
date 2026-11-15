# Scenario: Interconnecting an Alpine ARM64 VM and an Alpine Container on macOS

This document provides a step-by-step walkthrough to test and demonstrate native ARM64 virtualization with hardware acceleration (**HVF**) on Apple Silicon (M1/M2/M3/M4) macOS systems.

It validates the coexistence and network communication between:
1. A full operating system VM (**Alpine Linux 3.24 ARM64**) booted through EDK2 UEFI firmware.
2. A lightweight OCI container (**Alpine 3.20**) booted through Boot2container (b2c) direct kernel boot.
3. A local **VDE virtual switch** interconnecting them on a private subnet.

---

## Prerequisites

1. An Apple Silicon Mac (ARM64) running macOS 13 or newer.
2. Dependencies installed via Homebrew:
   ```sh
   brew install node python3 qemu vde cdrtools
   ```
3. Repository checked out with npm dependencies installed:
   ```sh
   git checkout feature/arm64-vms
   npm ci
   ```

---

## Step 1: Prepare the Images

Prepare the base images for both systems:

```sh
# 1. Download Alpine ARM64 ISO and run the automated UEFI installation
bash scripts/prepare.sh --system alpine-arm64

# 2. Download Boot2container ARM64 kernel and initramfs, and create the sparse cache disk
bash scripts/prepare.sh --system container
```

Verify that the images are created:
```sh
bash scripts/prepare.sh --list
```

---

## Step 2: Start QemuWeb

Launch the local server:
```sh
./start.sh
```

Open your browser at **<http://127.0.0.1:3002>**.

---

## Step 3: Create and Start the Virtual Switch

1. In the bottom-left toolbar, click **Add a switch**.
2. This creates switch `s1`. Click on switch `s1` in the sidebar or topology canvas, then click **Start**.

---

## Step 4: Create and Start the Alpine ARM64 VM

1. In the bottom-left toolbar, click **Add a new host**.
2. In the creation dialog, choose the system: **Alpine Linux 3.24 (ARM64)**.
3. In **Host Settings**:
   * Navigate to the **Network** tab.
   * For **Interface 0 (eth0)**, select switch **s1**.
   * Click **OK** to save.
4. Click **Start** on the host.
5. In the top-right toolbar, note the engine badge: **QEMU · HVF** (confirming hardware-accelerated execution).
6. Switch to the **Console** tab:
   * Log in as `root` (no password required).
   * Assign a static IP address to `eth0`:
     ```sh
     ifconfig eth0 192.168.0.1/24
     ```

---

## Step 5: Create and Start the Alpine Container

1. In the bottom-left toolbar, click **Add a new host**.
2. In the creation dialog, choose the system: **OCI Container (b2c)**.
3. In **Host Settings**:
   * The container image field defaults to `docker.io/library/alpine:3.20`.
   * Navigate to the **Network** tab:
     * Leave **Interface 0 (eth0)** set to **Internet (NAT)** (required on first boot so Boot2container can pull container layers from Docker Hub via transparent SLIRP DHCP).
     * Set **Interface 1 (eth1)** to switch **s1**.
   * Click **OK** to save.
4. Click **Start** on the container host.
5. Switch to the **Console** tab:
   * Watch Boot2container boot the ARM64 Linux kernel (`linux-arm64-qemu`).
   * Podman automatically pulls the native ARM64 layers of Alpine and presents an interactive `#` shell.
   * Configure the second interface `eth1` (connected to switch `s1`):
     ```sh
     ip addr add 192.168.0.2/24 dev eth1 && ip link set eth1 up
     ```

---

## Step 6: Test Network Interconnection

From the container's interactive shell, ping the Alpine VM across the VDE switch:

```sh
ping -c 3 192.168.0.1
```

From the Alpine VM's serial console, ping the container:

```sh
ping -c 3 192.168.0.2
```

Both machines communicate directly across the local VDE switch `s1` while running under native `qemu-system-aarch64` with Apple Hypervisor framework hardware acceleration.
