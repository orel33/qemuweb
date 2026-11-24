---
description: push main to both remotes (gitubx and origin), without any tag
argument-hint: (none)
---

The user typed `/push`: this is his explicit order, for THIS run only, to push the local `main` to both remotes. It is not an order to tag or to bump a version (those need an explicit "tag X").

1. In the main checkout, show `git status -sb` and `git log --oneline origin/main..main`. If the working tree has changes to tracked files, or HEAD is not on `main`, stop and say so.
2. Push with `git push gitubx main` then `git push origin main` (never `--force`, never `--tags`, never another branch). If a push is rejected (the remote has commits that are not in `main`), stop and report it: do not rebase or force on your own.
3. Report, in French, factual and short: the range pushed on each remote (`old..new`), the new HEAD, and that no tag was created. If the server of the CREMI needs the update, remind the one command: `cd /srv/qemuweb && git pull --tags && ./deploy/cremi/qwctl.sh restart` (it stops the machines).
