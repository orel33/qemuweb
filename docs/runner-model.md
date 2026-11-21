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

## 3. Migration, tests and tasks

### 3.1 Migration (beta rules)

No legacy reader, no compatibility path. After the change an old runtime directory (`/tmp/qw-<login>/<port>` with `sessions/`, `users/`
of a former run; `/var/lib/qemuweb` of the CREMI) is simply not used as a runner directory: the user deletes it by hand
(`./scripts/cleanall.sh`, or `rm -rf /var/lib/qemuweb/*` at the CREMI after `qwctl.sh stop`). An old `runners.json` (schema 1) is refused
with the existing message ("must contain schemaVersion 2"): the user deletes or rewrites it (it holds only tokens of test runners). Both
processes must be restarted together once (no protocol version bump is needed: the hello fields that are removed are only ignored).

### 3.2 Implementation tasks, in order

Each task is small, merges on its own, and the application stays usable after each one. The user approves before RUN03a starts.

| Task | Size | What | Acceptance criteria | Files |
|---|---|---|---|---|
| **RUN03a** The runner owns its files | M | Move to the runner what the server does with files: aliases `users/<login>` (create at `session.create`, remove at `session.delete`, prune dangling at start); start-up pruning of empty session directories (code of `pruneEmptyRuntimeSessions`); `runner.pid` lock. Remove from the server `linkUserAlias`, `unlinkUserAlias`, `removeUserAliases`, `pruneUserAliases`, `sharesRuntime`, the `rmSync` of `dropRunnerSessions`, `ServerInstance.pruneEmptyRuntimeSessions`/`liveServerSessions`, `server-<port>.session`, `Session.runtimeDir`, the `fs` import of `session-manager.js`. | `grep -n "fs\." server/session-manager.js` finds nothing; the server opens no path outside its own directory, the logs and `runners.json`; a session shows `<runner dir>/users/<login>`; two runners on one directory: the second refuses with a clear message; the empty directories are pruned by the runner at start. | `runner/service.js`, `runner/session.js`, new `runner/runtime-tidy.js`, `runner/main.js`, `server/session-manager.js`, `server/session.js`, `server/server-instance.js`, `server/serve.js`, `scripts/stop.sh` (`.session`) |
| **RUN03b** One directory per runner | M | Own default directories (R2), `--connect`/`--port` resolve the **server's** directory, `status.js` pairs a runner and a server by the dialled socket and reads aliases and `meta.json` in the runner's directory, `start.sh`/`demo.sh` give the runner its own directory, CREMI units and doc. | `start.sh` runs with `/tmp/qw-<login>/<port>` (server) and `/tmp/qw-<login>/l-<port>` (runner); `runner.sh` with no `--runtime` works for a server of the default port; a remote runner of id `r-1a2b3c4d` uses `/tmp/qw-<login>/r-1a2b3c`; every default is within the 49-byte budget for a 32-character login; `status.sh` shows the same tree as today. | `common/runtime-dir.js`, `scripts/lib/runtime.sh`, `runner/options.js`, `runner/main.js`, `runner/remote-identity.js`, `scripts/start.sh`, `stop.sh`, `demo.sh`, `status.js`, `status-vbox.js`, `deploy/cremi/*.service`, `qwctl.sh`, docs |
| **RUN03c** One identity, no trust flag | M | `runners.json` v2 with `transport`; the record `local` auto-created at the first socket connection; `trusted` and `local` removed from the registry; paused/revoked/forget for `local`; `runtimeRoot` display-only; `transport` in the admin summary; log lines of the same form; tie-break without `local`. | Registry has no `local`/`trusted`; pause of `local` survives a server restart; revoking `local` refuses its next connection; a second connection with another id on the socket is refused; the hello's `owner` is ignored. | `server/runner-gateway.js`, `runner-registry.js`, `runner-store.js`, `remote-gateway.js`, `routes/admin-runners.js`, `serve.js`, `public/admin*.js` (the runners panel), `server/startup-checks.js` (v2 message) |
| **RUN03d** Binding and uniform adoption | L | `bindings.json` (R6), offline restore at start with a placeholder client, `resync` by the binding for every runner, grace for every runner (`start.sh` passes `--runner-grace 0` unless given), `session.delete` for unknown or dropped sessions, forced-loss route. | Server restart with a local **and** a remote runner: both keep their machines and consoles; hello with an unknown session deletes it; a lost `bindings.json` deletes sessions on return; no new session can be opened for a user whose bound runner is only offline; the `users.log` events are unchanged (`session-adopted`, `session-deleted`). | `server/session-manager.js`, new `server/session-bindings.js`, `server/runner-client.js` (offline placeholder), `server/serve.js`, `server/routes/admin-runners.js`, `scripts/start.sh` |
| **RUN03e** Documentation and cleanup | S | `architecture.md` (replace the "5c" paragraphs on `local`/`trusted`/shared files), `deployment.md` ("Files shared with the runner" removed; adoption, runner crash, forced loss), `deploy-cremi.md`, `reference.md` options, `test/tests.md`, the roadmap entry (by the orchestrator). | No mention of "shared with the runner" or "trusted runner" remains (grep). | `docs/*`, `deploy/cremi/*.md`, `test/tests.md` |

