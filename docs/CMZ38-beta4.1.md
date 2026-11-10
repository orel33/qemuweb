# CMZ38 β4.1: Host Settings actions and tabs

Host Settings has **General**, **Hardware**, **Storage**, **Network**, **Startup** and **Expert** tabs. **Storage** shows the disk bus first, then base and working disks and the guest CD-ROM. **Network** shows the network card first, then QEMU Ethernet interfaces when available. Expert keeps the console paths and full launch commands. The dialog uses **Cancel** and **OK** in its action bar; the former top **Close** button has been removed.

The OK label reflects the selected action: **OK · Save**, **OK · Save & Reboot**, or **OK · Save & Reset disk**. Existing QEMU hosts with a launched working disk offer a one-time **Reset working disk on save** checkbox in the Storage tab, below the disk details. It is hidden for new hosts and VirtualBox. Selecting Reset clears and disables the Reboot checkbox. Before any host configuration is saved or disk is reset, a confirmation warns that the current guest files and changes will be lost. Canceling that confirmation leaves the Host Settings draft open and the disk untouched. The reset choice is not part of `host.json`.

## Manual review

These steps are for the user after integration; no unit, integration or browser tests were run by Codex.

1. Open a new QEMU host's settings. Confirm there is no top Close button or Reset checkbox. Check the tab order and the first rows of Storage and Network. Press Cancel; no host should be created.
2. Create and start a QEMU host, then create a file inside the guest. Open Host Settings, edit a setting and check **Reboot now to apply**. Confirm the OK label changes to **OK · Save & Reboot**.
3. In Storage, check **Reset working disk on save** below the disk details. Confirm Reboot clears and becomes unavailable, the OK label changes to **OK · Save & Reset disk**, and the warning mentions deletion of guest changes. Press OK, then cancel the confirmation. Reopen or inspect the running guest: the file and saved configuration should remain unchanged.
4. Press OK again and confirm. The edited settings should be saved, the guest should restart from its base image, and the file should be gone. Inspect `host.json`: it contains the settings but no reset flag.
5. Open a VirtualBox host's settings. Confirm Storage and Network show their fixed profile values, but the Reset checkbox is absent. Confirm ordinary Save and optional Save & Reboot still work.

If the save succeeds but the subsequent reboot or reset fails, Host Settings stays open and reports that the settings were saved. The host may be stopped if the failure occurred after shutdown. Use Play after correcting the cause.
