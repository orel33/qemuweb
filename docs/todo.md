# QemuWeb TODO

Side tasks, features and bug fixes that are not milestones of the
[0.9.0 roadmap](roadmap-v0.9.0.md). The roadmap is the plan; this list collects what comes up
along the way. Add an entry when something is noticed, remove it when it is done (the commit
message says what changed). Keep each entry to a few lines: what, why, and an idea if there is one.

## Bugs and rough edges

- **Switch consoles toggle in observation**: the user reports that the "switch consoles" button is
  not greyed out when the view is driven (Follow checked, or owner under admin control), although it
  carries the `view-control` class. Not reproduced by reading the code; find the exact case.
- **Followed Monitor view**: a `monitor` view received before the node data says Monitor is
  supported falls back to the console and is not applied again later.
- **Test harness kill fallback**: after 12 s the harness kills only `start.sh`; the server and the
  runner, in their own sessions, could survive a hung stop (`test/integration/qemuweb-client.js`).
- **Clear notes**: the lines written to the Log view by Clear have no timestamp.

- **Scripts on a custom runtime directory**: `status.sh`, `killall.sh` and `cleanall.sh` only know the
  default `runtime/` (their paths are written in several places). With `--runtime /var/lib/qemuweb`
  they do not see that directory. Add a `--runtime DIR` option to each, like `start.sh` and `stop.sh`.
- **start.sh with refused arguments**: when the server refuses its options and exits at once, the script
  must report the server's status and exit with it (read, never run): check it by hand
  (`./scripts/start.sh --session-hours 0` must exit 2 at once and leave nothing running).

- **Runner with an unreadable config.json**: it still prints `✓ config.json  0 systems` after the
  `Cannot read the system catalog` error line. It should print a ✗ and abort.
- **start.sh message**: when the server refuses its options and exits at once, it prints "The server
  exited (status 2); stopping the runner." although no runner was started.

## Console and terminal

- **Clear: shell prompt detection** (`public/terminal.js`, `clearPaneConsole`). The guard that
  decides whether `stty rows N cols M` may be typed is a heuristic on the cursor line (trimmed line
  ends with `#`, `$`, `%` or `>`, cursor at the end). Not covered: prompts ending otherwise (`]`,
  `:`, `λ`, zsh symbols), long prompts wrapping over several rows (untested); false positives in
  REPLs whose prompt ends with `>` or `$` (python, sqlite, ssh). Ideas: extract a pure function with
  a unit test over many prompts; or let the guest announce its prompt (`PS1` in `prepare.sh`).
- **Disabled view controls**: no tooltip tells why a control is greyed out (view driven by the
  owner or by the controlling admin).

## Documentation

- The user manual (`docs/bak/manual.md`, archived) is out of date: serial ports, `start.sh`,
  runner commands, Follow. Decide where the current manual lives (README, `docs/`, PDF).

## Ideas

- More `config.json` warnings at startup (beyond the engine, KVM and serial port checks).
- A runner per student, on the student's machine (needs an untrusted runner model: the control plane
  validates everything it receives). See the roadmap, milestone 5.
