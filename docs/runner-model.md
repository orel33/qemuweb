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

[Parts 2 to 4: written next.]
