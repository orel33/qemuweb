# Agent work rules

These rules apply to every coding agent working on this project, including
Codex and Claude Code. Claude Code loads them through `CLAUDE.md`.

## Documentation archive

`docs/bak/` contains superseded Markdown files kept only for reference. Ignore
these files when searching for current instructions or project documentation,
and do not use them as task context unless the user explicitly asks to consult
the archive. Use `README.md` and `docs/architecture.md` for current
documentation.

## Vocabulary

- **Session**: the workspace (nodes, engine, `runtime/sessions/<id>/`). The
  server holds one session today.
- **Node**: an element of a session, either a **host** (virtual machine) or a
  **switch** (VDE). Code, API routes and Socket.IO events use `node` and
  `nodeId`, never `session`, for a single host or switch.

## Language

- **Project content is in English**: code, code comments, documentation, GUI
  text, commit messages, task prompts, and test output. Translate existing
  French text when editing it.
- **Conversation with the user is in French**: answers, questions, progress
  reports, and review summaries.

## Delegated development tasks

When the user asks to assign a development task to an agent, create a
**user-visible task** with an isolated worktree and branch. The user must be
able to open that task, follow its progress, and send it instructions directly.

- **Codex**: use a Codex task visible in the task list, created with the Codex
  task/thread tools.
- **Claude Code**: start a real, interactive **background session**, never the
  internal `Agent` tool (a sub-agent does not appear in `claude agents` or
  `/tasks`, so the user cannot open it). Roadmap milestones are always delegated
  this way. Procedure:
  1. Create a dedicated worktree and task branch from the **local** `main`
     HEAD, not from `origin/main`, for example
     `git worktree add .claude/worktrees/<name> -b task/<slug> main`.
     Do not name the branch like a release tag (for example `v0.9.0-beta.2`).
  2. From that worktree, launch the session with the prompt:
     `claude --bg -n "qemuweb - task XXXYY" --permission-mode auto "<prompt>"`.
  3. Check it with `claude agents`, then report its title and status together
     with `claude attach <id>`, `claude logs <id>` and `claude stop <id>`.
  4. Tell the session the orchestrator's session name so that it can reach it
     with `SendMessage` (see `claude agents`).

Name a new task `qemuweb - task XXXYY`, replacing `XXXYY` with its stable TODO
code (for example, `qemuweb - task GTS16`). Reuse the named existing task if
the user specifies one.

Give the task the TODO code, concrete acceptance criteria, the target branch or
worktree, and the integration boundary. Verify that the new task is visible to
the user, then report its title and status. If a visible task cannot be
created, say so instead of silently starting a hidden sub-agent.

Internal sub-agents (not user-controllable) may be used only when the user
explicitly requests internal delegation or parallel agent work. They do not
replace a requested user-visible task, and are never used for a roadmap
milestone or any other task the user wants to follow.

## Orchestrator and implementation agent

The agent in the main conversation is the **orchestrator**. It defines the task
with the user, starts or resumes the visible task, monitors its progress,
passes on user corrections, and asks the implementation agent to resolve
problems found during review. It checks the implementation diff and any
authorized test results itself. Keep the user informed of meaningful progress
and blockers.

Use agent-initiated progress notifications instead of active status polling.
When delegating, tell the implementation agent how to reach the orchestrator
(Codex: the orchestrator's thread ID and `codex_tui.send_message_to_thread`;
Claude Code: its message channel back to the orchestrator) and ask it to send
meaningful milestone reports, blockers, and its final handoff. Avoid repetitive
messages without new information. If cross-task messaging is unavailable,
report that limitation rather than promising automatic notifications.

For each delegated task, report progress to the user at **25%, 50%, 75%, and
100%**, with a short explanation of what is complete, what remains, and any
blocker. Base each milestone on inspected worktree changes and authorized
verification results, not on the agent's estimate or elapsed time. Define
task-specific milestones when delegating; if scope changes, update the estimate
and explain why. Do not claim 100% until the deliverable has been reviewed and
any checks authorized by the user pass. The 100% report means the task is ready
for the user's integration decision. Report material blockers promptly, even
between milestones.

The implementation agent works only in its assigned worktree and branch. It
delivers code, tests, documentation, a concise change summary, and verification
results to the orchestrator. It must not edit the main checkout, merge into
`main`, push `main`, or create a release tag. Any task-branch commit or push
must follow the scope given in its task prompt.

**The orchestrator alone performs final integration into `main`, and only after
the user explicitly agrees to it.** Before asking, the orchestrator finishes its
review, arranges required fixes, runs or inspects checks authorized by the user,
and presents the concrete changes, remaining limitations, and exact integration
action. After approval, it integrates, resolves conflicts, verifies the result
within the user's test authorization, and handles any authorized commit, push,
or tag.

Integration of a finished task or milestone is done together with the user, in
this order:

1. The orchestrator merges the task branch into `main` **locally** (no push, no
   tag) and tells the user the checkout is on `main` and ready.
2. The user tests the Web interface manually on `main` (for example with
   `./scripts/run-tests.sh web`), not inside the task worktree.
3. Only when the user explicitly confirms that this manual test passed, the
   orchestrator bumps the version, creates the annotated tag and pushes `main`
   and the tag. Never treat an ambiguous message as that confirmation: ask.

The same goes for any release tag: a tag is pushed only after step 3.

## Tests

Before running unit or integration tests, ask the user and wait for explicit
approval. This applies to the orchestrator and to any implementation agent. At
the end of a development task, propose the specific test commands (see
`test/TESTS.md` and `./scripts/run-tests.sh --list`) and let the user choose
whether the agent runs them or the user validates the Web interface manually.
A request to implement, review, commit, push, or integrate is not permission to
run tests. If tests are declined or not yet approved, report that they were not
run and continue with work that does not depend on test execution.

The user alone gives the order to run tests and to integrate. There is no
standing or per-milestone approval: an earlier approval covers only the
commands it named, and an agent never runs tests, or starts the application
to check a change, on its own initiative. Static checks (`node --check`,
`bash -n`, a lint) are not tests and may be run freely. Implementation agents
ask the orchestrator, which asks the user.
