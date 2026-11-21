# Runner model: the local runner becomes a runner like the others (RUN03, design study)

Status: **DRAFT for the user's decision**. No code changes with this document. Roadmap: RUN03 (milestone 7), then PST01.
Beta rules (`AGENTS.md`): no legacy reader, no compatibility path; an old runtime directory is not used, the user deletes it by hand.
Linked from [architecture.md](architecture.md#runner-model-run03-design-study).

Terms: **server** = control plane (`server/`), **runner** = `runner/`. "Local runner" = the one on the Unix socket today
(id `local`). "Remote runner" = registered with a token (`r-xxxxxxxx`, `runners.json`), over WebSocket.

## 1. Inventory: local runner vs remote runner today

Disposition: **keep** (stays as is, for every runner), **move** (becomes a runner command or runner-side rule), **drop** (removed).

### 1.1 Differences

| # | Topic | Local runner today | Remote runner today | Evidence | Disposition |
|---|---|---|---|---|---|
| 1 | Transport | Unix socket `<runtime>/runner-<port>.sock`, mode 0600 (umask 0177 + chmod), created by the server, stale socket removed or live one refused | WebSocket `/runner/connect`, `ws` duplex under the same `Connection` | `server/runner-gateway.js:20,24-35,46-56`; `server/remote-gateway.js:141-151` | **keep** both transports, one protocol (already shared) |
| 2 | Identity | Fixed id `local`; no credential: whoever opens the 0600 socket is "the server's user"; one connection at a time, a second is destroyed | Registered id `r-xxxxxxxx`, `Authorization: Bearer` checked against `tokenHash` (constant time), 401 unknown/revoked, 409 already connected | `runner-gateway.js:38-40`; `remote-gateway.js:146-149`; `runner-store.js:244-249` | **move** to one registered identity (rule R3) |
| 3 | `trusted` | `true`, set by the gateway | `false` always | `runner-gateway.js:39`; `runner-registry.js:39` | **drop** as a flag (rule R4) |
| 4 | `local` | `true`, set by the gateway | `false` always | `runner-gateway.js:39`; `runner-registry.js:39` | **drop** as a behaviour switch; keep a display field `transport` |
| 5 | Registry record | None: not in `runners.json`, no name, `registeredAt` 0 | Record with name, `createdAt`, `lastSeenAt`, `paused`, `revoked` | `runner-registry.js:39`; `runner-store.js:174` | **move**: one record for every runner |
| 6 | Paused state | In memory only (lost at a server restart); `id !== 'local'` skips the store | In `runners.json` (`paused`) | `routes/admin-runners.js:99-103`; `remote-gateway.js:44` | **move** (persisted for all) |
| 7 | Revoke / remove | Refused (403) | Allowed | `routes/admin-runners.js:112,124` | **move**: same rules (a revoked local runner is refused at the socket) |
| 8 | `hello.runtimeRoot` | Kept by the registry for `local` only, compared with the server's `runtime/` | Ignored (`runtimeRoot` always null) | `runner-registry.js:46`; `session-manager.js:79` | **drop** as a decision input; keep only as display text, bounded |
| 9 | Placement tie-break | Tie goes to `local` first, then earliest `registeredAt` | by `registeredAt` | `runner-registry.js:99` | **drop** the `local` term (local gets `registeredAt` from its record) |
| 10 | Adoption after a server restart | Sessions of the hello are adopted for `hello.sessions[].owner` (from the runner's `meta.json`) when `entry.trusted` | Never: unknown sessions are `session.delete`d, so a server restart kills the VMs of a remote runner | `session-manager.js:193-211`; `runner/service.js:155-162` | **move** to a persisted server-side binding for every runner (rule R6) |
| 11 | Loss of the runner | Sessions dropped at once; the server `rmSync`s each session dir when it shares `runtime/` | Kept for `--runner-grace`, then dropped; the runner deletes unknown sessions when it returns | `session-manager.js:87-100,175-184` | **move** (one rule: grace for all; removal by the runner, R7) |
| 12 | Forced loss by the administrator | None | None (PST01 item) | roadmap PST01 | **keep as a PST01 item**; the design gives it one place (R7) |
| 13 | Alias `users/<login>` | Created at `open`/`adopt`, removed at `forget`; all removed at server exit; dangling ones pruned at start | Never | `session-manager.js:213-261`; `serve.js:148,159` | **move** to the runner (R8) |
| 14 | Pruning of empty `sessions/<id>` | At each hello of a runner sharing `runtime/`, sparing the hello's sessions and those of other live servers' `.session` records | Never (runner does `removeIfEmpty` at its own shutdown only) | `serve.js:55-57`; `server-instance.js:46-91`; `runner/session.js:50-69` | **move** to the runner start-up (R9) |
| 15 | Server records in the shared directory | `server-<port>.pid`, `server-<port>.session` (kind + live session IDs, read by other servers) | n/a | `server-instance.js:19-35` | **keep** `.pid`; **drop** the session list (its only reader is the pruning); the files stay in the server's own directory |
| 16 | `sessions/` directory at exit | Server `rmdir`s `<runtime>/sessions` when empty; runner does the same | Runner only | `serve.js:157-163`; `runner/main.js:80-81` | **drop** on the server side |
| 17 | `Session.runtimeDir` in the server | Computed `<runtime>/sessions/<id>` for rmSync and aliases | n/a (never used) | `server/session.js:24-25` | **drop** |
| 18 | Start-up message / hint | "Runner disconnected. Start one with ./scripts/runner.sh"; `connectHint` adds `--runtime` of the server | "Runner <name> (<id>) disconnected" + `lastSeenAt` written | `serve.js:51,59-65,152`; `routes/admin-runners.js:45-49` | **keep**, one message form for all |
| 19 | Default runtime directory | `/tmp/qw-<login>/<port>`, **shared** with the server | `/tmp/qw-<login>/runner` (not unique per runner), or `runtime` of `runner.json` | `common/runtime-dir.js:7-9`; `runner/options.js:70-74`; `runner/main.js:36` | **move**: one directory per runner (R2) |
| 20 | Runner option to find the server | `--port PORT` => `<runtime>/runner-PORT.sock` **inside its own runtime** (needs the shared directory), or `--connect SOCKET` | `--url` + runner file | `runner/options.js:60-63,129-132` | **move**: `--connect` / `--port` resolve the server's directory, not the runner's |
| 21 | `--exit-on-disconnect` | Used by `start.sh`: stop every machine and exit when the connection drops | Forbidden | `runner/main.js:101-111`; `scripts/start.sh:108` | **keep** (a launcher choice, not trust) |
| 22 | Reconnect | Every 2 s | 2 s doubling to 30 s, heartbeat ping 15 s | `runner/options.js:18`; `runner/remote.js` | **keep** (transport detail); unify the backoff later |
| 23 | Address shown in `/admin` | `null` | Remote address (bounded text) | `runner-registry.js:40`; `remote-gateway.js:122-125` | **keep** (`unix` for the socket) |

### 1.2 Every place where the server reads or writes a path that belongs to a runner

| File:line | Access | What | Disposition |
|---|---|---|---|
| `server/session-manager.js:182` | `fs.rmSync(session.runtimeDir, recursive)` | session dir of a lost local runner | **move** to runner start-up pruning + `session.delete` on return |
| `server/session-manager.js:220-225` | mkdir `users/`, symlink, rename | alias creation | **move** to the runner |
| `server/session-manager.js:232-234` | readlink, unlink, rmdir | alias removal at `forget` | **move** |
| `server/session-manager.js:241-246` | readdir, lstat, unlink, rmdir | all aliases at server exit | **drop** (runner manages its own) |
| `server/session-manager.js:253-260` | readdir, lstat, exists, unlink | dangling aliases at start | **move** (runner prunes at start) |
| `server/server-instance.js:71-89` | readdir, lstat, read `session.json`, unlink `meta.json`, `session.json`, rmdir | empty-session pruning | **move** (logic reused in the runner) |
| `server/serve.js:161` | `rmdirSync(<runtime>/sessions)` | exit tidy | **drop** |
| `server/server-instance.js:49-58` | readdir of the shared dir, read other servers' `.session` / `.pid` | live-server protection of the pruning | **drop** with the pruning |
| `server/runner-gateway.js:33,57` | unlink the socket | the server's own socket: stays (it lives in the **server's** directory) | **keep** |
| `server/server-instance.js:26-44` | write/remove `server-<port>.pid`, `.session` | the server's own records | **keep** (own directory) |
| `server/session.js:25` | path computation only | `runtimeDir` | **drop** |
| `scripts/status.js:188,203-214` | read `meta.json`, `users/<login>` links, `host.json`, `switch.json` (read-only admin tool, not the server) | owner and age of sessions | **keep** reading, but from the runner's directory (owner is in `meta.json`) |
| `scripts/stop.sh:30-43,64-65` | rm `server-<port>.pid`, `.session`, `runner-<port>.sock` | stop | **keep**, own directory |
| `server/audit.js:20`, `server/runner-store.js:62` | logs dir, `runners.json` | server's own data | **keep** |

Nothing else under the runtime directory is read or written by `server/` (grep of `runtime`, `usersDir`, `userAliasPath`, `sharesRuntime`, `runtimeDir`).

### 1.3 Every place where `trusted` / `local` changes behaviour

| File:line | Behaviour | Disposition |
|---|---|---|
| `session-manager.js:79` | `sharesRuntime`: `local && runtimeRoot === server runtime` gates all file access | **drop** |
| `session-manager.js:89` | a lost local runner drops its sessions at once, ignoring `--runner-grace` | **drop** (one rule) |
| `session-manager.js:205` | adoption only if `entry.trusted` | **drop**: replaced by the binding (R6) |
| `runner-registry.js:46` | `runtimeRoot` of the hello only kept for `local` | **drop** |
| `runner-registry.js:99` | tie-break prefers `local` | **drop** |
| `serve.js:51,57,60` | log label; prune at hello if shared; "Start one with runner.sh" message | **keep** the messages, **drop** the prune |
| `routes/admin-runners.js:25,38-39,46,99-102,112,124` | `local` flag in the summary, listed only while connected, `connectHint`, cannot be paused through the store, cannot be revoked or removed | **move**: same summary and rules for all, `transport` field; `connectHint` stays while no runner is online |
| `remote-gateway.js:10` | comment: remote is never trusted/local | **keep** the rule as "nobody is trusted by transport" |

### 1.4 Start-up, shutdown, scripts, units, tests

| Item | Dependency on the shared directory | Evidence | Disposition |
|---|---|---|---|
| `scripts/start.sh` | runs server and runner with the same `--runtime`, waits for `<runtime>/runner-<port>.sock`, gives the runner `--port` and `--runtime` | `start.sh:49-56,100-108` | **move**: runner gets its own directory and `--connect <server dir>/runner-<port>.sock` |
| `scripts/stop.sh` | reads server records in `<runtime>`; finds the runner by `--port` in its command line and says "its VMs keep running" | `stop.sh:30-31,69-80` | **keep**, tell about the runner directory |
| `scripts/status.sh` / `status.js` | pairs a runner with a server when `dialledRuntime(runner)` equals the server's runtime; reads aliases for the login | `status.js:203-214,317,334,340`; `status-vbox.js:33-47` | **move**: pair by the dialled socket; login from `meta.json` |
| `scripts/killall.sh`, `cleanall.sh` | clean `/tmp/qw-<login>/` as a whole (all default directories of the account) | `killall.sh:3`, `cleanall.sh:5-30` | **keep** (the account root already contains every default directory) |
| `scripts/demo.sh` | one temporary `runtime` for server and runner | `demo.sh:175-176` | **move**: two subdirectories of `$demo_dir` |
| `scripts/lib/runtime.sh` | `default_runtime PORT\|runner` | `lib/runtime.sh:4-12` | **move**: one more kind of name (R2) |
| `deploy/cremi/qemuweb-runner.service` | `--port 3002 --runtime /var/lib/qemuweb` = the server's directory | unit line 8 | **move**: own directory + `--connect` |
| `deploy/cremi/qemuweb-server.service` | `--runtime /var/lib/qemuweb` | unit line 8 | **move**: `/var/lib/qemuweb/server` |
| `deploy/cremi/qwctl.sh`, `deploy-cremi.md` | text only ("same `--runtime` for both", 49 chars) | `deploy-cremi.md:355` | **move** (documentation) |
| `common/runtime-dir.js` | `defaultRuntime(name)`, the comment says "server and local runner"; budget computed from `sessions/<16>/s-<16>/serial1.sock` (max 49 bytes) | `runtime-dir.js:1-20,98-106` | **move**: server needs no node-socket budget, runner does (R2) |
| Integration `check-runner.js` | asserts `<runtime>/sessions/<id>` of the server's port, the socket in the same directory | `check-runner.js:96-98,127,140,167,178` | **rewrite** |
| `check-runner-manual.js` | already uses a separate runner runtime and asserts "no alias: the runner does not share runtime/" (`:146-148,183`) | `check-runner-manual.js:83,146-148,183` | **rewrite** (becomes the standard case; asserts change) |
| `check-load-start.js`, `admin.js` | find a session's processes by `<runtimeDir>/sessions/<id>` of the default runtime | `check-load-start.js:83,197`; `admin.js:76` | **rewrite** (runner directory helper) |
| `check-runner-remote.js` | uses its own runner directory already | `:120,171` | **keep**, extend (restart adoption) |
| Unit `session-manager.test.js` | aliases, `sharesRuntime`, pruning, rmSync (13 alias hits, 38 runtime hits) | file | **rewrite** |
| Unit `runtime-restart.test.js` | `ServerInstance` live sessions + pruning | file | **rewrite** (pruning moves to the runner) |
| Unit `runner-gateway.test.js` | registers `local` as `trusted`/`local` | 2 + 9 hits | **rewrite** |
| Unit `session-adoption.test.js`, `remote-sessions.test.js`, `admin-runners.test.js`, `server-startup-report.test.js`, `runtime-dir.test.js`, `status-vbox.test.js` | trusted adoption, grace, local summary, startup lines, the default directory, the runner/server pairing | files | **rewrite or extend** (details in section 3) |

Observation: `check-runner-manual.js` already tests the case "runner has its own runtime directory, the server touches nothing". Today that case
**silently loses** the `users/` aliases, the empty-session pruning and the server-side directory removal, but still adopts: it is the
design of this study, minus the identity and the binding.

## 2. Options and recommendation

### 2.1 The options

| | A: formalise the shared directory | B: Unix socket, own directory, registered identity (**recommended**) | C: the local runner uses the WebSocket path |
|---|---|---|---|
| Idea | Keep one directory per port for both; write the contract (what the server may touch) as a protocol-less file convention | Same Unix socket, but the runner has its own directory; it is a registered runner (record in `runners.json`, persisted state); sessions are bound to runners in a server-side file; the server writes nothing in the runner's directory | The local runner dials `ws://127.0.0.1:<port>/runner/connect` with a token, exactly like a remote one; the Unix socket and its gateway are deleted |
| What changes | Little: document `trusted`/`local`; add a lock file | Gateway (identity), registry (drop `local`/`trusted`), session manager (binding, adoption, no `fs`), `ServerInstance` (no pruning), runner (alias, pruning, own directory), `runner/options.js`, scripts, units, tests | All of B's server work, plus: a token must exist before the first start (`register` for `start.sh`, `demo.sh`, the tests), a loopback TCP listener reachable by every local account, the runner needs the server URL, not a socket path |
| Still "two ways" for the server | Yes: shared files stay a second channel | No: one registry, one adoption rule, one loss rule; only the accept step differs (socket vs upgrade) | No: one accept step |
| Risks | The server keeps writing in a runner's files; a runner on another machine or container is impossible; two runners of one account collide in one directory; SEC03 stays a special case | Migration of tests and units (large but mechanical); the Unix-socket identity relies on file permissions (no `SO_PEERCRED` in Node); a lost binding file deletes sessions on the runner at the next hello | Token bootstrap for dev flows (`start.sh` would have to create `runners.json` entries itself: the server must be running to mint a token, so a script would call an admin route or write the server's store: a second writer); any local user can try the loopback port; `trust-proxy`/nginx path sees local runner traffic |
| Effort | **S** | **L** (about 5 tasks, section 3.1) | **XL** (B + token bootstrap + a loopback route to secure) |
| PST01 persistence | The binding would still be needed for remote runners; the local one keeps a different path | The binding and the uniform grace are the PST01 link: remote and local use the same code; PST01 only chooses policies | Same as B |
| PRN01 / SEC03 trust | `trusted` stays an exception; a student's runner on the lab machine must be told apart from the local one by an extra rule | Nothing is trusted by transport; a personal runner and the local runner differ only by `ownerLogin` and `transport` | Same as B, and the local runner is also token-authenticated |
| CREMI (two systemd units, one machine) | Unchanged | Two directories (`/var/lib/qemuweb/server`, `/var/lib/qemuweb/runner`); the runner unit gets `--connect`; no other change; the units still need no secret | Runner unit needs a token file and the server URL; one more secret to deploy and rotate |
| `start.sh` / `demo.sh` | Unchanged | Two subdirectories, runner dials `--connect`; no token | Needs the bootstrap described above |
| `/admin`, observability | Unchanged (local special-cased) | One panel row type: transport, address, directory as announced (text), sessions bound, pause/revoke/forget for all | Same as B |
| Separate machines / containers with no shared disk (the user's goal) | No | Remote: already; local socket stays on one host, but the runner may live in another container that mounts only the socket | Yes (TCP) but then it **is** a remote runner |

### 2.2 Honest comparison

- **A** is cheap and solves nothing the user asked for: the server still writes in runner files, and a student's runner sitting next to the
  local one (lab machine) cannot share one `/tmp/qw-<login>/<port>` safely. It is the fallback if RUN03 is judged too costly now.
- **C** is the purest, but it moves the cost to *deployment* (a token for the local runner, a loopback listener) to gain nothing the Unix socket
  does not already give: only the server's user can open the socket. It also makes `start.sh`/`demo.sh`/tests depend on `runners.json`
  bootstrapping. Rejected for the local case; the same code accepts it later (the accept step is the only difference).
- **B** makes the Unix socket a *transport detail*. The only place where the two paths differ is the accept step in the gateways.
  Every rule after the accept (identity record, pause, grace, binding, adoption, loss, deletion) is written once.

### 2.3 Recommended design (B), with its rules

**R1. Ownership.** Two directories, two owners, no overlap; a process never writes in the other's.

| Directory | Owner | Holds |
|---|---|---|
| server directory `<server runtime>` | server | `server-<port>.pid`, `runner-<port>.sock`, `bindings.json` (R6); `server-<port>.session` is **dropped** (R9); nothing of a runner |
| runner directory `<runner runtime>` | runner | `sessions/<id>/` (`session.json`, `meta.json`, nodes, disks, sockets), `users/<login>` aliases (R8), `runner.pid` (lock, R9) |
| `runners.json`, `users.json`, logs | server | as today (outside both) |

The server never opens a path under a runner's directory. Anything it needs travels as a command or an event.

**R2. Default directories (budget of TOD02: 49 bytes for a runner directory, 107 for the socket, measured by `common/runtime-dir.js`).**
`/tmp/qw-<login>` is at most 8 + 32 = 40 bytes, leaving 8 bytes for the last component: it must be at most 8 characters.

| Process | Default | Length of last component |
|---|---|---|
| Server | `/tmp/qw-<login>/<port>` (as today; it only holds `runner-<port>.sock` (17), a short file) | 5 |
| Local runner | `/tmp/qw-<login>/l-<port>` | 7 |
| Remote runner | `/tmp/qw-<login>/r-<6 hex of its id>` | 8 |

The id of a remote runner is `r-xxxxxxxx`: its first six hex digits make the name unique per runner of an account (two runners of the same
account never share a directory; a collision is refused by the lock `runner.pid`, R9). `--runtime DIR` replaces any default (the CREMI
units pass absolute paths). The server's socket path is `<server runtime>/runner-<port>.sock`; the runner finds it with `--connect SOCKET`,
or with `--port PORT` which resolves the **server's** default directory (a convention, no shared access). `register --runtime` keeps the
chosen runner directory in the runner file as today.

**R3. Identity.** Every runner has a record in `runners.json` (schema version 2: adds `transport: "unix" | "ws"`; `tokenHash` only for `ws`).
- `ws`: as today (registration token, Bearer, constant-time compare, 401/409).
- `unix`: one record, id `local`, **auto-created the first time something connects to the socket** (audited in `admin.log` as
  `register-local-runner`). The proof is the socket: mode 0600 in a directory owned by the server's user (kept as today). Node.js exposes no
  `SO_PEERCRED`; the file mode is the credential (same user, or root). Any other runner id on the socket is refused: the socket serves
  exactly the record `local` (still one live connection).
- A revoked record (either transport) is refused at its accept step. `DELETE` forgets the record (the next connection of `local` creates it again).

**R4. No trust by transport.** `trusted` and `local` disappear from the registry. What a runner may do is decided by its **record**
(owner, paused, revoked, later limits), never by how it connected. A personal runner (PRN01) and the local runner are the same kind of
entry; they differ by `ownerLogin` and by the record fields.

**R5. What a hello may claim.** The hello is untrusted input for every runner. The server uses only: `protocol`, bounded capabilities
(engines, kvm, cpus, memoryBytes, images, warnings, `limits.maxSessions`), `pid` (display), `runtimeRoot` (display text only, bounded, never
opened) and the **session IDs** it reports. It ignores `owner` and `createdAt` of a reported session (an **owner is never taken from a
hello**, today only trusted by the transport). A reported session no one asked for is `session.delete`d.

**R6. Binding: the PST01 link.** The server persists the link session -> runner in `<server runtime>/bindings.json` (mode 0600, atomic
write-through, schema version 1): `{"sessions": [{"id", "owner", "runnerId", "createdAt"}]}`. It is written **before** `session.create` is
sent and removed when the session is deleted or dropped.
- At server start the bindings are loaded as workspaces in the **offline** state (the handle is bound to a placeholder client that answers 503,
  `manager.available` is false): there is no window in which a user can open a new session while the runner of the old one is still
  connecting (this race exists today with several runners).
- On a hello of runner X (**any** transport): each binding of X that the hello reports is bound to the new connection (`RunnerClient.adopt`,
  `runner-state online`), each binding of X that is not reported is dropped (`runner lost`), each reported session with no binding of X is
  `session.delete`d. A session is thus adopted only if the **server** already knew its owner: the trust is in the server's file, not in the hello.
- A restart of a remote runner's server no longer kills its VMs, as for the local one: the same code.
- If `bindings.json` is lost, the runners' sessions are deleted at their next hello (the user starts again). If it is stale (a server crash
  after `session.create`, before the runner created it), the binding is dropped at the hello.