A and B can be done in either order; C needs neither; D needs A and C. Tests are rewritten **with** the task that breaks them (3.3).

### 3.3 Tests

| Test | Why it changes | Task |
|---|---|---|
| `test/unit/session-manager.test.js` | aliases, `sharesRuntime`, rmSync, pruning disappear; adoption by owner of a hello disappears | a, d |
| `test/unit/runtime-restart.test.js` | `ServerInstance` live sessions and pruning move to the runner (its tests move to a runner unit test) | a |
| `test/unit/runner-gateway.test.js` | registers `local` as `trusted`/`local`; new: record, one connection, other id refused | c |
| `test/unit/session-adoption.test.js`, `remote-sessions.test.js` | adoption is by binding for every runner; grace for the local runner | d |
| `test/unit/admin-runners.test.js` | summaries without `local`, pause/revoke/forget for `local`, `transport` | c |
| `test/unit/server-startup-report.test.js` | start-up lines (no `users/` link line, directory per runner) | a, b |
| `test/unit/runtime-dir.test.js` | new default names (`l-<port>`, `r-<id6>`), budget for a 32-character login | b |
| `test/unit/status-vbox.test.js`, status tests | pairing by the dialled socket | b |
| `test/integration/check-runner.js` | asserts server-port session directory and aliases; now the runner directory | a, b |
| `test/integration/check-runner-manual.js` | becomes the standard case: runner directory separate, aliases created **by the runner**, binding adoption | a, d |
| `test/integration/check-load-start.js`, `admin.js` | process lookup by `<default runtime>/sessions/<id>` | b |
| `test/integration/check-runner-remote.js` | extend: server restart, the remote session is adopted | d |

New tests: runner pruning and aliases (a); `runner.pid` lock (a); runner defaults within the budget (b); `local` record and refused second id (c);
`bindings.json` read/write/lost/stale (d); offline restore blocks `open()` (d); forced loss route (d); a real-browser check of console
re-selection after a runner returns (PST01 item, can use `check-runner-remote`). Per `AGENTS.md`, **none of them is run without the user's approval.**

### 3.4 Scripts and CREMI

| Script / unit | Effect |
|---|---|
| `start.sh` | two directories; the runner dials `--connect <server dir>/runner-<port>.sock`; `--runner-grace 0` unless given |
| `stop.sh` | removes `server-<port>.pid` and the socket (own directory); no `.session` |
| `status.sh` | pairs by socket; login from the runner directory |
| `killall.sh`, `cleanall.sh` | unchanged: they work on `/tmp/qw-<login>/`, which holds both directories; the dry run lists both |
| `demo.sh` | `$demo_dir/server` and `$demo_dir/runner` (deleted at exit) |
| `qemuweb-server.service` | `--runtime /var/lib/qemuweb/server` |
| `qemuweb-runner.service` | `--runtime /var/lib/qemuweb/runner --connect /var/lib/qemuweb/server/runner-3002.sock`; one `install -d` more in `deploy-cremi.md`; start order unchanged (`After=`); restarting the server alone keeps the machines (as today, now also with the binding) |
| `qwctl.sh` | text only |

### 3.5 Documentation

`architecture.md` (ownership table, "Runners in the control plane", "Connection lifecycle" items 3 and 6, "Runner loss", "User-land runners",
"Remote runners"), `deployment.md` (adoption, "Files shared with the runner", runner crash, remote runners, directory layout),
`deploy-cremi.md` and `cremi-architecture.md` (directories, units), `reference.md` and the `--help` of `runner/main.js` and `server/main.js`
(`--runtime` text), `test/tests.md`.

### 3.6 Event x outcome (the bridge to PST01)

"Today" is read from the code (grace 300 s as at the CREMI; the local runner has no grace). "Design" is the recommended design with PST01 policies **not** yet chosen (machines are never restored after a runner process dies).

