# Runner model: the local runner becomes a runner like the others (RUN03, design study)

Status: **DRAFT, revision 2** (the user chose **option C** for Q1/Q2: the local runner connects by the same WebSocket path as a remote runner and registers
with a token; no Unix socket for the runner link). No code changes with this document. Roadmap: RUN03 (milestone 7), then PST01.
Beta rules (`AGENTS.md`): no legacy reader, no compatibility path; an old runtime directory is not used, the user deletes it by hand.
Linked from [architecture.md](architecture.md#runner-model-run03-design-study).

Terms: **server** = control plane (`server/`), **runner** = `runner/`. "Local runner" = the one on the Unix socket today
(id `local`). "Remote runner" = registered with a token (`r-xxxxxxxx`, `runners.json`), over WebSocket.

## 1. Inventory: local runner vs remote runner today

Disposition: **keep** (stays as is, for every runner), **move** (becomes a runner command or runner-side rule), **drop** (removed).

### 1.1 Differences

| # | Topic | Local runner today | Remote runner today | Evidence | Disposition |
|---|---|---|---|---|---|
| 1 | Transport | Unix socket `<runtime>/runner-<port>.sock`, mode 0600 (umask 0177 + chmod), created by the server; stale socket removed or live one refused | WebSocket `/runner/connect`, `ws` duplex under the same `Connection` | `server/runner-gateway.js:20,24-35,46-56`; `server/remote-gateway.js:141-151` | **drop** the Unix gateway (decision C): one transport, the WebSocket |
| 2 | Identity | Fixed id `local`; no credential: whoever opens the 0600 socket is "the server's user"; one connection at a time, a second is destroyed | Registered id `r-xxxxxxxx`, `Authorization: Bearer` checked against `tokenHash` (constant time), 401 unknown/revoked, 409 already connected | `runner-gateway.js:38-40`; `remote-gateway.js:146-149`; `runner-store.js:244-249` | **move**: the local runner registers with a token like any runner (section 2.4 says how it is started) |
| 3 | `trusted` | `true`, set by the gateway | `false` always | `runner-gateway.js:39`; `runner-registry.js:39` | **drop** as a flag (rule R4) |
| 4 | `local` | `true`, set by the gateway | `false` always | `runner-gateway.js:39`; `runner-registry.js:39` | **drop** as a behaviour switch; keep a display field `transport` |
| 5 | Registry record | None: not in `runners.json`, no name, `registeredAt` 0 | Record with name, `createdAt`, `lastSeenAt`, `paused`, `revoked` | `runner-registry.js:39`; `runner-store.js:174` | **move**: one record for every runner (id `local` allowed) |
| 6 | Paused state | In memory only (lost at a server restart); `id !== 'local'` skips the store | In `runners.json` (`paused`) | `routes/admin-runners.js:99-103`; `remote-gateway.js:44` | **move** (persisted for all) |
| 7 | Revoke / remove | Refused (403) | Allowed | `routes/admin-runners.js:112,124` | **move**: same rules for all (a revoked `local` is refused with 401) |
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
| 20 | Runner option to find the server | `--port PORT` => `<runtime>/runner-PORT.sock` **inside its own runtime** (needs the shared directory), or `--connect SOCKET` | `--url` + runner file (id and token) | `runner/options.js:60-63,129-132` | **move**: `--port PORT` becomes `ws://127.0.0.1:PORT`; `--connect` and `serverSocket` are dropped; the token comes from a file (2.4) |
| 21 | `--exit-on-disconnect` | Used by `start.sh`: stop every machine and exit when the connection drops | Forbidden | `runner/main.js:101-111`; `scripts/start.sh:108` | **keep** (a launcher choice, not trust) |
| 22 | Reconnect | Every 2 s, forever | 2 s doubling to 30 s, heartbeat ping 15 s; stops for good on 401 | `runner/main.js:93-124`; `runner/remote.js` | **keep** the remote one for all; the Unix `connect()` is dropped |
| 23 | Address shown in `/admin` | `null` | Remote address (bounded text) | `runner-registry.js:40`; `remote-gateway.js:122-125` | **keep** (`127.0.0.1` for the local runner) |

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
| `server/runner-gateway.js:33,57` | unlink the Unix socket | the server's own socket | **drop** with the gateway |
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
| `scripts/start.sh` | runs server and runner with the same `--runtime`, waits for `<runtime>/runner-<port>.sock`, gives the runner `--port` and `--runtime` | `start.sh:49-56,100-108` | **move**: server `--local-runner`, waits for the port and the token file, runner `--port --token-file --runtime` |
| `scripts/stop.sh` | reads server records in `<runtime>`; finds the runner by `--port` in its command line and says "its VMs keep running" | `stop.sh:30-31,69-80` | **keep**, tell about the runner directory |
| `scripts/status.sh` / `status.js` | pairs a runner with a server when `dialledRuntime(runner)` equals the server's runtime (the runner's `runner-N.sock` argument); reads aliases for the login | `status.js:203-214,306-317,334,340`; `status-vbox.js:31-47` | **move**: pair by port (`--port N`), runner directory from its `--runtime`; login from `users/` or `meta.json` in the runner's directory |
| `scripts/killall.sh`, `cleanall.sh` | clean `/tmp/qw-<login>/` as a whole (all default directories of the account) | `killall.sh:3`, `cleanall.sh:5-30` | **keep** (the account root already contains every default directory) |
| `scripts/demo.sh` | one temporary `runtime` for server and runner | `demo.sh:175-176` | **move**: two subdirectories of `$demo_dir` |
| `scripts/lib/runtime.sh` | `default_runtime PORT\|runner` | `lib/runtime.sh:4-12` | **move**: one more kind of name (R2) |
| `deploy/cremi/qemuweb-runner.service` | `--port 3002 --runtime /var/lib/qemuweb` = the server's directory | unit line 8 | **move**: own directory + `--connect` |
| `deploy/cremi/qemuweb-server.service` | `--runtime /var/lib/qemuweb` | unit line 8 | **move**: `/var/lib/qemuweb/server` |
| `deploy/cremi/qwctl.sh`, `deploy-cremi.md` | text only ("same `--runtime` for both", 49 chars) | `deploy-cremi.md:355` | **move** (documentation) |
| `common/runtime-dir.js` | `defaultRuntime(name)`; the comment says "server and local runner"; the budget includes `runner-65535.sock`; `prepareRuntime` applies the node-socket budget to every directory, the server's too | `runtime-dir.js:1-20,84,98-106,119-123` | **move**: runner-only budget, no `runner-*.sock`, names `l-<port>`, `r-<id6>` (R2, 2.5) |
| Integration `check-runner.js` | asserts the server-port session directory, the 0600 socket `<runtime>/runner-<port>.sock` | `check-runner.js:96-98,127,140,167,178` | **rewrite** (WebSocket, token file, runner directory) |
| `check-runner-manual.js` | spawns `runner/main.js --connect <socket>` with its own runtime; asserts the socket mode and its removal; asserts "no alias: the runner does not share runtime/" | `check-runner-manual.js:83,126,146-148,183,210` | **rewrite** (spawn the server with `--local-runner`, the runner with `--token-file`; aliases are now created by the runner; no socket assertion) |
| `check-load-start.js`, `admin.js` | find a session's processes by `<runtimeDir>/sessions/<id>` of the default runtime | `check-load-start.js:83,197`; `admin.js:76` | **rewrite** (runner directory helper) |
| `check-runner-remote.js` | uses its own runner directory already | `:120,171` | **keep**, extend (restart adoption) |
| Unit `session-manager.test.js` | aliases, `sharesRuntime`, pruning, rmSync (13 alias hits, 38 runtime hits) | file | **rewrite** |
| Unit `runtime-restart.test.js` | `ServerInstance` live sessions + pruning | file | **rewrite** (pruning moves to the runner) |
| Unit `runner-gateway.test.js` | tests the Unix gateway (`trusted`/`local`, stale socket, second connection) | 2 + 9 hits | **delete**; new tests for the local record and the token file (section 3.3) |
| Unit `session-adoption.test.js`, `remote-sessions.test.js`, `admin-runners.test.js`, `server-startup-report.test.js`, `runtime-dir.test.js`, `status-vbox.test.js` | trusted adoption, grace, local summary, startup lines, the default directory, the runner/server pairing | files | **rewrite or extend** (details in section 3) |

