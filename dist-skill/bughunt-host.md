---
name: bughunt
description: Exhaustive autonomous bug hunting for local web apps. Discovers routes/components, drives them via a stealth browser, classifies findings, clusters duplicates, and (optionally) auto-fixes per cluster via architect→coder sub-agents. Use when the user asks to find bugs, regress-test, sweep before shipping, or "fix the bugs from the latest run".
---

# Bug-hunting stack on this host

Three local services collaborate to do this:

| Component | Repo | Build | Role |
|---|---|---|---|
| **BugHunter** | `/root/BugHunter` | `packages/cli/dist/cli/main.js` (binary name `bughunter`) | Driver — discovers surface, plans tests, mutates inputs, classifies + clusters bugs, orchestrates fixes |
| **SurfaceMCP** | `/root/SurfaceMCP` | `dist/cli/main.js` (binary name `surfacemcp`) | Per-project MCP that exposes the app's API/page surface to BugHunter. Each project gets its own pm2 instance on an auto-allocated port in 3102–3199 |
| **camofox-mcp** | `/root/camofox-mcp` | dual transport, HTTP daemon `camofox-mcp-http` on **`127.0.0.1:3104`** | Browser MCP — wraps the camofox stealth-browser REST API at `:9377`. Single shared instance for all projects |

Optional sidecar: **ClaudeMCP** on `127.0.0.1:3101` — only relevant if BugHunter is invoked by a non-Claude orchestrator. From a Claude Code session you do NOT need ClaudeMCP — fixes are spawned as `Agent(subagent_type=…)` sub-agents directly.

## Verifying the stack is up

```bash
pm2 list | grep -E "(camofox-mcp-http|surfacemcp-)"
curl -sS http://127.0.0.1:3104/health   # → {"ok":true,"camofoxReachable":true}
```

If `camofox-mcp-http` is missing, start it from `/root/camofox-mcp` (`pm2 start ecosystem.config.cjs`). If the underlying stealth browser at `:9377` is down, the camofox-mcp `/health` returns `camofoxReachable:false` — fix that first; bug hunting is impossible without a browser.

# Setting up bug hunting for a new project

The user identifies a project by its working directory (e.g. `/root/spoonworks`, `/root/dash`). All commands below run from inside that directory.

## Step 1 — install the BugHunter CLI globally if not already

```bash
which bughunter || (cd /root/BugHunter && NODE_ENV=development npm install && npm --workspace packages/cli run build && npm --workspace packages/cli link)
which surfacemcp || (cd /root/SurfaceMCP && NODE_ENV=development npm install && npm run build && npm link)
```

The `NODE_ENV=development` prefix is mandatory: pm2's daemon inherits `NODE_ENV=production` and `npm ci` silently skips devDeps under that, breaking the build. (Discovered the hard way during the SurfaceMCP and camofox-mcp setups.)

## Step 2 — initialize SurfaceMCP for the project

```bash
cd <project>
surfacemcp init                      # interactive — auto-detects stack
pm2 start ~/.config/surfacemcp/ecosystem.<project>.cjs   # or run `surfacemcp serve` under pm2 manually
```

Note the assigned port (echoed by `serve`; also visible via `pm2 describe surfacemcp-<project>`). Auth defaults you'll be asked about:

- **Auth.js / NextAuth**: `auth.kind: "nextauth"`. The cookie name is auto-detected (v5 → `authjs.session-token`, v4 → `next-auth.session-token`, both with `__Secure-` variants).
- **Owner login**: pre-login form post; password env var (e.g. `SPOONWORKS_OWNER_PASSWORD`). If the env var is unset, fall back to `auth.kind: "none"` for unauthenticated coverage only.
- **Bearer / API key / form**: also supported; see `/root/SurfaceMCP/SPEC.md` § auth.

## Step 3 — initialize BugHunter for the project

```bash
cd <project>
bughunter init
```

Key inputs:

| Field | Value |
|---|---|
| `surfaceMcpUrl` | `http://127.0.0.1:<surfacemcp_port>` — **base URL only, do NOT include `/mcp`** (the adapter strips trailing `/mcp` for backward-compat but new configs should be the bare base) |
| `browserMcpUrl` | `http://127.0.0.1:3104/mcp` — full endpoint, **including `/mcp`**. The browser adapter does not append it (asymmetric with surfaceMcpUrl — convention is undocumented in SPEC § 3.4.5; until fixed, use the full URL) |
| `roles` | List the auth roles to test as (e.g. `owner`, `customer`, `anon`) |
| `forbiddenPaths` | Schema migrations, lockfiles, `.env*` — the post-hoc gate hard-resets fixes that touch these |

