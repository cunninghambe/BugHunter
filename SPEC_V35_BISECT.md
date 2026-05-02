# SPEC — v0.35 "git bisect — find the introducing commit"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Predecessor:** `SPEC_PATH_TO_EXHAUSTIVE.md` § 4.2 (`bughunter bisect`), § 9 Phase D leftover · **Depends on:** v0.27 cross-run history (`bugIdentity` is the stable handle a bisect resolves), v0.19 race-rerun infrastructure (consensus voting / flake control), v0.6 replay engine (the per-commit observation primitive).

This spec wires `bughunter bisect <bug-id>` — the last command from Phase D of the path-to-exhaustive roadmap that has remained unscoped. Today, when a bug is found, the user knows it exists in the current working tree but has no automated way to locate the commit that introduced it. v0.35 closes that gap by using `git bisect run` to drive a binary search across a commit range, where each commit is checked out in an isolated worktree, the project is built, the captured action log is replayed, and the bug-presence signal is reported back to git. The output is the exact commit SHA that introduced the bug plus the action log that reproduces it.

The implementation is bounded: ~600-800 lines of code, no new run-time deps (uses native `git` + Node `child_process`), and reuses three existing primitives — V27's `bugIdentity` resolution, V6's `replayActionLog`, V19's consensus-voting flake mitigation. The new code is the bisect orchestrator (one CLI command + worktree manager + per-commit script), not new detection.

---

## 1. Objective

Add `bughunter bisect <bug-id> [--commit-range <a..b>]` so that, given a bug already captured by a prior run, the user can answer in one command: **which commit introduced this bug?**

| Question | Answered by |
|---|---|
| At which commit did this bug first appear? | `bisect` final report: introducing-commit SHA, author, date, subject |
| What action log reproduces it? | `bisect` cites the occurrenceId it replayed |
| Was the bug already present at the start of the search range? | Pre-flight check on `<a>` exits before bisecting |
| Did the build break partway through the bisect? | Per-commit "skip" with diagnostic; bisect continues |
| Is the bug actually flaky? | Per-commit consensus voting (default 2-of-3); flaky-on-good-commit aborts the bisect with diagnostic |

**In scope (V35):**
- New CLI command `bughunter bisect <bug-id> [options]`.
- `<bug-id>` resolution: accepts a V27 `bugIdentity` (16-hex), a per-run cluster `id` (cuid), or an `occurrenceId`. Resolved via `history.db` + filesystem lookup. Picks the *most recent* action-log occurrence belonging to the cluster as the replay target.
- Default commit range: last 30 commits on the current branch (`HEAD~30..HEAD`).
- Worktree cycling: each test commit is checked out in a fresh `.bughunter/bisect-wt/` worktree, isolated from the user's current working tree.
- Config-aware build: `bisect.buildCommand` from `.bughunter/config.json` (e.g. `"npm ci && npm run build"`); falls back to a no-op if the project is interpreted (no build step required).
- Config-aware app launch: `bisect.appCommand` (e.g. `"npm run dev"`) starts the app; bisect waits for `appBaseUrl` to respond on `/` (200/3xx/4xx OK; only ECONNREFUSED is "not ready"), with a configurable timeout (default 60s).
- Replay observation: `replayActionLog` runs against the launched app; bisect inspects the result for the bug signal (per § 4.4).
- `git bisect run` integration: bisect emits a per-commit script whose exit code is the contract git needs (0 = good, 1 = bad, 125 = skip). Bisect *drives* git, not the other way around.
- Flake mitigation: each commit's verdict is computed by replaying N times (default 3) and taking majority vote. 1-of-3 = downgraded to "skip" with `flaky_on_commit` diagnostic.
- Build-failure tolerance: a commit whose build fails reports exit 125 (git-bisect-skip), bisect continues binary search excluding that commit. Skipped commits are listed in the final report.
- SurfaceMCP revision-aware retest pattern (V27 § 4.x): if the app's `surfacemcp.config.json` toolset signature differs between commits and the action log references a tool that no longer exists, the commit is skipped with `surface_revision_changed`.
- Final output: introducing commit SHA, author, date, subject; the path to the action log; replay summary at the introducing commit; full bisect log at `.bughunter/bisect-runs/<bisectId>/log.json`.