Observation: `check-runner-manual.js` already runs the case "runner has its own runtime directory, the server touches nothing". Today that case
**silently loses** the `users/` aliases, the empty-session pruning and the server-side directory removal, but still adopts: it is the
design of this study, minus the WebSocket identity and the binding.

## 2. Options and recommendation

### 2.1 The options (first round)

| | A: formalise the shared directory | B: Unix socket, own directory, registered identity | **C: the local runner uses the WebSocket path (decided)** |
|---|---|---|---|
| Idea | Keep one directory per port for both; document the contract | Same Unix socket, own runner directory, a `local` record, a server-side binding | The local runner dials `ws://127.0.0.1:<port>/runner/connect` with a token, exactly like a remote one; the Unix gateway is deleted |
| Still "two ways" for the server | Yes (shared files) | Only the accept step | **No**: one accept step, one registry, one adoption rule, one loss rule |
| Effort | **S** | **L** | **XL** in the first estimate, **L** once the token bootstrap is cheap (2.4) |
| Main risk | The server keeps writing in runner files; no separate machines | Identity rests on file permissions (no `SO_PEERCRED` in Node) | The token must reach the local runner without a manual step (answered in 2.4) |
| PST01 / PRN01 / SEC03 | Special case for the local runner stays | Uniform | Uniform, and the local runner is authenticated like every other |

