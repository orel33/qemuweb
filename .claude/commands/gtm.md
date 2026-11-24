---
description: go tests & merge — run the tests on a finished task branch merged with main, then merge it locally into main
argument-hint: [task code or branch, e.g. PRP02 or task/prp02]
---

The user typed `/gtm $ARGUMENTS`: this is his explicit order, for THIS run only, to run the tests and merge into the local `main`. It is not an order to push or tag, and not a standing approval.

Target: `$ARGUMENTS` (a task code such as `PRP02` or a branch such as `task/prp02`). With no argument, the target is every `task/*` branch that is ahead of `main` and whose session is `done` or `idle` (see `claude agents`); a branch whose session is still working is skipped and named.

For each target, in this order:

1. **Check it is finished.** `git log --oneline main..<branch>`, `claude agents --json` (state `done`/`idle`). If the session is still working, say so and stop for that branch.
2. **Tests on an export**, never in the worktree: `git worktree add --detach /tmp/qwt-<code> <branch>`, link `node_modules` from the main checkout, `git merge --no-edit main`, then `./scripts/run-tests.sh unit` and, when the diff touches `server/`, `runner/` or `scripts/start.sh`-like scripts, the integration tests named in `test/tests.md` for that area (`check-runner`, `check-runner-manual`, `admin`). Never `check-load-start` or any test that starts QEMU/VirtualBox without being asked. Keep the log in `$CLAUDE_JOB_DIR/tmp`.
3. **If something fails**: read the failure, decide whether it is a fixture/test mistake or a product bug, send the exact failing list and the log path to the task's session with `SendMessage` (with `notify_when_idle: true`, and ask for a short report with the commit id), then rerun when it is idle. Do not merge on red. A failure that also happens on `main` is reported as pre-existing, not blamed on the branch.
4. **If green**: `git merge --no-ff <branch> -m "Merge <branch>: <what it does>"` in the main checkout (local only), stop the session (`claude stop <id>`), remove the worktree and delete the branch (`git branch -d`), remove `/tmp/qwt-<code>`.
5. **Report, in French, factual and short**: tests run and counts, what was fixed, the merge commit, what the user tries by hand on `main`, what is unpushed (`git status -sb`). Never push, never tag, never bump a version: wait for his explicit "pousse" / "tag X".

Announce each step's outcome as it finishes (tests started, tests green or red, merged); never go silent while waiting.