**Out of scope (deferred):**
- Auto-bisect across **multiple bugs** in one invocation. v0.35 = one bug, one bisect. Batching is V36+.
- Cross-branch / cross-repo bisect (e.g., bisect across a merge commit's two parents). v0.35 follows the linear `--first-parent` view of the range.
- Bisecting *fixes* (the inverse: when did this bug get fixed?). Easy follow-up — git bisect's `good`/`bad` semantics swap. v0.36.
- Auto-installing dependencies that didn't exist at the historical commit (e.g., `pnpm@9` when the commit was on `pnpm@7`). User installs the right tooling; bisect runs whatever the commit's lockfile says.
- Speeding up via reused build artifacts ("ccache for `npm run build`"). v0.36 — possible via `.bughunter/bisect-runs/<bisectId>/build-cache/<sha>/dist/` keyed by tree-hash.
- Bisecting against **staging** (a remote app instance). Bisect launches *local* dev servers per commit; staging is one fixed deployment, not bisectable.
- Database migrations between commits. If schema state changes mid-range and the action log assumes the new schema, all "good" commits will skip with `replay_setup_failed`. Document; mitigate via `bisect.seedHooks` config that runs migration setup per-commit.
- IDE / TUI integration. CLI-first; v0.36 surfaces in MCP.

**Acceptance target on a synthetic fixture (`fixtures/bisect-demo/`):**
A small Express + React app committed across 12 commits; commit `7` deliberately introduces a `dom_error_text` bug; commits `8-12` carry the bug; commits `1-6` are clean.
1. After `bughunter run` flags the bug at HEAD, `bughunter bisect <bug-id>` reports introducing commit = `7`.
2. The bisect log shows a logarithmic search (≤4 commits tested for 12-commit range; `ceil(log2(12)) = 4`).
3. If commit `5` has a deliberate build break, bisect reports it skipped, identifies commit `7` correctly.
4. If commit `7` has an additional `package.json` change that makes its `npm run build` break alongside the bug introduction, bisect surfaces "introducing commit unknown — earliest reproducible commit is `8`" and lists `7` as `skipped: build_failed`.
5. With `--consensus 1` and a flaky bug seeded at commit `7`, bisect's per-commit re-runs disambiguate; flaky-finding-on-known-good aborts with diagnostic.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/repro/replay.ts:44-95` | `replayActionLog` is the per-commit observation primitive. **DO NOT MODIFY.** Bisect calls it; the result shape (`ReplayResult`) is the input to the bug-signal classifier. |
| `packages/cli/src/repro/action-log.ts:1-47` | Action log shape. Bisect resolves a `<bug-id>` to one `ActionLog` and feeds it into `replayActionLog`. |
| `packages/cli/src/cli/replay.ts:1-53` | Existing `bughunter replay` CLI command. Mirror its pattern for the per-commit `bughunter bisect-step` subcommand (§ 4.6) — single occurrence, single observation. |
| `packages/cli/src/store/history.ts` (V27) | `history.db` access. **READ-ONLY** from bisect: queries the DB to resolve `<bug-id>` → most-recent occurrence's `runId` + `occurrenceId`. Does NOT write rows during bisect (bisect is observe-only, not a "run"). |
| `packages/cli/src/types.ts:197-218` | `BugCluster.bugIdentity` (V27). Bisect's primary input. |
| `packages/cli/src/cluster/signature.ts` | Signature stability — used by V27 and re-confirmed here: a bug's signature is the contract that lets us identify "the same bug" at an old commit. |
| `packages/cli/src/cli/main.ts:79-220` | CLI dispatch. **ADD** `bisect` and (private) `bisect-step` cases; **EXTEND** `USAGE`. |
| `packages/cli/src/config.ts` | `BugHunterConfig` Zod schema. **ADD** an optional `bisect?: BisectConfig` field. |
| `packages/cli/src/store/filesystem.ts` | Run-paths helpers. **ADD** `bisectRunPaths(projectDir, bisectId)` returning the `.bughunter/bisect-runs/<bisectId>/` layout. |
| `packages/cli/src/security/race-detectors.ts` | V19 consensus-voting helper (`runWithConsensus(fn, runs, threshold)`). **REUSE** directly — same shape as bisect's flake mitigation. |
| `packages/cli/src/log.ts` | Logger. Bisect emits structured JSON lines for each commit visited. |

### 2.2 Patterns to follow

- **`git bisect run` is the orchestrator, not us.** We invoke `git bisect start`, `git bisect bad <HEAD>`, `git bisect good <a>`, `git bisect run <our-script>`, parse the final stdout. Git owns the binary-search algorithm. We own the per-commit verdict.
- **The bisect script is a child invocation of our own CLI.** `bughunter bisect-step --bug-id <id> --bisect-id <bid>` is a private subcommand (not in `USAGE`) that runs against `process.cwd()` (which git has set to the worktree's HEAD), exits 0/1/125, and writes one line to `<bisectId>/log.json`. This guarantees bisect-step uses the same code (replay engine, config loader, history.db) as the parent — no duplication.
- **Worktree per bisect, not per commit.** `git worktree add .bughunter/bisect-wt/<bisectId>` once at start; git's bisect mutates the worktree's HEAD across commits, but the directory is constant. Cleanup at end. (`git worktree remove --force` on success and on any failure path.)
- **Process isolation for the app server.** Each commit's app server is spawned via `child_process.spawn(buildCmd, { cwd: worktreeDir, detached: false })`; bisect tracks the PID, waits for the port, runs replay, kills via `tree-kill` (single-line dep alternative: kill the process group — `process.kill(-pid)` on Linux/macOS). On bisect end, kill any survivors.
- **Discriminated-union `BisectVerdict`.** `{ kind: 'good' } | { kind: 'bad'; signal: BugSignal } | { kind: 'skip'; reason: SkipReason }`. Drives the exit-code mapping (0 / 1 / 125) via exhaustive switch.
- **One JSON log line per commit.** Append-only `log.json`: `{ ts, sha, verdict, durationMs, signal?, skipReason?, consensusVotes? }`. The final report reads this back to summarize.
- **Reuse V19 consensus.** `runWithConsensus(replay, runs=3, threshold=2)` returns `{ verdict, votes }`. Threshold-not-met → skip with `flaky_on_commit`.
- **Resolve `<bug-id>` once at start.** The action log is loaded from the user's *current* worktree before bisect begins, copied to `.bughunter/bisect-runs/<bisectId>/action-log.json`. The bisect script reads from the bisect-runs directory, NOT from the worktree's runs/ — historical commits don't have the action log on disk.

### 2.3 DO NOT

- Do **not** mutate the user's working tree. All git operations target `.bughunter/bisect-wt/<bisectId>`. The user's `git status` is unchanged before and after `bughunter bisect`.
- Do **not** require the user to clean their working tree. Bisect runs in a worktree, so dirty state is fine. Document this as a feature.
- Do **not** invoke `git bisect` from inside the user's worktree path — git refuses to bisect when there's a bisect already running. Always pass `-C <worktreeDir>` to git invocations.
- Do **not** parse `git bisect run`'s output to determine the introducing commit. Use `git -C <wt> bisect log | tail` and structured `git rev-parse refs/bisect/bad` once the bisect terminates.
- Do **not** re-run the **detection** pipeline at each commit. Detection is heavy and unnecessary; replay against the running app is sufficient. If replay can't observe the bug at the historical commit (different DOM shape, missing route), that's a `skip` with `replay_setup_failed`, not a "good".
- Do **not** keep build artifacts across worktrees. Each commit's `node_modules/dist` lives in the bisect worktree and is discarded at end. (The build-cache optimization is V36 future work.)
- Do **not** kill processes by name (`pkill node`). Kill by PID/PGID tracked at spawn time. Killing by name will eat the user's other Node processes.
- Do **not** auto-detect the build command. If `bisect.buildCommand` is missing, prompt with a clear error referencing the config key. Heuristics here cause silent skip-storms.
- Do **not** shell out via `exec` with user-supplied strings unescaped. Use `spawn(cmd, args)` with `shell: false` where possible; when shell is required, document the shell-injection trust boundary (the user's own config).
- Do **not** assume `git bisect run` exit codes are reliable for "skip vs good vs bad". Some git versions handle 125 inconsistently. We bound: 0 = good, 1 = bad, 125 = skip; anything else (signal death, OOM) = skip with `unexpected_exit`.
- Do **not** swallow stderr from the build/app/replay processes. Tee to `.bughunter/bisect-runs/<bisectId>/commits/<sha>/{build.log,app.log,replay.log}` for postmortem.

---

## 3. Algorithm

### 3.1 High-level flow

```
1. Resolve <bug-id> → (bugIdentity, runId, occurrenceId, actionLog)         [bughunter side]
2. Validate commit range → (good = a, bad = HEAD or b)                       [bughunter side]
3. Pre-flight at HEAD/b:    replay → must reproduce ("bad" sanity)           [bughunter side]
4. Pre-flight at a (good):  replay → must NOT reproduce ("good" sanity)
   - If it DOES reproduce: range is bad-only; extend range, abort with
     diagnostic "extend --commit-range further back".
5. Create worktree at .bughunter/bisect-wt/<bisectId>
6. Copy action log + build/app config snapshot to .bughunter/bisect-runs/<bisectId>/
7. git -C <wt> bisect start
8. git -C <wt> bisect bad <bad-sha>
9. git -C <wt> bisect good <good-sha>
10. git -C <wt> bisect run bughunter bisect-step --bug-id <id> --bisect-id <bid>
11. Parse final state: git -C <wt> rev-parse refs/bisect/bad
12. Resolve introducing commit (the first BAD after the last GOOD):
    git -C <wt> bisect log → parse → determine the commit `git bisect`
    declared as the first-bad commit.
13. git -C <wt> bisect reset
14. git worktree remove --force <wt>
15. Print final report
```

### 3.2 Per-commit script (`bughunter bisect-step`)

```
1. Read .bughunter/bisect-runs/<bisectId>/action-log.json (cached at start)
2. Read .bughunter/bisect-runs/<bisectId>/bisect-config.json (build/app cmds)
3. Verify the action log's referenced toolIds exist in the current commit's
   surfacemcp.config.json (if any); if not → exit 125 (skip, surface_revision_changed)
4. Run buildCommand in worktree; if exit != 0 → exit 125 (skip, build_failed)
5. Spawn appCommand; wait for appBaseUrl/ to respond (timeout); on timeout → kill, exit 125 (skip, app_start_timeout)
6. Run replayActionLog against the running app, repeated `consensusRuns` times (default 3)
7. Classify each replay result via § 4.4 (BugSignal: present/absent/inconclusive)
8. Compute consensus: ≥ ceil(consensusRuns/2) "present" → bad; ≥ same "absent" → good; else flaky
9. Kill app process group; clean port
10. Write log.json line (sha, verdict, votes, durationMs)
11. exit 0 (good) | 1 (bad) | 125 (skip / flaky)
```

### 3.3 Why `git bisect run` and not a hand-rolled binary search

- Git's bisect handles the `git bisect skip` accounting (when a commit is unreachable / skipped, git widens the search elegantly).
- Git's bisect persists state in `.git/BISECT_*` so a CTRL-C mid-run can be resumed (`bughunter bisect --resume`).
- Git's bisect supports `--first-parent` and other range hygiene flags we get for free.
- We control the per-commit verdict; that's the only thing we need to own. Reinventing binary search loses too much.

---

## 4. Specifications

### 4.1 `<bug-id>` resolution

A `<bug-id>` argument is one of:

| Format | Detection | Resolution |
|---|---|---|
| 16-hex `[0-9a-f]{16}` | regex match | V27 `bugIdentity` — query `history.db` for the most recent `clusters` row with this identity that has an action log on disk. |
| cuid `c[a-z0-9]{24,}` | regex match | Per-run cluster id — search recent runs' `bugs.jsonl` for `cluster.id === <bug-id>`, then pick the cluster's most recent occurrence with an action log. |
| occurrenceId | string match | Direct: a specific occurrence. Used when the user already knows which occurrence to replay. |

If multiple matches exist (typical for `bugIdentity`), pick the occurrence whose run is most recent AND whose action log is non-empty. Surface the picked occurrence's `runId` + `occurrenceId` to the user before bisecting.

If zero matches: error with diagnostics (`bughunter list` recommendation, `history.db` row count, search criteria).

### 4.2 Commit range resolution

| Input | Behavior |
|---|---|
| no `--commit-range` | `HEAD~30..HEAD` (configurable via `bisect.defaultRange`). |
| `--commit-range <a..b>` | Validated: `a` must be ancestor of `b` (`git merge-base --is-ancestor`); `b` defaults to HEAD if omitted (`<a>..HEAD`). |
| `--commit-range <a>..` | `<a>..HEAD`. |
| `--commit-range ..<b>` | `<b>~30..<b>`. |

If the range contains < 2 commits: error ("commit range must include at least 2 commits"). If the range is uncomputable (orphan branches, force-push damage): clear error.

Pre-flight (§ 3.1 step 3-4) gates:
- Bug must reproduce at the bad end (else: "bug not present at HEAD — current working tree may have already fixed it; check `git status`").
- Bug must NOT reproduce at the good end (else: "bug present at <a> too — extend `--commit-range` further back").

### 4.3 Per-commit build strategy

`.bughunter/config.json` adds:

```jsonc
{
  "bisect": {
    "buildCommand": "npm ci && npm run build",   // required if project has a build step
    "appCommand": "npm run dev",                  // command to start the app server
    "appReadyUrl": "http://localhost:3000/",      // override if different from appBaseUrl
    "appReadyTimeoutMs": 60000,                   // default 60s
    "buildTimeoutMs": 600000,                     // default 10min — historical npm install can be slow
    "consensusRuns": 3,                           // default 3 (per-commit replay count)
    "consensusThreshold": 2,                      // default ceil(consensusRuns/2)
    "defaultRange": "HEAD~30..HEAD",
    "killGracePeriodMs": 3000,                    // SIGTERM, then SIGKILL after grace
    "resetCommandsBetweenCommits": [              // optional: e.g., "rm -rf node_modules" if lockfile differs
      "rm -rf node_modules"
    ]
  }
}
```

**Worktree strategy:**
- One worktree per bisect (`bisect-wt/<bisectId>`), reused across commits.
- Each commit checkout: `git -C <wt> checkout <sha>` (driven by `git bisect`, not us).
- Per-commit build: run from `<wt>`; on build failure, log to `commits/<sha>/build.log`, exit 125.
- App start: from `<wt>`; PID tracked; killed at end of step.
- `node_modules` reuse: if `package-lock.json` is unchanged between consecutive commits, skip `npm ci` and reuse the previous commit's `node_modules`. Detect via `git -C <wt> diff --name-only HEAD@{1} HEAD -- package-lock.json`. (Optimization; spec'd minimal — `package-lock.json` only. v0.36 expands.)

**Build cache (deferred to v0.36):** keyed by tree-hash of `(package*.json, lockfile, src/**)`. Out of scope for V35; document as future work.

### 4.4 Bug-signal classifier

Given `replayActionLog` returns `ReplayResult { ok, observation: { finalUrl, consoleErrors, networkRequests, domSnapshot } }`, the bug-signal classifier must answer: **is the bug present at this commit?**

The classifier is **kind-aware**: each `BugKind` family has a different signal. V35 supports the kinds whose signal is observable from `ReplayResult` alone:

| Kind family | Signal extraction |
|---|---|
| `dom_error_text` | `observation.domSnapshot` contains the cluster's `errorText` (from the cluster's `rootCause` field, recorded in `bisect-runs/<bid>/cluster.json`). |
| `unhandled_exception` | `observation.consoleErrors` contains an entry whose normalized message matches the cluster's stored `signatureKey` substring. |
| `5xx_*`, `4xx_*` | `observation.networkRequests` contains an entry to the cluster's `endpoint` with a status matching the cluster's stored expectation. |
| `xss_*` | `observation.domSnapshot` contains the canary token recorded at detection time. |
| `axe_*`, `seo_*`, `security_header_*` | **Not directly replay-observable.** V35 SKIPS these kinds with diagnostic `bisect_unsupported_kind` + a list of supported kinds. (Future spec V36+: re-run the detection sub-pipeline per commit.) |
| `race_condition_*` | **Not deterministic enough for bisect.** V35 SKIPS with diagnostic `bisect_nondeterministic_kind`. |

**Classifier output:** `{ present: boolean; confidence: 'high'|'low'; reason: string }`. Bisect treats `present: true` (any confidence) as bad-vote, `present: false` (high confidence) as good-vote, `present: false` (low confidence) as inconclusive (counted toward neither; reduces effective consensus runs).

**Cluster snapshot:** at bisect start, the bug's full cluster (root cause, signatureKey, endpoint, errorText, etc.) is snapshotted to `bisect-runs/<bid>/cluster.json` so the per-commit step has stable comparison criteria. This is critical because the cluster row in `history.db` could change schema mid-bisect (it won't, but defensive).

