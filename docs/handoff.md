# Handoff: resuming the orchestration on another machine

How to put a new Claude session in the role of **orchestrator** of this project, and what a new machine needs.
The plan itself is in [roadmap](roadmap.md); the rules of work are in `AGENTS.md`, which Claude Code loads through
`CLAUDE.md`. This file only holds what neither of them says: the prompt to paste, what is not in Git, and a checklist.

## Prompt to paste

Paste this at the start of the new session, in a Claude Code opened in the repository (`~/Documents/qemuweb` or the
clone you made):

````text
You take over as ORCHESTRATOR of the QemuWeb project (this repository, branch main): a web application for network
labs (QEMU/KVM or VirtualBox machines linked by VDE switches, serial consoles relayed to the browser), made of a
server and runners, deployed at the CREMI behind Apache and OpenID. I am Aurélien, a teacher. Answer me in French;
the project content (code, docs, commits, GUI text) stays in English.

1. Read, in this order: AGENTS.md; docs/roadmap.md (the single plan: "Where we are", "Order of the work", "Backlog",
   "Decisions made"); docs/synthese-roadmap.md (the same for decision makers, in French); docs/development.md. Then
   run `git log --oneline -15` and `git status -sb`.
2. State: the last published version is in `git tag --sort=-creatordate | head -3`; main may hold work not yet
   released, listed at the end of "Where we are". What comes next is the priority list and milestones 6 to 10 of the
   roadmap; the decisions waiting for me are in the table "Décisions attendues" of the synthesis.
3. How you work is in AGENTS.md; in short: important tasks go to visible sessions (`claude --bg -n "qemuweb - task
   CODE" --permission-mode auto`) in a worktree made from the LOCAL main; you review the diff with static checks only;
   you never run a test or start the application without my explicit order; you merge into the local main only when I
   agree; a tag or a push only when I ask. The repository has two commands for this: `/gtm CODE` (tests on an export,
   then the local merge) and `/push` (main to both remotes, never a tag).
4. First move: summarise the state in ten lines, then ask me what I want to do. Do not propose or start anything
   before that.
````

## Where things are

| What | Where |
| --- | --- |
| The plan, tasks and their codes, decisions, backlog | `docs/roadmap.md`; the French summary for decision makers in `docs/synthese-roadmap.md` |
| Rules of work for agents | `AGENTS.md`; the commands `/gtm` and `/push` in `.claude/commands/` |
| Code layout, tests, how documents and PDFs are built | `docs/development.md`, `test/tests.md`, `./scripts/run-tests.sh --list`, `make docs` |
| Install, options, running a server and a runner | `docs/install.md`, `docs/reference.md`, `docs/run-commands.md`, `docs/deployment.md` |
| Runner model, JSON files, data paths | `docs/runner-model.md`, `docs/json-files.md`, `docs/architecture.md` |
| The CREMI deployment (Apache, OpenID, upgrade procedure) | `deploy/cremi/deploy-cremi.md`, `deploy/cremi/cremi-architecture.md` |
| The systemd services (install, control, templates) | `scripts/qwctl.sh`, `deploy/systemd/`, `docs/deployment.md` |
| Step-by-step test of a remote runner | `docs/remote-runner-test.md` |

## What is not in Git

On the new machine, recreate or copy these (all ignored by Git, on purpose):

| Item | What to do |
| --- | --- |
| `users.json` | `./scripts/user.sh add <login>` (mode 0600) |
| `runners.json` | do not copy it: register the runners again with a new token |
| `.env.local` | the path of QEMU on that machine, if it is not in `PATH` |
| `images/` and `sources/` | `bash scripts/prepare.sh --system alpine` (the quick one), or copy them with `rsync` |
| `logs/`, `runtime/` | nothing: they are rebuilt |
| `deploy/cremi/progsys.conf` and the OpenID secrets | stay on the CREMI server, never committed |
| `node_modules/` | `npm ci` |

On the Claude side, outside the repository, in `~/.claude/` of the old machine:

| Item | Use | Copy |
| --- | --- | --- |
| `~/.claude/tools/` | the task briefs `*-prompt.md`, the common rules `gen-common.md` used as their header, and the lint configurations `undef.json` and `undef-browser.json` of the static checks | `rsync -av ~/.claude/tools/ NEW:~/.claude/tools/` |
| `~/.claude/projects/-home-orel-Documents-qemuweb/memory/` | the memory of the orchestrator (workflow, tests only on order, pointers) | `rsync -av` the same folder; the folder name encodes the path of the repository, so the path must be the same on the new machine, otherwise rename the folder |

Without them the new session still works: `AGENTS.md` and the roadmap carry the rules. It only has to rewrite the briefs
(a past brief in `~/.claude/tools/` is a good model for a new one) and the lint command.

## New machine checklist

1. `git clone git@github.com:orel33/qemuweb.git`, then add the second remote that `/push` uses:
   `git remote add gitubx <url>` (the URL is in your notes: it is not recorded in the repository).
2. Prerequisites and `npm ci`: see [install](install.md) (Node.js 24, QEMU with VDE, `vde2`, `genisoimage`, `python3`,
   membership of the `kvm` group). For the PDFs: `sudo apt install pandoc` and Chrome.
3. An image, an account, a check: `bash scripts/prepare.sh --system alpine`, `./scripts/user.sh add <login>`,
   then `./scripts/start.sh` and a browser on <http://127.0.0.1:3002> (only when you decide to start the application).
4. Copy `~/.claude/tools/` and the memory folder if you want them (see above), open Claude Code in the repository and
   paste the prompt.

## Before closing a session

- `git status -sb` is clean and `main` is pushed (`/push`); tags are pushed when you asked for them.
- No `task/*` branch, worktree (`git worktree list`) or session (`claude agents`) is left by mistake: finish or clean
  up the ones that are done; name the ones that are still running.
- What was noticed along the way is in the **Backlog** of `docs/roadmap.md`, or in the milestone it belongs to.