**Decision of the user: C.** A and B are kept here only as the record of the comparison. Everything that existed for the Unix socket (gateway,
`--connect`, `runner-<port>.sock`, the 0600 socket as a proof of identity, the `SO_PEERCRED` discussion, a `transport` field) is removed from the design, not kept as an option.

### 2.2 Why C is acceptable

The cost feared in the first round was deployment: a token for a runner that never leaves the machine. Section 2.4 removes it: the server mints the token of
the local runner itself, in a file only the same account can read, and the runner reads it at each connection attempt. A user types no token
(`./scripts/start.sh`, `demo.sh`, the tests and the CREMI units all work without one). The Unix socket's only advantage over a
loopback WebSocket was that nobody else could connect; the token gives the same guarantee and is checked by the code path the remote runners already exercise.

### 2.3 The recommended design (C), with its rules

**R1. Ownership.** Two directories, two owners, no overlap; a process never writes in the other's.

| Directory | Owner | Holds |
|---|---|---|
| server directory `<server runtime>` | server | `server-<port>.pid`, `bindings.json` (R6), `local-runner.token` (2.4); `server-<port>.session` is **dropped** (R9); no socket; nothing of a runner |
| runner directory `<runner runtime>` | runner | `sessions/<id>/` (`session.json`, `meta.json`, nodes, disks, node sockets), `users/<login>` aliases (R8), `runner.pid` (lock, R9) |
| `runners.json`, `users.json`, logs | server | as today (outside both) |

The server never opens a path under a runner's directory. The one file that crosses is the credential `local-runner.token`: written by the server in
**its** directory, read by the runner. It is a credential hand-off (what `register` returns over HTTP for a remote runner), not a runner file.

**R2. Default directories and the budget of TOD02.** A Unix socket path is limited to 107 bytes. With the runner link on TCP, **only the runner's
node sockets** are under that limit: the longest is `sessions/<16 hex>/s-<16 hex>/serial1.sock`, which leaves **49 bytes** for the runner directory (unchanged;
`runner-65535.sock` was shorter, so the figure does not move). The server directory has no socket and **no length limit**.
`/tmp/qw-<login>` is at most 8 + 32 = 40 bytes, so the last component of a **runner** default must be at most 8 characters.

| Process | Default | Budget |
|---|---|---|
| Server | `/tmp/qw-<login>/<port>` | none (no socket) |
| Local runner | `/tmp/qw-<login>/l-<port>` (7 characters) | 49 bytes |
| Remote runner | `/tmp/qw-<login>/r-<first 6 hex of its id>` (8 characters) | 49 bytes |

Two runners of one account never share a directory (a collision is refused by the lock `runner.pid`, R9). `--runtime DIR` replaces any default. The runner no
longer needs to know where the server's directory is: it dials a URL and reads a token file.

**R3. Identity: one path for every runner.** A runner connects to `/runner/connect` with `Authorization: Bearer <token>` and `X-Runner-Id`; the token is checked
against a hash (constant time); 401 for unknown or revoked, 409 for an already connected id. A runner has a record in `runners.json` (schema version **2**:
the id pattern becomes `local` or `r-xxxxxxxx`; `tokenHash` is required except for `local`, whose secret is the token file and whose hash the server keeps only in memory, 2.4).
The record `local` exists only when the server runs with `--local-runner`. No `transport` field: there is one transport.

**R4. Nothing is trusted by transport.** `trusted` and `local` disappear from the registry. What a runner may do is decided by its record (owner, paused, revoked,
later limits). The id `local` is a name: pickRunner's tie-break uses `registeredAt` (0 for `local`, so it is still preferred on ties without a special case).

**R5. What a hello may claim.** Unchanged from the first round: the server uses only `protocol`, bounded capabilities, `pid` and `runtimeRoot` (both display only, never
opened) and the session IDs. It **ignores the `owner` and `createdAt` of a reported session**; a reported session with no binding is `session.delete`d.

**R6. Binding: the PST01 link.** `<server runtime>/bindings.json` (0600, atomic write-through, schema 1): `{"sessions": [{"id", "owner", "runnerId", "createdAt"}]}`,
written **before** `session.create` is sent and removed when a session is deleted or dropped. At start the bindings are loaded as workspaces in the **offline** state (placeholder
client answering 503, `manager.available` false), so that nobody opens a second session for a user while the runner of the first reconnects. On the hello of runner X (any
runner): a binding of X that the hello reports is bound to the new connection (`RunnerClient.adopt`); one it does not report is dropped (`runner lost`); a reported session
without a binding of X is deleted. A lost `bindings.json` means the runners' sessions are deleted at their next hello; a stale entry is dropped at the hello.

