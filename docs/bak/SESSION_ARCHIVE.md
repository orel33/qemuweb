# Session archives

**Save session** downloads `qemuweb-session-v2.zip`. The ZIP mirrors the durable files in `runtime/<session>/` at their existing relative paths:

```text
session.json
h-<id>/host.json
h-<id>/startup/start.sh
h-<id>/startup/<resource>       (if present)
h-<id>/disk.qcow2                (only with Include working disks)
s-<id>/switch.json
```

There is no separate manifest. `session.json` lists the engine, host and switch IDs, and base-image identities needed to check compatibility on load. Each host and switch keeps its configuration in its own JSON file. Generated startup ISOs, sockets, PIDs, symlinks, logs, console output and absolute runtime paths are excluded. They are recreated as needed. Graphic positions are not saved; the graph uses its initial layout after loading.

Without working disks, loading restores configuration, startup files and cabling; starting a host creates a fresh working disk from its configured base image. Checking **Include working disks** stops every host and then every switch before saving. If an instance cannot stop, the save aborts and those already stopped remain stopped. Starting a restored host with an archived QCOW2 overlay resumes that disk. Running RAM and process state are never saved. VirtualBox working disks are not supported.

After choosing a ZIP, the **Load session** dialog offers **Start/resume hosts and switches automatically**, checked by default. The loading indicator remains visible while the ZIP is uploaded, verified, restored and its instances are started. Switches start before hosts. Uncheck the option to leave all restored instances **Stopped**; Play then starts a fresh host or Resume uses an included working disk. If an instance cannot start, the import remains available and the dialog lists the startup errors before reloading the page.

**Load session ZIP** requires an empty session. Import validates ZIP CRCs, safe paths, IDs, names, settings, machine profiles, Ethernet connections, ports, MACs, startup files, available disk space and base-image SHA-256 hashes before adding hosts or switches. QCOW2 overlays must pass `qemu-img info` and `qemu-img check`; their backing reference is changed to the verified local RAW base during staging. Invalid or incompatible archives leave the current session empty.

Working disks are streamed through Deflate so sparse zero ranges compress. Import writes only nonzero QCOW2 blocks and truncates to the logical length to recreate sparse holes. ZIP64 entry sizes allow a logical QCOW2 file over 4 GiB; the ZIP itself is limited to 4 GiB. Each QCOW2 logical file is limited to 64 GiB and total uncompressed contents to 256 GiB. Unsupported ZIP features, symlinks and unsafe paths are rejected. Browsers with the File System Access save picker stream the download; other browsers buffer the ZIP as a Blob.

## Validation

The user validated Web save/load with a LAN containing four hosts from different systems. Startup files and ping worked after a configuration-only import. A second save/load with **Include working disks** preserved guest files, including on Alpine. This completes the accepted RSD68 Web workflow. Corrupt-ZIP and incompatible-base rejection were not exercised in this manual run; the archive unit checks have not been run by Codex. VirtualBox disk export/import requires separate work.
