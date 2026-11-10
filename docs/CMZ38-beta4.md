# CMZ38 β4: VirtualBox and configuration review

The final review checks the shared Host Settings flow for VirtualBox. While a VirtualBox VM runs, **OK** saves CPU, memory, hardware clock and startup script/CD-ROM settings in its `host.json`; **Restart pending** marks changes to the active VM. Play, Reboot and Reset use the saved values. Play and Reboot keep the differential VDI, while Reset creates a new one. VirtualBox exposes no VDE interfaces. The Expert preview now includes removal of the previous startup CD-ROM before attaching the newly generated one.

`config.json` keeps editable memory, processor count and hardware clock under `settings.defaults` or `systems.<id>.settings`. QEMU profile objects contain fixed hardware choices; the server rejects `memory`, `smp` or `rtcBase` under `qemu.defaults` and `systems.<id>.qemu`, since those would be overridden by `settings`. Restart and Reset validate image files, engine availability and desired switch connections before stopping the guest. Reset validates supplied launch settings before marking the host busy.

## Suggested manual review

After the orchestrator integrates this beta, start the Web server with `PORT=3003 npm start` and select **VirtualBox** in General Settings before creating hosts. These steps have not been run by Codex.

1. Create a VirtualBox host with **Start automatically** unchecked. Confirm the Network tab offers no VDE interface controls. Set CPU, RAM, clock and a startup script/CD-ROM; press **OK** and then Play. Check the Expert command preview and the guest startup behavior.
2. While it runs, change all four settings and press **OK** without **Reboot now to apply**. Confirm **Restart pending** appears, the guest keeps its active values, and the saved values survive a browser refresh. Stop then Play; confirm the pending badge clears and the differential VDI keeps a file created before the stop.
3. Edit the startup script again and check **Reboot now to apply**. Confirm the VM restarts with the saved settings, keeps the working file, and the badge clears. Disable the startup CD-ROM, then Reboot; confirm it is detached. Re-enable it with a changed script and Reboot; confirm the new ISO is attached.
4. Save another change and use Reset. Confirm the saved settings apply and the working file disappears because Reset replaces the differential VDI.

If the user authorizes automated tests, the available project command is `npm test`. No unit or integration tests were run for this beta. VirtualBox guest behavior and command execution still need manual validation; static review alone cannot confirm the installed VBoxManage version or guest boot behavior. Full restoration after restarting the Web server remains a later roadmap stage.