**R7. Loss and removal.** One rule for all runners: when the connection drops, the sessions of the runner are kept offline for `--runner-grace`
seconds (503 "offline", `runner-state`), then dropped (`runner offline too long`, bindings removed). When the runner returns, sessions it
holds that the server dropped are deleted by `session.delete`, sessions it lost are dropped at once. The server **never removes a
directory**; the runner prunes its own at start (R9). `scripts/start.sh` passes `--runner-grace 0` unless the user gave one (the script
ends when the runner ends anyway). **Forced loss** (PST01): `POST /api/admin/runners/:id/drop-sessions` drops the bindings and, if the
runner is connected, sends `session.delete` for each: the one place to extend. A revoked runner: PST01 decides (recommendation: drop at once, nothing will return).

**R8. `users/<login>` aliases.** **Recommendation: the runner keeps them in its own directory.** `session.create` already carries
the owner; the runner creates `<runner runtime>/users/<login>` -> `../sessions/<id>`, removes it at `session.delete`, prunes the dangling ones at
start. The server never reads or writes them. For the administrator who looks at the files: **no change** on the machine of the runner
(`ls <runner dir>/users/`); `scripts/status.js` reads `users/` (or `meta.json`, which holds the owner) from the **runner** directory
it finds through the runner's command line (`--runtime` or the default). `/admin -> Runners` shows the directory the runner announced
(text, display only) so the administrator knows where to look. Alternative (dropped aliases, `meta.json` only) is possible: see Q4.

