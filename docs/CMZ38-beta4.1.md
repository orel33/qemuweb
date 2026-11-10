# CMZ38 β4.1: Host Settings actions and tabs

Host Settings has **General**, **Hardware**, **Storage**, **Network**, **Startup** and **Expert** tabs. **Storage** shows the disk bus first, then base and working disks. **Startup** shows the guest CD-ROM ISO path. **Network** shows the network card first, then QEMU Ethernet interfaces when available. Expert keeps the console paths and full launch commands. The dialog uses **Cancel** and **OK** in its action bar; the former top **Close** button has been removed.

The action bar uses **Cancel** and **OK**. **Start automatically** starts a newly created host; **Restart automatically** restarts an existing running host after OK. A red cross at the right of **Working disk (QCOW2 overlay)** selects **Reset working disk at restart** for previously launched QEMU hosts. Its pressed state forces **Restart automatically** on and prevents unchecking it until reset is deselected. A confirmation warns about lost guest changes before any settings are saved. After OK, the working disk is deleted and the host starts from its base image. The reset choice is not persisted in `host.json`; the cross is absent for new hosts and VirtualBox.

## Manual review

These steps are for the user after integration; no unit, integration or browser tests were run by Codex.

1. Open a new QEMU host's settings. Confirm there is no top Close button or reset cross. Check the tab order and the first rows of Storage and Network. Press Cancel; no host should be created.
2. Create and start a QEMU host, then create a file inside the guest. Open Host Settings, edit a setting and check **Restart automatically**. Confirm the OK label remains **OK**.
3. In Storage, press the red cross beside **Working disk (QCOW2 overlay)**. Confirm it shows a pressed state and **Restart automatically** becomes checked and locked. Press OK, then cancel the confirmation. The file and saved configuration should remain unchanged.
4. Press OK again and confirm. The host should restart from its base image and the file should be gone. Reopen Host Settings and confirm the cross is unpressed; `host.json` should contain the saved settings but no reset flag.
5. Open a VirtualBox host's settings. Confirm Storage and Network show their fixed profile values, but the reset cross is absent. Confirm ordinary OK and optional **Restart automatically** still work.

If the save succeeds but the subsequent reboot or reset fails, Host Settings stays open and reports that the settings were saved. The host may be stopped if the failure occurred after shutdown. Use Play after correcting the cause.
