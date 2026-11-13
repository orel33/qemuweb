# CMZ38 β3: pending settings for running hosts

Host Settings can save CPU, memory, hardware clock, startup script/resources and QEMU interfaces while a host runs. **OK** writes the desired configuration to that host's `host.json`. The running guest keeps the configuration it started with; the tab shows **Restart pending** until the next Play, Reboot or Reset applies it. **Reboot now to apply** appears for a running host and performs the reboot after the save. Cancel still discards the dialog draft.

The server keeps a separate in-memory snapshot of each running host's effective settings and interfaces. It protects a VDE switch used by a running host even if that host's desired interface has changed to another switch. Unchanged QEMU interfaces keep their MAC addresses and VDE ports. Reboot uses the existing working disk; Reset starts from the base image and discards the working disk as usual. VirtualBox has no VDE interface controls, but its resource and startup settings follow the same save and apply flow.

## Manual review

Start the Web server from this worktree and open the page. Use two QEMU hosts and two VDE switches, with both switches started. Automated unit and integration tests were not run for this beta.

1. Connect both hosts to the first switch and start them. Note each host's Ethernet MAC and switch port in Host Settings. In the first guest, create a file on its working disk.
2. While the first host runs, edit its CPU, memory, clock, startup script and Ethernet 1 to use the second switch. Leave **Reboot now to apply** unchecked and press **OK**. Confirm the saved values appear after reopening Host Settings and after refreshing the page. Confirm **Restart pending** appears. The active guest still uses its previous resources and first switch. Confirm stopping or deleting the first switch is refused while that connection is active.
3. Reboot the first host. Confirm **Restart pending** clears, the edited configuration applies, and the file created in step 1 remains. Confirm the unchanged second host keeps its MAC and port. The first switch can now stop if no other active or desired host refers to it.
4. Edit an active host again, check **Reboot now to apply**, and press **OK**. Confirm the dialog closes after the reboot and the pending indicator clears. For a stopped host, save an edit and use Play to apply it. Confirm Reset also applies saved settings while intentionally discarding the working disk.
5. With VirtualBox selected in General Settings, confirm Host Settings offers resource and startup edits while a VM runs and does not offer VDE interface editing. Verify the saved edits apply at its next start or reboot.

If reboot fails after **OK**, the saved desired configuration remains in `host.json` and the dialog reports the reboot error. The host may be stopped if failure occurs after graceful shutdown; use Play after correcting the cause. Full restoration after restarting the Web server remains a later roadmap stage.
