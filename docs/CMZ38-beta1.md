# CMZ38 β1: session engine and system profile

This beta prepares the configuration hierarchy. `config.json` is the system catalog and source of launch defaults. Its `session.defaults.engine` sets the initial engine for each new server session; `settings.defaults` and each system's `settings` provide CPU, memory and clock defaults. The QEMU `machine` value and VirtualBox `osType` are engine-specific launch profile values. System ID, description, login hint, base image, disk bus and network model are shown read-only in Host Settings for existing hosts. During creation, the system can still be selected.

The server allocates a 16-character hexadecimal session ID independent of its PID and writes `runtime/<session-id>/session.json` atomically. `GET /api/general-settings` returns the session ID and engine; `PUT /api/general-settings` changes the engine only while no hosts exist. Direct host creation, topology loading and launch requests must match the common engine. The server rejects a change while hosts exist, so later hosts cannot silently use a different engine. The naming scheme and console font remain browser-local UI preferences. `localStorage` is no longer read or written for the engine.

## Manual review

From this worktree, run `PORT=3003 npm start` and open `http://127.0.0.1:3003`. The worktree has local symlinks to the main checkout's installed dependencies, prepared base images and `.env.local`; these are ignored by Git and do not alter the main checkout.

1. Open **General Settings**, choose **QEMU · TCG**, and close the dialog.
2. Add two hosts. In each Host Settings dialog, inspect the read-only system ID, base image, disk bus, network card, description and login hint. The creation dialog still lets you select a system. Uncheck **Autostart** if you only want to inspect configuration.
3. Reopen **General Settings** and confirm the engine remains **QEMU · TCG**. Both host dialogs must show the same engine.
4. Refresh the page and confirm the engine and both host entries remain. Inspect `runtime/<session-id>/session.json` for the engine and host IDs; the session ID is the enclosing directory name. PID and port are process details outside this JSON.
5. Try choosing another engine with hosts present. The UI must show that the hosts must be deleted first, then restore the previous selection.

Host Settings persistence, transactional OK/Cancel, per-host and switch JSON, and applying edits at the next guest start belong to β2–β4. Full restoration after a server restart remains a later roadmap stage; a new server process starts a new session. No automated unit or integration tests were run for this beta.