### 4.5 Flake mitigation

Per § 2.2, V19's `runWithConsensus` is reused. Per-commit replay is run `consensusRuns` times (default 3). Verdict from votes:

| Votes (present-yes / present-no / inconclusive) | Verdict |
|---|---|
| ≥ threshold yes | bad |
| ≥ threshold no | good |
| Mixed below threshold | skip + `flaky_on_commit` |
| All inconclusive | skip + `replay_inconclusive` |

A flaky-on-commit at the **good** end of the range aborts the bisect with diagnostic ("the bug appears intermittently at the supposed-good commit; extend the range or use `--consensus 5` for more samples"). A flaky-on-commit mid-range is just a `skip` to git, which widens the search.

`--consensus <n>` and `--threshold <m>` flags override the config. `--strict` sets `consensus=1, threshold=1` (every replay is conclusive); use only when you have a deterministic-as-clockwork bug.

Inter-replay reset: between consensus replays at the same commit, the app server is **not** restarted (cost too high). Browser context is fresh per replay (`replayActionLog` already opens its own context). If the bug is *server-state-dependent* (e.g., a row inserted by replay 1 changes replay 2's outcome), document that V35's flake mitigation isn't sufficient — user uses `bisect.resetCommandsBetweenCommits` with a DB reset.

### 4.6 CLI surface

```
bughunter bisect <bug-id> [options]

Arguments:
  <bug-id>                        bugIdentity (16-hex), cluster id (cuid), or occurrenceId

Options:
  --commit-range <a..b>           default: HEAD~30..HEAD
  --consensus <n>                 default: 3
  --threshold <m>                 default: ceil(consensus/2)
  --strict                        equivalent to --consensus 1 --threshold 1
  --build-command <cmd>           overrides bisect.buildCommand from config
  --app-command <cmd>             overrides bisect.appCommand from config
  --resume                        resume the most recent in-progress bisect (reads .bughunter/bisect-runs/<latest>/state.json)
  --no-cleanup                    keep the worktree at .bughunter/bisect-wt/<bisectId> after completion (for debugging)
  --format json|text              default: text; json emits the final report as JSON
  --json-log                      stream per-commit JSON lines to stdout (for piping into a TUI)
  --quiet                         suppress per-commit progress; only the final report

Hidden subcommand (called by git bisect run, not by the user):
  bughunter bisect-step --bug-id <id> --bisect-id <bid>
```

Help group: under "cross-run / regression / history" alongside `bughunter diff`, `bughunter history`, `bughunter aging`.

### 4.7 Output format

Text format (default):

```
Bisecting bug abc123def456abcd ("dom_error_text on /products at owner role")
Action log: occurrenceId=ckxyz789... from runId=2026-04-29T15-30-00
Commit range: HEAD~30..HEAD (30 commits)
Pre-flight: HEAD reproduces (bad), HEAD~30 does not (good). OK.

Visiting f3a2b1c (5/30)... building... starting app... replaying x3... bad
Visiting d4e5f67 (5/15)... building... starting app... replaying x3... good
Visiting a1b2c3d (5/8)...  building... starting app... replaying x3... bad
Visiting 8e9f0a1 (5/4)...  build_failed (skip)
Visiting 7c6b5a4 (5/3)...  building... starting app... replaying x3... good
Visiting 6d5e4f3 (5/1)...  building... starting app... replaying x3... bad

==============================================================================
Introducing commit: 6d5e4f3
Author: Alex Chen <alex@example.com>
Date:   2026-04-25 14:32:11 -0400
Subject: refactor(products): centralize error handling

Action log replayed: ckxyz789...
Commits tested: 6 (skipped: 1)
Total time: 8m12s
Bisect log: .bughunter/bisect-runs/<bid>/log.json
==============================================================================
```

JSON format (`--format json`): the same data as a single object. Suitable for `bughunt_bisect` MCP tool downstream (V36).

---

## 5. Edge cases

### EC-1. Bug reproduces at the supposed-good end of the range
Pre-flight catches this. Bisect aborts with: `bug present at <good>; extend --commit-range further back, e.g. --commit-range HEAD~100..HEAD`.

### EC-2. Bug does NOT reproduce at the supposed-bad end (HEAD)
Pre-flight catches this. Aborts with: `bug not present at <bad>; the working tree may have already fixed it. Try replaying first: bughunter replay <occurrenceId>`.

### EC-3. Build fails at every commit in the range
Bisect terminates with `all commits skipped — build environment incompatible with historical commits`. Suggest investigating Node version, lockfile compatibility.

### EC-4. The action log references a route that didn't exist at older commits
Replay fails at navigate step (404, route not found). Classifier sees: domSnapshot doesn't match cluster errorText, no console error, no matching network request → `present: false, confidence: 'low'`. Counted as inconclusive; if all replays at commit are inconclusive, commit is skipped with `replay_setup_failed`. Bisect continues. If too many commits skip → bisect terminates with diagnostic.

### EC-5. The action log references a SurfaceMCP `toolId` that didn't exist at older commits
Detected at step start (§ 3.2 step 3) by reading the worktree's `surfacemcp.config.json`. Skip with `surface_revision_changed`. Document: bisect's range should not span SurfaceMCP toolset evolutions; user limits range or reverts to occurrence-replay only.

### EC-6. App fails to start within `appReadyTimeoutMs` at a commit
Skip with `app_start_timeout`. Tee app's stderr to `commits/<sha>/app.log` for postmortem. Common causes at historical commits: missing env vars (newer .env.example), missing migrations, port already in use.

### EC-7. Port conflict between consecutive commits
The app server may not release the port immediately after kill (TCP TIME_WAIT). Bisect waits up to 2s after kill before considering the port free; if still occupied, attempts to find an alternate port via `bisect.appPortRange` (default `3000-3010`). If no port is free, bisect aborts.

### EC-8. Two bisects run concurrently
`.bughunter/bisect-wt/` is namespaced by bisect ID; concurrent bisects use distinct worktrees. They do, however, share `.bughunter/config.json`. App ports must differ — bisect picks unique ports from `appPortRange`. Document.

### EC-9. CTRL-C mid-bisect
Bisect intercepts SIGINT; tries graceful cleanup: kill app, `git -C <wt> bisect reset`, leave worktree (in case `--resume`), persist state to `<bid>/state.json`. Re-running `bughunter bisect --resume` reattaches to the in-progress bisect.

### EC-10. The bug is at the FIRST commit in the range
`git bisect` correctly identifies the first commit when `<good>~..<bad>` is the operative range (the parent of `<good>` is the implicit "good" bound). If `<good>` itself is the introducing commit (which our pre-flight forbids), the user has misconfigured.

### EC-11. Force-pushed history mid-bisect
If the user force-pushes the branch while a bisect is running, the worktree's checkouts may break. Detected via `git -C <wt> rev-parse <sha>^{commit}` failing on the next commit. Bisect aborts with `history mutated mid-bisect`.

### EC-12. `bisect.appCommand` is a long-running daemon (e.g., docker compose up)
The app command is presumed to run in foreground until killed. If the user's command daemonizes, bisect's PID-tracking misses the actual server PID and the kill at end-of-step orphans the server. Document: `appCommand` MUST run in foreground (no `&`, no `detach`, no `nohup`). Add a sanity check: 5s after spawn, the tracked PID must still be running OR a child must be holding the port; if neither, abort with `appCommand_appears_to_have_daemonized`.

### EC-13. The bug is a flaky `race_condition_*` already
Per § 4.4 we skip race-condition kinds. Document: race-condition bugs need `bughunter bisect --consensus 5 --threshold 4` AND a deterministic seed (V32 — out of scope for V35); pre-V32 bisect of race kinds is a known limitation.

### EC-14. `node_modules` gets corrupted across commits
If the previous commit had different native deps (e.g. `better-sqlite3` v9 vs v11) and we reused `node_modules`, the app might crash at start. Detected via `app_start_timeout` skip. Document: configure `bisect.resetCommandsBetweenCommits: ["rm -rf node_modules"]` for projects with native-dep churn.

### EC-15. The bug's cluster row was deleted from `history.db` (V28 prune)
`<bug-id>` resolution falls back to scanning `bugs.jsonl` files on disk. If the bug isn't found anywhere, error.

---

## 6. Test plan

### 6.1 Unit tests

| File | Test |
|---|---|
| `packages/cli/src/cli/bisect/resolve-bug-id.test.ts` | bugIdentity / cuid / occurrenceId paths each resolve correctly; ambiguous → picks most recent; not-found → throws. |
| `packages/cli/src/cli/bisect/range.test.ts` | `--commit-range` parsing for all four forms; ancestor check; default range; orphan-branch error. |
| `packages/cli/src/cli/bisect/signal-classifier.test.ts` | Each kind family in § 4.4: present-yes / present-no / inconclusive paths against fabricated `ReplayResult`s. |
| `packages/cli/src/cli/bisect/consensus.test.ts` | Reuses V19's `runWithConsensus`; verifies bisect's threshold mapping (votes → verdict). |
| `packages/cli/src/cli/bisect/worktree.test.ts` | Worktree creation, cleanup, double-bisect-id collision (different bisects → different wts). Mocks `child_process`. |
| `packages/cli/src/cli/bisect/process-isolation.test.ts` | Kill-by-PGID; orphan-detection; port-release wait. Linux-only behavior gated. |

### 6.2 Integration tests

| Test | Setup | Expected |
|---|---|---|
| `fixtures/bisect-demo/` happy path | 12-commit fixture with bug introduced at commit 7 | bisect finds commit 7 in ≤ 4 visits. |
| Build break in range | Same fixture + commit 5 has broken build | bisect skips commit 5, finds commit 7. |
| Bug at HEAD only | Bug introduced at HEAD only | bisect reports `HEAD~1` is good and HEAD is bad — single commit. |
| Bug present at good end | Bug present at HEAD~30 too | pre-flight aborts with extend-range diagnostic. |
| `--resume` after CTRL-C | Mid-bisect SIGINT, then `bughunter bisect --resume` | Bisect resumes from saved state, completes correctly. |
| Concurrent bisects | Two `bughunter bisect` in parallel | Each completes; no port conflict; distinct worktrees. |

### 6.3 Manual smoke

On a real BugHunter project (TraiderJo or Aspectv3 once they have V27 history), pick a known cluster, run `bughunter bisect <bugIdentity>`, verify:
- A real introducing-commit SHA is reported.
- The commit's `git show` matches an intuitive cause for the bug.
- Total time < 30 minutes for a 30-commit range.

---

## 7. Negative requirements

- Do **not** mutate the user's working tree (§ 2.3).
- Do **not** require the user's working tree to be clean.
- Do **not** install dependencies globally; everything is per-worktree.
- Do **not** run any auto-fix at any commit. Bisect is observe-only.
- Do **not** write to `history.db` from the bisect path.
- Do **not** fall back to "any commit looks like a good guess" — if the binary search fails, surface the failure honestly.
- Do **not** run the full `bughunter run` pipeline at any commit. Replay-only.
- Do **not** support `--target staging` for bisect. Local-only.
- Do **not** auto-detect Node/pnpm/yarn version; fail loud if `buildCommand` doesn't match the historical lockfile's package manager.
- Do **not** make build success a hard gate ("if 50% of commits skip, abort") — let git bisect decide; widening on skips is git's job.

---

## 8. Files to touch

### Files to MODIFY
| File | Change |
|---|---|
| `packages/cli/src/cli/main.ts` | Add `bisect` and `bisect-step` cases + USAGE text. |
| `packages/cli/src/config.ts` | Add `BisectConfigSchema` to `BugHunterConfig`. |
| `packages/cli/src/store/filesystem.ts` | Add `bisectRunPaths(projectDir, bisectId)`. |
| `packages/cli/src/types.ts` | Add `BisectConfig` type, `BisectVerdict` discriminated union, `BugSignal` shape, `BisectRunSummary` shape. |

### Files to CREATE
| File | Purpose |
|---|---|
| `packages/cli/src/cli/bisect/bisect-cmd.ts` | Top-level CLI entry; orchestrates pre-flight, worktree, git bisect run, final report. |
| `packages/cli/src/cli/bisect/bisect-step.ts` | Hidden per-commit subcommand invoked by `git bisect run`. |
| `packages/cli/src/cli/bisect/resolve-bug-id.ts` | Resolves `<bug-id>` → action log + cluster snapshot. |
| `packages/cli/src/cli/bisect/range.ts` | Parses `--commit-range`; ancestor validation. |
| `packages/cli/src/cli/bisect/worktree.ts` | Worktree create/remove + `git -C` helpers. |
| `packages/cli/src/cli/bisect/process.ts` | App-process spawn / wait-for-port / kill-tree. |
| `packages/cli/src/cli/bisect/signal-classifier.ts` | Per-kind `ReplayResult` → `BugSignal`. |
| `packages/cli/src/cli/bisect/consensus.ts` | Thin wrapper around V19's `runWithConsensus` for bisect's verdict mapping. |
| `packages/cli/src/cli/bisect/log.ts` | Append-only JSON logger for `<bid>/log.json` + final report renderer. |
| `packages/cli/src/cli/bisect/state.ts` | Persist + restore for `--resume`. |
| `packages/cli/src/cli/bisect/*.test.ts` | Unit tests, mirroring V27 / V19 patterns. |
| `fixtures/bisect-demo/` | 12-commit fixture used in integration tests. |

### Files NOT to touch
- `packages/cli/src/repro/replay.ts` — unchanged; bisect is a consumer.
- `packages/cli/src/cluster/signature.ts` — unchanged.
- `packages/cli/src/store/history.ts` — read-only from bisect.
- `packages/cli/src/phases/*.ts` — unchanged; bisect doesn't run the pipeline.

---

## 9. Definition of Done

| Criterion | Verifier |
|---|---|
| `bughunter bisect <known-bug>` against `fixtures/bisect-demo/` finds the seeded introducing commit | integration test |
| Worktree is removed after bisect (success and failure) | integration test asserts directory absence |
| `git -C <user-cwd> status` is unchanged before/after bisect | integration test |
| Build-failure commit is skipped, not bad-voted | integration test with seeded broken commit |
| `--resume` reattaches to an in-progress bisect | integration test SIGINT + resume |
| All bisect-related unit tests pass | `npm test -- bisect` |
| `npx tsc --noEmit` clean | tsc |
| `npx eslint . --max-warnings 0` clean | eslint |
| `bughunter bisect --help` lists all options correctly | help-output snapshot test |
| `bughunter bisect <bug-id>` finishes in < 30min for 30-commit range on a small SPA | manual smoke |
| Concurrent bisects don't corrupt each other | integration test |
| CTRL-C cleans up worktree + bisect state, leaves resume marker | integration test |
| The introducing commit's SHA matches the seeded SHA in fixture metadata | integration test |
| `bughunter bisect-step` is hidden from `--help` output | help-output snapshot test |

---

## 10. Risks + escape hatches

- **Risk: historical commits don't build because Node version mismatch.** Mitigation: document `bisect.buildCommand` recommendation to use `nvm use $(cat .nvmrc) && npm ci && npm run build`. Bisect surfaces the build log path on every skip — root-cause is a cat-away.
- **Risk: native-dep churn corrupts `node_modules` across commits.** Mitigation: `bisect.resetCommandsBetweenCommits: ["rm -rf node_modules"]`. Slower but safer.
- **Risk: app commands that can't be killed cleanly leak processes.** Mitigation: PGID-based kill; orphan detection 30s after expected exit; pre-flight check that the spawned PID is alive 5s post-spawn.
- **Risk: replay produces different DOM at older commits because the SPA shape changed.** Mitigation: signal-classifier's `confidence: 'low'` paths skip rather than vote; if too many skips, bisect aborts honestly.
- **Risk: bisect time blows out (30 commits × 3 consensus × ~1min each = ~90 min).** Mitigation: `--consensus 1` for known-deterministic bugs; `node_modules` reuse when lockfile unchanged; document expected time.
- **Escape hatch:** `bughunter bisect-step --bug-id <id> --bisect-id <bid>` is callable manually at any worktree. Useful for debugging bisect at one specific commit without driving the full search.
- **Escape hatch:** `--no-cleanup` keeps the worktree for postmortem. User inspects the introducing commit's worktree state directly.

---

## 11. Killer-demo runbook

```bash
# 1. Prepare: ensure the bug is captured in the most recent run
cd /path/to/project
bughunter run
# Note a bugIdentity from summary.json or `bughunter list --format json`
BUG_ID=$(jq -r '.summary.bugClusters[0].bugIdentity' .bughunter/runs/$(ls -t .bughunter/runs | head -1)/summary.json)

# 2. Bisect
bughunter bisect $BUG_ID --commit-range HEAD~30..HEAD --consensus 3

# Expected: the command terminates with an introducing-commit SHA.
# 3. Inspect the introducing commit
git show $(jq -r '.introducingCommit.sha' .bughunter/bisect-runs/$(ls -t .bughunter/bisect-runs | head -1)/result.json)

# 4. Replay manually at that commit (sanity)
git worktree add /tmp/wt-bisect $INTRODUCING_SHA
cd /tmp/wt-bisect && npm ci && npm run build && npm run dev &
cd /path/to/project
bughunter replay <occurrenceId>
# Should observe the bug.

# 5. Cleanup
git worktree remove --force /tmp/wt-bisect
```

---

## 12. Open questions

1. **Should pre-flight at the good commit be optional?** Today: required. A user who's confident about the range pays a 1-extra-replay cost. Argument for optional: shaves a build cycle. Argument against: silently misleading bisects when the range is wrong. Lean: required by default, `--skip-preflight` flag for advanced users.

2. **Should `consensusRuns` default differ from V19's default?** V19 defaults to 3 for race conditions. Bisect inherits — but bisect costs more per consensus run (full build + app start). 3 may be overkill for non-flaky bugs. Lean: default 3, document `--consensus 1` is cheap for deterministic bugs.

3. **Should bisect log to `history.db`?** Today: no. Argument for yes: `bughunter history --bisect-history <bug-id>` would show every bisect run for a bug. Argument against: bisect is observe-only; mixing observation rows into the cluster history blurs the model. Defer to V36; track via `bisect-runs/` filesystem only for now.

4. **Should `--commit-range` accept symbolic refs (tags, branches)?** Today: yes (`HEAD`, `origin/main`, `v1.2.3` all work because git resolves them). Document.

5. **Should bisect support `--no-build` for interpreted projects (pure Python, plain Node)?** Today: omitting `bisect.buildCommand` is the no-build path. `--no-build` flag explicit for users who want clarity. Lean: add the flag; it sets `buildCommand: ''` semantically.

6. **Should we ship a `bughunter mcp bughunt_bisect` tool in V35 or defer to V36?** Per V31's pattern, write-side MCP tools shipped after CLI parity. Defer to V36 — bisect is long-running (minutes), MCP timeouts complicate the tool shape; needs a streaming/job-handle pattern.

7. **`--first-parent` or full ancestry?** Default: full ancestry (git default). Lean: add `--first-parent` flag for users who want to skip merge-commit alternates; document the tradeoff.

8. **How aggressive should the inconclusive→skip threshold be?** Today: all replays inconclusive → skip. Some replays inconclusive → reduce effective N. Lean: if ≥50% inconclusive, skip; below that, treat inconclusive replays as missing (compute consensus from remaining). Exact threshold tunable via `bisect.inconclusiveSkipFraction`.