This writes `.bughunter/config.json`. Runs land under `.bughunter/runs/<runId>/`.

## Step 4 — first run

```bash
bughunter run --max-bugs 5 --max-runtime 600000 --concurrency 2 --api-concurrency 4
```

Use a small `--max-bugs` for the first run — it shakes out auth + browser plumbing without burning hours. Once you see clean output, drop the cap (`bughunter run` defaults to a long budget).

# Running BugHunter (for a project that's already initialized)

```bash
bughunter run                              # full run from current project directory
bughunter run --route "/admin/**" --role owner   # scoped
bughunter run --budget 3600000             # time-boxed (1 hour)
bughunter run --resume <runId>             # resume a paused run
bughunter list                             # last 20 runs
bughunter status <runId>                   # detailed state
bughunter inspect <clusterId|occurrenceId> # drill in
bughunter replay <occurrenceId>            # re-run the exact steps that triggered it
bughunter palette                          # show active mutation palette
bughunter prune                            # delete runs older than 30 days
```

## Interpreting `bugs.jsonl`

Each line in `.bughunter/runs/<runId>/bugs.jsonl` is a **cluster** (deduped occurrences). When summarizing for the user:

1. Group by `kind`. `network_5xx`, `unhandled_exception`, and `react_error` are usually higher severity than `console_error` or `accessibility_critical`.
2. Rank by `clusterSize` — bigger cluster = more pages/roles affected.
3. Always cite the cluster `id` so the user can `bughunter inspect <id>`.
4. Skip `thirdPartyOrGenerated: true` clusters from the user-facing summary — they are not actionable.

Example summary:

```
Found 3 actionable clusters:
- [bug-abc123] react_error (×7): TypeError in ProductList.tsx — products.map called on undefined
- [bug-def456] network_5xx (×3): POST /api/orders returns 500
- [bug-ghi789] missing_state_change (×1): Edit button on /admin/users produces no visible change
```

`infrastructure.jsonl` is **not bugs** — it is browser MCP crashes, SurfaceMCP timeouts, and camofox errors. Mention the count briefly ("3 infrastructure failures — not app bugs"), do not list them as findings.

# /bughunt fix — auto-fix orchestration

When the user says `/bughunt fix`, "fix the bugs from the latest run", or similar, follow the **canonical orchestration spec** at:

```
/root/BugHunter/packages/cli/bughunt.md
```

That document defines the per-cluster loop (architect spec via `Agent(subagent_type='architect', model='opus')` → coder implementation via `Agent(subagent_type='coder', model='sonnet')` → forbidden-path gate → retest), the brief templates, the `fix-state.json` schema, and the variable substitution table. Read it first; do not re-derive.

Two helper commands the orchestration uses:

```bash
bughunter forbidden-path-gate <branch> --base <baseBranch> --reset
bughunter retest <runId> <clusterId> --base <baseBranch> --branch <branch>
bughunter fix-summary <runId>
```

# Common gotchas

- **`/mcp/mcp` URL bug**: older configs put `surfaceMcpUrl: "http://.../mcp"` and the adapter then appended `/mcp` again. New configs use the bare base; the adapter strips trailing `/mcp` for backward-compat. Same convention applies to `browserMcpUrl`.
- **Dynamic routes need `discoveryFixtures`**: routes like `/api/admin/batches/:id` will return 404 for any synthetic id and produce false-positive `surface_call_failed` clusters. Configure `discoveryFixtures` in `surfacemcp.config.json` with valid IDs from the dev DB before running BugHunter.
- **Schema probe gap on `unknown`-confidence routes**: routes that don't use Zod for input validation get `inputSchemaConfidence: unknown` at discovery; `surface_probe` upgrades them to `inferred` but often misses required fields. Use `BugHunterConfig.bodyFixtures` to supplement happy-palette bodies for these routes.
- **SurfaceMCP local `main` may be stale**: if you see an older revision on local `main`, run the resync runbook at `/root/BugHunter/docs/RUNBOOKS.md`.
- **NODE_ENV=production under pm2**: as noted above — always `NODE_ENV=development` for `npm ci` / `npm install` during setup.
- **Auth cookie naming**: SurfaceMCP auto-detects Auth.js v5 vs v4. If detection fails, set `auth.cookieName` explicitly in `.surfacemcp/config.json`.
- **Server actions**: Next.js server actions cannot be POSTed as plain HTTP — BugHunter excludes `isServerAction: true` tools from the API direct-call test plan.
- **Cluster artifact retention**: capped to first-3 + last-1 occurrences per cluster, 4GB total per run, to keep disk usage bounded on long sweeps.
