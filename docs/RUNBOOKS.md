# BugHunter Runbooks

Operational runbooks for recurring maintenance tasks.

---

## SurfaceMCP local main resync

Local `/root/SurfaceMCP/main` can fall behind `origin/main` after feature branches are merged remotely. Run this to fast-forward it:

```bash
cd /root/SurfaceMCP
git fetch origin
git checkout main
git merge --ff-only origin/main      # fast-forwards local main to latest
git log --oneline -3                 # verify expected HEAD commit is present

# Optional: prune the merged feature branch locally.
git branch -d feat/v0.1-implementation     # only if local feat tip == origin/main
```

After the merge, restart any locally-pinned pm2 processes that reference the `SurfaceMCP` codebase (typically `surfacemcp-web`):

```bash
pm2 restart surfacemcp-web
pm2 status
```