**R7. One loss rule.** When a connection drops, the sessions of that runner stay offline for `--runner-grace` seconds (503, `runner-state`), then are dropped; a returning runner
deletes (`session.delete`) what the server dropped and the server drops what the runner lost. The server never removes a directory. `start.sh` passes `--runner-grace 0` unless given
(the script ends when the runner ends). **Forced loss** (PST01): `POST /api/admin/runners/:id/drop-sessions`.

**R8. `users/<login>` aliases** are created, removed and pruned by the runner **in its own directory** (`session.create` already carries the owner). The server never reads or writes them;
`status.js` reads them from the runner's directory; `/admin -> Runners` shows the directory the runner announced (text, display only). For the administrator: no change on the machine.

**R9. Start-up pruning by the runner.** A runner takes `runner.pid` (a live process refuses a second runner on the directory), removes at start the session directories that hold no node and
the dangling aliases. Non-empty leftovers stay (reported in the log) until PST01 decides restore or discard; `cleanall.sh` removes them. `server-<port>.session` and the live-server
protection disappear with the shared directory. Change to know: the directories of a SIGKILLed local runner are no longer removed by the server.

**R10. Observation and control rules unchanged** (observation, control lock, audit, rooms, 503 offline, `pickRunner` as the single place; PRN01 will add the owner rule there).

**R11. `/admin -> Runners`.** The summary has no `local` flag; it keeps `address`, `directory` (as announced) and `pid`; pause, resume, revoke, forget are the same for all rows (a revoked `local` is refused
at its next connection); the row `local` exists as soon as the server runs with `--local-runner`; `connectHint` stays while no runner is online (it now prints `./scripts/runner.sh --port PORT`).

### 2.4 Starting the local runner with a token, easily (the central question)

Constraints from the code on main: the server listens on **127.0.0.1 only** (`server/serve.js:143`), behind nginx or Apache on the same machine at the CREMI, so every browser
request reaches it **from 127.0.0.1**; `runners.json` is read once into memory and written by the server only (`runner-store.js:221-223`); the server never starts or supervises a runner (architecture.md,
"Connection lifecycle"); a runner reads its identity from a file `runner.json` (0600) that `register` wrote, never from the command line (`runner/config-file.js`); the runner keeps
its machines when the server restarts and reconnects with the **same token** (a per-run token would orphan them at every server restart).

| | (a) Server-minted token file | (b) One-time administrator step, units reference a file; ephemeral env token in development | (c) Loopback auto-registration, no token |
|---|---|---|---|
| Idea | Server option `--local-runner`: at start, reads `<server dir>/local-runner.token` (0600); if absent or unreadable, **creates** it (32 random bytes, base64url) and keeps its sha256 in memory as the secret of the record `local`. The runner reads the file at **each** connection attempt (`--token-file F`; default: the default server directory of `--port`) | An administrator registers once (`/admin` token + `runner.sh register`, or a new `scripts/runner-token.sh`), stores the token in `/etc/qemuweb/local-runner.env` (0600), both units use it. `start.sh`/`demo.sh`/tests generate a random token in the environment of both children | The server accepts a registration without a token from 127.0.0.1 for the id `local` |
| Steps in development | none (`start.sh` waits for the port, then starts the runner with `--token-file`) | none (env token) | none |
| Steps at the CREMI | none: units are `--local-runner` and `--token-file /var/lib/qemuweb/server/local-runner.token` | one: create the token and the file, edit two units | none |
| Survives a server restart | yes: the file persists, the hash is recomputed | yes (file) / dev: both restart together | yes |
| Code paths on the server | **one** (token from a file) | **two** (env in development, file in production) plus a CLI | one, but see below |
| Secret on the command line | never | never (environment of a child is readable only by the same account) | none |
| Security | Same account only, as before (dir 0700, file 0600). A runner under another account cannot read it: it registers like a remote one (the existing path) | Same, but an operator copies a secret by hand | **Not acceptable** |
| Effort | **S-M** | M (CLI + two paths) | S, but rejected |

**Why (c) is rejected.** The source address proves nothing here: nginx and Apache reach the server from 127.0.0.1 (`proxy_pass http://127.0.0.1:3002`), so a "loopback only" rule would
let **any visitor of the site** register as `local` through the proxy unless the proxy headers were trusted to say otherwise (a header the server cannot authenticate); and any account with a shell
on the machine could do the same. It would put "trust by transport" back, which is the rule this design removes. The assumption "the server machine has no student shell" is not guaranteed
(the lab machines of PRN01 are exactly such machines).

**Recommendation: (a).** One mechanism for development, tests and the CREMI; no manual step; the secret never leaves the server's account. (b) is only a more manual way to reach the same state
and needs two code paths. For a local runner under **another** account or in a container, use the existing remote registration (`/admin` token, `runner.sh register`, `runner.sh run`): nothing new.