| Event | Local runner today | Remote runner today | Both, with the design |
|---|---|---|---|
| **Server restart** (runner alive) | Sessions adopted by the `owner` in the hello; users log in again and keep machines. Under `start.sh` the runner exits with the server | Sessions of the hello are **deleted** on the runner when it reconnects: the VMs die | Binding loaded as offline workspaces, then bound to the runner at its hello (2 s to 30 s later): the same for both. Under `start.sh` the runner still exits with the server |
| **Runner process restart** (crash, `systemctl restart`) | Sessions dropped at once, dirs removed by the server; new empty session at the next request | Sessions offline for the grace; at return the hello lacks them: dropped; directories left | Sessions offline until the runner returns (hello without them: dropped at once) or until the grace ends; runner prunes its empty directories at start; non-empty ones stay (PST01) |
| **Machine reboot** (`/tmp` default) | All lost (RAM, `/tmp`); nothing reads files back | Same on the runner side; the server forgot everything | Server and runner directories lost together: a clean start. With `--runtime` on disk (CREMI): the binding is loaded, the runner's hello lacks the sessions, they are dropped and logged `session-deleted: runner lost`; disks stay on disk until PST01 decides restore or discard |
| **Network cut** | Not applicable (Unix socket) | Offline for the grace (503), VMs keep running, resync at return | Same, for every runner whose transport can be cut |
| **Runner revoked** | Refused (403) | Token invalid, connection closed, sessions kept for the grace then dropped, the runner stops itself | Same for both; forced loss and drop-at-once for a revoked runner are the PST01 controls (R7) |
| **Runner removed from `runners.json` by hand** | n/a | Next `verify` fails (401) | Same for both |

## 4. Open questions for the user

| # | Question | Recommendation and why |
|---|---|---|
| Q1 | Design B (own directories, registered identity, binding), or A as a cheaper first step? | **B**: A keeps the server writing in runner files, which is what you want gone, and PST01 and PRN01 would have to special-case the local runner. |
| Q2 | Identity of the local runner: record `local` auto-created on first socket connection, proof = the 0600 socket (no `SO_PEERCRED` in Node), or a token also for the local runner (C)? | **Socket proof.** Same guarantee as today (only the server's user can connect), no bootstrap of a token for `start.sh`, `demo.sh`, tests, systemd units. |
| Q3 | The owner of an adopted session comes from the server's `bindings.json`, never from the hello. A lost file means the sessions are deleted at the next hello. Accept? | **Yes**: the trust then does not depend on who sent the hello (SEC03), and the file lives next to `runners.json`. |
| Q4 | `users/<login>` aliases: kept by the runner (recommended), or dropped (owner only in `meta.json`, shown by `status.sh`)? | **Kept by the runner**: no habit changes for you on a machine, no server involvement, a few lines in the runner. Drop only if you never use them. |
| Q5 | A runner killed hard leaves non-empty session directories: kept until PST01 (recommended), or deleted at the runner's next start after checking that no process uses them? | **Kept until PST01** (restore or discard is exactly its question); `cleanall.sh` removes them. |
| Q6 | Grace for the local runner: the same 300 s (a stopped local runner shows "offline" instead of a new empty session at once), `start.sh` with `--runner-grace 0` (recommended for development)? | **Uniform grace, `--runner-grace 0` in `start.sh`.** One rule; in the CREMI, systemd restarts the runner in seconds and the hello drops what was lost. |
| Q7 | Revoking a runner: drop its sessions at once (recommended) or keep them for the grace? Forced-loss route in RUN03d or left to PST01? | **Drop at once** (nothing returns) and **the route in RUN03d** (it is the same drop function). |
| Q8 | Directory names: `l-<port>` for the local runner, `r-<6 hex of the id>` for a remote one, server `<port>` (all at most 8 characters, within the 49-byte budget). OK? | **Yes.** Longer names break the budget for a 32-character login. |
| Q9 | Is a **one-time breaking change** acceptable at the CREMI (new directories, runner unit edited, old `/var/lib/qemuweb` content deleted, `runners.json` rewritten)? | **Yes** (beta rules). Do it with the roadmap's next release and say so in the release notes. |
| Q10 | Order: RUN03 (a, b, c, d, e) before PST01, as the roadmap says? | **Yes.** PST01's persistence is RUN03d's `bindings.json`; deciding restore policies first would be built twice. |

### What could not be verified

- Nothing was run (no tests, no application, no `prepare.sh`), per `AGENTS.md`.
- `SO_PEERCRED` is not available in Node.js without a native addon: this is from knowledge of the platform, not checked on this machine.
- The behaviour of the real CREMI systemd units after the change (directory permissions between the two `qemuweb` directories, the order of start) is by reading the unit files only.
- The exact test counts of `session-adoption.test.js`, `remote-sessions.test.js`, `admin-runners.test.js` were taken from their names and the test index; the precise assertions to rewrite are known only when the tasks start.
