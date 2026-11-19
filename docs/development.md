# Development

Code layout, tests and documentation. The data paths between the browser, the server, QEMU and VDE are in
[architecture](architecture.md); the JSON files in [json-files](json-files.md).

| Path | Role |
| --- | --- |
| `server/` | The server (control plane), `node server/main.js`, symmetric to `runner/`: startup (a runner dials in, see `scripts/start.sh`) in `main.js`, session manager (one session per user), runner client, registry, runner gateway, server instance records, audit logs. |
| `server/routes/` | HTTP API of one session (`server/routes/index.js` builds one router per session), by area: settings, nodes, hosts, topology, archives, metrics. Each route sends one command to the session's runner. |
| `server/sockets.js` | Socket.IO consoles; forwards each runner's events to the browsers of its session only. |
| `runner/` | The runner, a separate process (`runner/main.js`) serving every session of the machine over the runner protocol: QEMU, VirtualBox, VDE switches, consoles, startup media, archives, metrics. |
| `server/auth/` | Authentication: users file, password hashes, signed cookie. |
| `scripts/user.sh`, `scripts/user.js` | User account administration. |
| `scripts/demo.sh`, `scripts/demo.js` | Web demo with test accounts and `demo/lan.zip`. |
| `common/` | Code shared by the runner and the server: runner protocol framing, IDs, launch settings, `config.json` validation, `.topo` parsing. |
| `public/` | Web interface: `index.html`, `css/app.css`, ES modules started by `app.js`, xterm.js terminals, network graph. |
| `scripts/prepare/` | One image preparation script per system. |
| `demo/` | Example sessions (`.zip`) and topologies (`.topo`): LAN, DMZ and gateway. |

See [docs/architecture.md](architecture.md) for the data paths between the
browser, the server, and QEMU, VirtualBox, and VDE.

Tests:

```sh
npm test                          # unit tests only
./scripts/run-tests.sh --list     # unit and integration scenarios
```

Integration tests log in with a temporary users file; most need prepared
images, QEMU with VDE, and usually KVM. See
[test/tests.md](../test/tests.md) for each scenario and its prerequisites.

## Documentation

The documents are Markdown files: the `README.md` (overview and demo), every `docs/*.md` (`install.md`, `user-guide.md`, `reference.md`,
`deployment.md`, `architecture.md`, `json-files.md`, `development.md`, `roadmap.md`, the test sheet `remote-runner-test.md`), `deploy/cremi/deploy-cremi.md` and
`test/tests.md`. Their PDF versions are in `docs/pdf/`, built by
`make docs` with one style (`docs/doc.css`: dark text on white, light grey code blocks and tables, nothing
that prints badly on a black and white printer; `docs/doc.lua` turns a block quote that starts with
**Expect:**, **Note:** or **Warning:** into a boxed callout). The diagrams are SVG files in
`docs/img/` (`architecture.svg`, `remote-runner.svg`), referenced from the Markdown with
`![description](img/name.svg)`; keep them simple, with few arrows and dark strokes on white or light
grey. Building needs `pandoc` and `google-chrome` (or `chromium`) in `PATH`: `sudo apt install pandoc`.
Rebuild and commit the PDFs when a document changes.
