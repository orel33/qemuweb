# Codex work rules

## Delegated development tasks

When the user asks to assign a development task to an agent, use a **Codex task visible in the task list** with an isolated worktree. Name a new task `qemuweb - task XXXYY`, replacing `XXXYY` with its stable TODO code (for example, `qemuweb - task GTS16`). Reuse the named existing task if the user specifies one. The user must be able to open that task, follow its progress, and send it instructions directly. Use the Codex task/thread tools for this; an internal sub-agent is not a substitute for a visible task.

Give the task the TODO code, concrete acceptance criteria, the target branch or worktree, and the integration boundary. Verify that the new task appears in the Codex task list, then report its title and status to the user. If a visible task cannot be created, say so instead of silently starting an internal sub-agent.

Internal sub-agents may be used only when the user explicitly requests internal delegation or parallel agent work. They do not replace a requested user-controlled Codex task.

## Orchestrator and implementation agent

Use agent-initiated progress notifications instead of active status polling. When delegating, give the implementation agent the orchestrator's Codex thread ID and ask it to send meaningful milestone reports, blockers, and its final handoff directly through `codex_tui.send_message_to_thread`. The orchestrator reviews incoming reports and informs the user at the agreed milestones. Avoid repetitive messages without new information. If cross-task messaging is unavailable, report that limitation rather than promising automatic notifications.

The agent in the main conversation is the **orchestrator**. It defines the task with the user, starts or resumes the visible Codex task, monitors its progress, passes on user corrections, and asks the implementation agent to resolve problems found during review. It checks the implementation diff and relevant test results itself. Keep the user informed of meaningful progress and blockers.

For each delegated task, report progress to the user at **25%, 50%, 75%, and 100%**, with a short explanation of what is complete, what remains, and any blocker. Base each milestone on inspected worktree changes and verification results, not merely on the agent's estimate or elapsed time. Define task-specific milestones when delegating; if scope changes, update the estimate and explain why. Do not claim 100% until the implementation agent's deliverable has been reviewed and its required checks pass. This 100% report means the task is ready for the user's integration decision; integration into `main` is a separate step requiring the user's explicit agreement. Report material blockers promptly even between milestones. Avoid frequent status polling: let the implementation agent work autonomously and check its reports or completion at meaningful milestones.

The implementation agent works only in its assigned worktree and branch. It delivers code, tests, documentation, a concise change summary, and verification results to the orchestrator. It must not edit the main checkout, merge into `main`, push `main`, or create a release tag. Any task-branch commit or push must follow the scope given in its task prompt.

**The orchestrator alone performs final integration into `main`, and only after the user explicitly agrees to that integration.** Before asking for that agreement, the orchestrator must finish its review, arrange required fixes, run or inspect the relevant checks, and present the concrete changes, remaining limitations, and exact integration action for approval. After approval, the orchestrator integrates, resolves conflicts, verifies the result, and handles any authorized commit, push, or tag. The implementation agent never performs this final integration.