**R9. Start-up pruning, by the runner, in its own directory.** A runner takes `runner.pid` (the lock of the directory: a live process
refuses a second runner on the same directory); at start it removes the session directories that hold no node (the existing rule of
`ServerInstance.pruneEmptyRuntimeSessions`, moved to `runner/`) and the dangling aliases. A non-empty directory left by a crash
is kept and reported in the runner's log until PST01 chooses a restore or discard policy; `cleanall.sh` removes it. Because each runner
has its own directory, the "do not prune a session of another live server" test (`server-<port>.session`) is gone, and so is that file.
Behaviour change to know: a SIGKILLed local runner's session directories are no longer removed by the server (they stay until the runner's next start or `cleanall.sh`).

**R10. Observation and control rules unchanged.** Administrator observation, the control lock, the audit log, browser rooms, the 503 for
an offline runner, `pickRunner` (one place) are not touched. `pickRunner` loses only the `local` tie-break; PRN01 will add the owner rule
there.

**R11. Administration (`/admin -> Runners`).** The summary gets `transport` (`unix`/`ws`), `directory` (as announced), `pid` (for unix);
pause, resume, revoke, forget are the same for all rows; the local row exists as soon as its record exists (so a stopped local runner is
shown "offline", as a remote one, with its last seen date); `connectHint` stays for the case "no runner at all".

### 2.4 What the design does not do

- It does not choose a restore policy (PST01), does not add address restrictions (`/runner/connect`, `/api/runner/register`: PST01 item, an allow
  list in the record fits the model), and does not validate a runner's events (SEC03: the single rule "an event for a session bound to
  this runner", already in `RunnerClient.receive`, now stands for all).
- Two machines with no shared disk work for the *remote* path today; for the Unix path, the server and the runner must see the socket
  (same host, or a bind-mounted socket).

[Parts 3 and 4: written next.]