**Command line.**

```text
node server/main.js --local-runner [--runtime DIR ...]      # server: creates/reads DIR/local-runner.token
./scripts/runner.sh --port 3002 [--token-file F] [--runtime DIR] [--exit-on-disconnect]
                                                           # local runner: ws://127.0.0.1:3002, token from F
                                                           # (default: <default server directory of port>/local-runner.token)
./scripts/start.sh [server options]                        # both; passes --local-runner, waits, passes --token-file
```

`runner.sh` without a subcommand is the local form (id `local`, URL from `--port`, token from the file); `runner.sh run` remains the remote form (runner file). Both end in `startRemote`.

**Rules.**

1. A long-lived token is **never on a command line** (`ps` shows arguments to every account): a file (0600, directory 0700; the runner warns, as for `runner.json`, when the file is group or world readable) or a
   child's environment. Never printed, never logged, never shown by `status.sh`. Known exception today: the **one-time** registration token of `runner.sh register --token TOKEN` is on `argv` for its
   15 minutes; a `--token-file` or stdin form is proposed (Q12).
2. The server writes the file atomically (temporary file, mode 0600, rename) and only when it is missing or unreadable; it never rewrites a file it can read.
3. The runner reads the file **at every attempt**, so a rotation needs no runner restart. File missing or unreadable: a clear, **non-fatal** message and retry (2 s doubling to 30 s), distinct from 401.
4. 401 (unknown or revoked) is **fatal** as for a remote runner; the runner exits with a dedicated status (proposed **78**) so that systemd can say `RestartPreventExitStatus=78` (otherwise `Restart=on-failure` would loop on a revoked runner).

**Lost file.** The server recreates it at its next start (`qwctl.sh restart server`; under `start.sh` simply start again). The runner, which retries, picks the new token up and reconnects; its sessions are
adopted by the binding (R6). That is the one-command recovery.
**Rotation:** remove the file and restart the server (the open connection stays valid until it drops: the token is checked at the upgrade only).
**Revocation of `local`:** `/admin -> Runners -> Revoke` closes the connection, the runner gets 401 and exits 78. A later `--local-runner` start **never silently un-revokes**: it says so in the log; the administrator forgets the record
(`DELETE`, as for a remote one) and restarts.

