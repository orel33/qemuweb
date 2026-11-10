# CMZ38 β4.1: Host Settings actions and tabs

Host Settings has **General**, **Hardware**, **Storage**, **Network**, **Startup** and **Expert** tabs. **Storage** shows the disk bus first, then base and working disks. **Startup** shows the guest CD-ROM ISO path. **Network** shows the network card first, then QEMU Ethernet interfaces when available. Expert keeps the console paths and full launch commands. The dialog uses **Cancel** and **OK** in its action bar; the former top **Close** button has been removed.

The action bar uses **Cancel** and **OK**. The Host Settings dialog keeps the same height across tabs; single-purpose dialogs retain their content height. **Start automatically** starts a newly created host; **Restart automatically** restarts an existing running host after OK. When launch settings have changed and automatic restart is unchecked, OK asks whether to restart now, save for later, or cancel. The **Reset working disk at restart** checkbox appears on a separate line below **Working disk (QCOW2 overlay)** for previously launched QEMU hosts. It does not change **Restart automatically**. The reset is saved in `host.json`; the next Play or Reboot discards the working disk and starts from its base image, then clears the flag. The checkbox is absent for new hosts and VirtualBox. Startup places **Load file** above the `start.sh` editor.

## Manual review

These steps are for the user after integration; no unit, integration or browser tests were run by Codex.

1. Open a new QEMU host's settings. Confirm there is no top Close button or reset checkbox. Check the tab order and the first rows of Storage and Network. Press Cancel; no host should be created.
2. Create and start a QEMU host, then create a file inside the guest. Open Host Settings, edit a setting and leave **Restart automatically** unchecked. Press OK, then **Cancel** in the restart choice: the draft should stay open and unsaved. Press OK again and choose **Later**: the settings should be saved without restarting.
3. Reopen Host Settings. In Storage, check **Reset working disk at restart** on the line below the disk path. Confirm **Restart automatically** remains unchecked. Press OK, then **Cancel** in the restart choice; the file and saved configuration should remain unchanged.
4. Press OK again and choose **Later**. The guest file should still exist. Reopen Host Settings and confirm the reset checkbox remains checked; `host.json` should contain `resetWorkingDiskAtRestart: true`.
5. Use Play or Reboot. The host should start from its base image and the file should be gone. Reopen Host Settings and confirm the reset checkbox is unchecked; `host.json` should contain `resetWorkingDiskAtRestart: false`.
6. Open a VirtualBox host's settings. Confirm Storage and Network show their fixed profile values, but the reset checkbox is absent. Confirm ordinary OK and optional **Restart automatically** still work.

If the save succeeds but the subsequent reboot or reset fails, Host Settings stays open and reports that the settings were saved. The host may be stopped if the failure occurred after shutdown. Use Play after correcting the cause.
