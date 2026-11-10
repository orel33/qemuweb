# CMZ38 β2: transactional Host Settings and session files

β2 saves a full host configuration when **OK** is pressed. **Cancel**, Escape and Close discard the dialog draft. Creation also commits only on **OK**. The server validates the complete configuration and writes `host.json` atomically; CPU, memory, clock and startup media no longer inherit values from another host of the same system through browser `localStorage`. A browser refresh reloads host settings from the server.

`runtime/<session-id>/session.json` records the common engine plus `hosts` and `switches` arrays containing stable internal IDs and relative JSON paths. Each referenced `h-<hash>/host.json` contains the host name, system ID, engine, resource settings, network interface switch IDs and assigned ports/MACs, startup script/resources, and auto-build setting. Each referenced `s-<hash>/switch.json` contains the switch ID and name. These JSON writes use a temporary file and atomic rename in the same directory. Generated sockets, ISO paths and overlay paths are not user settings in these JSON files.

## Manual review

Stop any earlier β1 server, then from this worktree run `PORT=3003 npm start` and open `http://127.0.0.1:3003`. Local ignored symlinks provide the main checkout's installed dependencies, prepared base images and `.env.local`. The server prints its session directory at startup.

1. Add a switch with **Start automatically** unchecked. Add two hosts of the same system with **Start automatically** unchecked. In each host's Network tab, choose the switch for Ethernet 1 and press **OK**. A stopped switch is selectable for configuration; start it before starting a connected host.
2. Open the first host's **Host Settings**. Change its name, memory, processors and `start.sh`, then press **Cancel**. Reopen it and confirm every value is unchanged. Repeat with a network selection if desired.
3. Change those first-host values again and press **OK**. Refresh the page. Confirm the first host keeps them and the second host keeps its own values.
4. Add a third host of the same system, with Autostart unchecked. Confirm it receives the system defaults rather than the first host's edited memory, processors or script.
5. Open the printed session directory. Inspect `session.json`: it must list three host IDs and one switch ID, each with a relative path. Open those paths. Each host must have its own `host.json`; the switch must have `switch.json`. Confirm the first host's saved values and switch reference differ only where edited, and that the files use the IDs listed in `session.json`.

This beta keeps CPU, memory and clock editing locked while a host runs, and NIC editing locked after its first launch. A stopped host can save resource changes for its next Play. β3 adds pending edits for running hosts and the option to reboot immediately to apply them. Full restoration after restarting the Web server remains a later roadmap stage. No automated unit or integration tests were run for this beta.