**Existing registration API on main.** `POST /api/runner/register` (`server/routes/runner-register.js`): a one-time, time-limited token created by an **administrator** (`routes/admin-runners.js`; 15 min, 1 h or 24 h; at most 20 pending, in memory),
a per-address limit of **10 attempts a minute**, an audit line `register-runner`; **no** per-user daily limit exists on main (that is PRN01's, not merged). The `local` record does **not** use this API: it is created by `--local-runner`
(audit line `register-local-runner`, by `server`), so PRN01's limits and owner rules stay out of its way. Remote and personal runners use the API unchanged.

**Effect on scripts and units.** `start.sh`: `--local-runner`, wait for the port to listen (`/dev/tcp`) instead of the socket, then start the runner with `--port --token-file --runtime`. `demo.sh`: two subdirectories of its temporary directory.
`stop.sh`: no socket to remove. `status.sh`: pairs a runner and a server by **port**. `killall.sh`, `cleanall.sh`: unchanged (account-wide). `qwctl.sh`: text only. Units: server `--local-runner --runtime /var/lib/qemuweb/server`;
runner `--port 3002 --token-file /var/lib/qemuweb/server/local-runner.token --runtime /var/lib/qemuweb/runner`, `After=qemuweb-server.service`, `RestartPreventExitStatus=78`; both stay `User=qemuweb`.

### 2.5 Code that the removal of the Unix socket simplifies

| Code | Change |
|---|---|
| `server/runner-gateway.js` | deleted (stale-socket probe, umask, `chmod`, `onConnection` registering `local` trusted) |
| `server/serve.js:43-46,129,138-143,170` | no `gateway`; `--local-runner` wiring; the "listening" order is simpler |
| `server/main.js:17` | the "Runner socket" row becomes "Local runner token" |
| `server/options.js:26,33,35` | text; new `--local-runner` option |
| `runner/main.js:36-38,93-124,137` | the Unix `connect()` is deleted; one connect path (`startRemote`); `options.socket` gone |
| `runner/options.js:60-75,129-139` | `--connect`, `serverSocket`, the `validate` that derives the directory from the port are deleted; `--token-file` added |
| `common/runtime-dir.js:84,98-106,119-123` | `runner-65535.sock` removed from the budget; `prepareRuntime` takes a flag so the server directory has no budget; `defaultRuntime` names |
| `server/startup-checks.js:259-263` | the server's directory check no longer applies the node-socket budget |
| `scripts/start.sh:97-110`, `stop.sh:43`, `status.js:306-317`, `status-vbox.js:31-47` | no socket wait, no socket removal, pairing by port |
| `deploy/cremi/*.service`, docs | as in 2.4 |

### 2.6 What the design does not do

It does not choose a restore policy (PST01); it does not restrict `/runner/connect` by address (PST01: an allow list on the record, and nginx can keep the path closed from outside when no remote runner is registered);
it does not validate runner events (SEC03: the single rule "events only for a session bound to this runner", already in `RunnerClient.receive`, now stands for all). Server and runner on separate machines now work for **every** runner.

## 3. Migration, tests and tasks

### 3.1 Migration (beta rules)

No legacy reader, no compatibility path. An old runtime directory (`/tmp/qw-<login>/<port>` with `sessions/`, `users/`, `runner-<port>.sock`; `/var/lib/qemuweb` at the CREMI) is not used as a runner directory:
the user deletes it by hand (`./scripts/cleanall.sh`; at the CREMI `qwctl.sh stop` then `rm -rf /var/lib/qemuweb/*`). An old `runners.json` (schema 1) is refused with the existing message style ("must contain schemaVersion 2"):
delete or rewrite it. **CREMI one-time break:** server unit `--local-runner --runtime /var/lib/qemuweb/server`; **new runner unit** with `--token-file /var/lib/qemuweb/server/local-runner.token --runtime /var/lib/qemuweb/runner`
and `RestartPreventExitStatus=78`; `install -d` for the two directories; the token file appears at the first server start; restart both once. The server and runner must be updated together (the Unix link is gone).

### 3.2 Implementation tasks, in order

Each task is small and leaves the application usable. The user approves before RUN03a starts.

| Task | Size | What | Acceptance criteria | Files |
|---|---|---|---|---|
| **RUN03a** The runner owns its files | M | Aliases `users/<login>` (create at `session.create`, remove at `session.delete`, prune dangling at start), start-up pruning of empty session directories, `runner.pid` lock, moved to the runner. Removed from the server: `linkUserAlias`, `unlinkUserAlias`, `removeUserAliases`, `pruneUserAliases`, `sharesRuntime`, the `rmSync`, `pruneEmptyRuntimeSessions`, `liveServerSessions`, `server-<port>.session`, `Session.runtimeDir`, the `fs` import of `session-manager.js` | no `fs.` in `server/session-manager.js`; the server opens no path outside its directory, the logs and `runners.json`; aliases appear in the runner's directory; a second runner on one directory refuses | `runner/service.js`, `runner/session.js`, new `runner/runtime-tidy.js`, `runner/main.js`, `server/session-manager.js`, `server/session.js`, `server/server-instance.js`, `server/serve.js`, `scripts/stop.sh` |
| **RUN03b** One identity, no trust flag | M | `runners.json` v2 (`local` id, `tokenHash` optional only for `local`), `trusted`/`local` removed from the registry and the admin summary, `runtimeRoot` display-only, tie-break by `registeredAt`, hello `owner` ignored, pause/revoke/forget for `local` | the registry has no `trusted`/`local`; pause of `local` survives a server restart; a revoked `local` gets 401; the hello's owner is ignored | `server/runner-registry.js`, `runner-store.js`, `remote-gateway.js`, `routes/admin-runners.js`, `serve.js`, `public/admin*.js`, `startup-checks.js` |
| **RUN03c** The local runner over the WebSocket; the Unix socket removed | L | Server `--local-runner` and the token file (2.4); the runner's local form (`--port`, `--token-file`, retry when the file is missing, exit status 78 on 401); deletion of `runner-gateway.js`, the Unix `connect()`, `--connect`, `serverSocket`; `start.sh`, `demo.sh`, `stop.sh` adapted (wait for the port); `runtime-dir.js` budget without the socket | `grep -rn "runner-.*sock\|runner-gateway\|--connect"` finds nothing but history; `start.sh` and `runner.sh --port N` work with no typed token; lost token file recovered by a server restart; the token never on `ps`; a revoked `local` ends the runner with 78 | `server/options.js`, `main.js`, `serve.js`, new `server/local-runner-token.js`, `server/runner-gateway.js` (deleted), `runner/options.js`, `runner/main.js`, `runner/remote.js`, `common/runtime-dir.js`, `scripts/start.sh`, `demo.sh`, `stop.sh`, `runner.sh`, `scripts/lib/runtime.sh` |
| **RUN03d** One directory per runner, scripts | M | Default names (R2), `status.js`/`status-vbox.js` pair by port and read aliases/`meta.json` in the runner's directory, `demo.sh` two subdirectories, server directory without budget | defaults within 49 bytes for a 32-character login; `status.sh` shows the same tree as today; two runners of one account get two directories | `common/runtime-dir.js`, `scripts/lib/runtime.sh`, `runner/options.js`, `runner/remote-identity.js`, `scripts/status.js`, `status-vbox.js`, `demo.sh`, `server/startup-checks.js` |
| **RUN03e** Binding and uniform adoption | L | `bindings.json` (R6), offline restore with a placeholder client, resync by the binding for every runner, grace for every runner (`start.sh`: `--runner-grace 0` unless given), `session.delete` for unknown or dropped sessions, forced-loss route | restart of the server with a local and a remote runner keeps both runners' machines and consoles; an unknown session is deleted; a lost `bindings.json` deletes sessions on return; no new session can be opened for a user whose bound runner is only offline; `users.log` events unchanged | `server/session-manager.js`, new `server/session-bindings.js`, `server/runner-client.js`, `server/serve.js`, `routes/admin-runners.js`, `scripts/start.sh` |
| **RUN03f** CREMI and documentation | S | Units, `qwctl.sh`, `deploy-cremi.md`, `cremi-architecture.md`, `architecture.md` (the "5c" paragraphs on `local`, `trusted`, shared files, Unix socket), `deployment.md` (remove "Files shared with the runner"), `reference.md`, `test/tests.md` | no mention of "shared with the runner", "trusted runner" or the runner socket remains (grep) | `deploy/cremi/*`, `docs/*`, `test/tests.md` |

Order: a, b, c, d, e, f. a and b are independent; c needs b; d needs c; e needs a and b. Tests are rewritten **with** the task that breaks them.

### 3.3 Tests

| Test | Why it changes | Task |
|---|---|---|
| `test/unit/session-manager.test.js` | aliases, `sharesRuntime`, rmSync, pruning, adoption by hello owner disappear | a, e |
| `test/unit/runtime-restart.test.js` | `ServerInstance` live sessions, pruning and the stale-socket probe (`leaveStaleSocket`, line 60) go; pruning tests move to the runner | a, c |
| `test/unit/runner-gateway.test.js` | the Unix gateway is deleted | c |
| `test/unit/session-adoption.test.js`, `remote-sessions.test.js` | adoption by binding for every runner; grace for the local runner | e |
| `test/unit/admin-runners.test.js` | summaries without `local`, pause/revoke/forget for `local` | b |
| `test/unit/remote-gateway.test.js`, `runner-store`-related tests | id pattern `local`, `tokenHash` rule, schema 2 | b |
| `test/unit/server-startup-report.test.js` | no "Runner socket" row, no `--connect`, `serverSocket`; new `--local-runner`, `--token-file` | c |
| `test/unit/runtime-dir.test.js` | no `runner-65535.sock` (line 133), new names, budget only for runners, 32-character login | c, d |
| `test/unit/status-vbox.test.js`, status tests | pairing by port (line 42 uses a `runner-3002.sock` argument) | d |
| `test/integration/check-runner.js` | socket assertions (`:96-98`) and server-port directory become WebSocket, token file, runner directory | c, d |
| `test/integration/check-runner-manual.js` | spawns the runner with `--connect` (`:83`), asserts the socket mode and removal (`:126,210`) and "no alias" (`:146-148,183`) | c, a |
| `test/integration/check-load-start.js`, `admin.js` | find processes by `<default runtime>/sessions/<id>` | d |
| `test/integration/check-runner-remote.js` | extend: server restart keeps the remote runner's session | e |

New tests: runner pruning, aliases and `runner.pid` lock (a); the `local` record and the refused unknown id (b); token file creation, reuse, loss and 0600 mode, `--token-file` default, the 401 exit status 78, missing-file retry,
token absent from `ps` (c); defaults within the budget (d); `bindings.json` read, write, lost, stale; the offline restore blocks `open()`; forced loss (e); a real-browser check of console re-selection after a runner returns
(PST01 item). Per `AGENTS.md`, **none is run without the user's approval.**

### 3.4 Documentation

`architecture.md` (ownership table, "Runners in the control plane", "Connection lifecycle" 1 and 6, "Runner loss", "User-land runners", "Remote runners"), `deployment.md` (adoption, files shared, crash, remote runners, layout),
`deploy-cremi.md` and `cremi-architecture.md`, `reference.md` and the `--help` of the two programs (`--runtime`, `--local-runner`, `--token-file`, `--port`), `test/tests.md`.

### 3.5 Event x outcome (the bridge to PST01)

"Today" is read from the code (grace 300 s as at the CREMI; the local runner has no grace). "Design" is C with PST01 policies **not** chosen (machines are never restored after a runner process dies).

| Event | Local runner today | Remote runner today | Both, with the design |
|---|---|---|---|
| **Server restart** (runner alive) | Sessions adopted by the hello's `owner`; users log in again and keep machines. Under `start.sh` the runner exits with the server | Sessions of the hello are **deleted** on the runner: the VMs die | Bindings loaded offline, bound to the runner at its hello (2 s to 30 s later), same for both; the token file persists so the runner reconnects with the same token; under `start.sh` the runner still exits with the server |
| **Runner process restart** | Sessions dropped at once, directories removed by the server | Offline for the grace; the hello lacks them: dropped; directories left | Offline until the runner returns (hello without them: dropped at once) or until the grace ends; the runner prunes its empty directories at start; non-empty ones stay (PST01) |
| **Machine reboot** (`/tmp` default) | All lost | Runner side lost; the server forgot everything | Both directories lost together: a clean start, a new token file. With `--runtime` on disk (CREMI): bindings and token file are kept, the hello lacks the sessions, they are dropped (`session-deleted: runner lost`); disks stay until PST01 |
| **Network cut** | n/a (Unix socket) | Offline for the grace (503), VMs keep running, resync at return | Same for every runner (for the local one it is a loopback connection: only a server or runner crash cuts it) |
| **Runner revoked** | Refused (403) | Token invalid, connection closed, sessions kept for the grace, the runner stops itself | Same for both (the local runner exits 78, systemd does not restart it); forced loss and drop-at-once are PST01 controls (R7) |
| **Token file lost** | n/a | n/a (the runner file holds the token) | The runner waits ("token file missing"); a server restart recreates it; the runner reconnects and its sessions are adopted |

## 4. Open questions for the user

**Decided:** Q1 (option C) and Q2 (the local runner registers with a token and uses the WebSocket path, no Unix socket for the runner link).

| # | Question | Recommendation and why |
|---|---|---|
| Q3 | The owner of an adopted session comes from the server's `bindings.json`, never from the hello. A lost file means the sessions are deleted at the next hello. Accept? | **Yes**: the trust then does not depend on who sent the hello (SEC03). |
| Q4 | `users/<login>` aliases: kept by the runner (recommended), or dropped (owner only in `meta.json`, shown by `status.sh`)? | **Kept by the runner**: no change of habit, no server involvement. |
| Q5 | A runner killed hard leaves non-empty session directories: kept until PST01, or deleted at the runner's next start after checking no process uses them? | **Kept until PST01**; `cleanall.sh` removes them. |
| Q6 | Grace for the local runner: the same 300 s (a stopped local runner shows "offline" instead of a new empty session at once), `start.sh` with `--runner-grace 0`? | **Uniform grace, `--runner-grace 0` in `start.sh`.** |
| Q7 | Revoking a runner: drop its sessions at once or keep them for the grace? Forced-loss route in RUN03e or left to PST01? | **Drop at once**, **route in RUN03e** (same function). |
| Q8 | Directory names: server `<port>`, local runner `l-<port>`, remote `r-<6 hex>` (runner names at most 8 characters, within 49 bytes). OK? | **Yes.** |
| Q9 | A **one-time breaking change** at the CREMI (two directories, new runner unit, old `/var/lib/qemuweb` content deleted, `runners.json` v2)? | **Yes** (beta rules), with the next release notes. |
| Q10 | Order: RUN03 (a to f) before PST01? | **Yes**: PST01's persistence is RUN03e's `bindings.json`. |
| Q11 | Option name and default: `--local-runner` on the server, **off** by default (a server with only remote runners then has no `local` record)? And is the token file name `local-runner.token` in the server directory fine? | **Yes to both**; `start.sh`, `demo.sh` and the CREMI unit pass it. |
| Q12 | The one-time registration token of `runner.sh register --token TOKEN` is visible in `ps` for 15 minutes: add `--token-file` / stdin (small, outside RUN03)? | **Yes, as a small task** after RUN03c, for the same rule "no secret on a command line". |
| Q13 | A dedicated exit status (78) when a runner is refused (revoked), with `RestartPreventExitStatus=78` in the unit, so systemd does not loop? | **Yes**: otherwise a revoked runner restarts every few seconds. |
| Q14 | The credential file `local-runner.token` is written by the server in **its** directory and read by the runner: accepted as the one file that crosses (a credential hand-off, not a runner file)? | **Yes**: the alternative (an administrator copying a secret by hand, (b)) adds a manual step and a second code path. |

### What could not be verified

- Nothing was run (no tests, no application, no `prepare.sh`), per `AGENTS.md`.
- That Apache and nginx reach the server from 127.0.0.1 is read from `deploy/cremi/*.conf` and `docs/deployment.md` and from `server.listen(port, '127.0.0.1')`, not observed.
- The behaviour of the CREMI units after the change (permissions between the two `qemuweb` directories, start order, `RestartPreventExitStatus`) is by reading the unit files and systemd semantics, not tried.
- The exact assertions to rewrite in the unit tests are known only when the tasks start.
