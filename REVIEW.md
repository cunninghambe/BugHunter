# BugHunter — architect review pass

The original SPEC.md was reviewed by an independent Opus architect agent (`@architect` subagent type, fresh context) on 2026-04-25, after the SurfaceMCP review revisions had landed. The review surfaced **6 blockers, 12 concerns, 12 open questions**. This file records the resolution table — what changed in SPEC.md and why.

---

## Blockers (all resolved)

| # | Issue | Resolution in SPEC v0.1 |
|---|---|---|
| 1 | "Exhaustive" math infeasible at "<1h Spoonworks" — 30,000+ tests / 4 concurrency / 7.5s avg = 16h floor | Kept "exhaustive" framing per author intent ("exhaustive is the point"), but at the level of distinct interaction patterns. Same-shape element collapsing in §3.4 (signature: tag + role-attr + type-attr + data-testid prefix + ancestor stack). Same-shape forms collapse across pages. Default `--max-runtime` raised to 24h. Plan phase emits a budget calculator. Dropped the "<1h Spoonworks" acceptance criterion |
| 2 | SPA route discovery via `<a href>` walk misses Next.js dynamic routes, modal-only routes, parallel/intercepted routes | Three-source discovery in §3.3: (a) SurfaceMCP catalog → infer UI page patterns, (b) AST scan of `app/**/page.tsx` for filesystem-routed pages, (c) DOM walker per page for elements. Dynamic routes require `discoveryFixtures` config. Parallel/intercepted/modal routes explicitly out of scope v0.1, documented |
| 3 | Per-occurrence Playwright/SurfaceMCP repro script generation is vapor — thousands of generated scripts with rotting selectors | Scoped down: emit one structured JSON action log per occurrence + a single canonical `bughunter replay <occurrenceId>` command that drives the engine at run-time. No template explosion, no rotting selectors. Playwright code emission deferred to v0.2 |
| 4 | Auto-fix's "code-only" gate doesn't exist in ClaudeMCP — relies on a feature in another project that isn't even on its roadmap | BugHunter implements the gate post-hoc. After each per-cluster ClaudeMCP job ends: `git diff <baseBranch>..<branch> --name-only`, check against `forbiddenPaths` (prisma/migrations/, prisma/schema.prisma, package.json, package-lock.json, .env*, .gitignore, migrations/, alembic/, .next/, node_modules/, dist/, build/, plus user-configurable). If forbidden path touched: hard-reset branch, mark `bugs_skipped: touched_forbidden_path` |
| 5 | State drift between tests unresolved; `resetCommand` field exists but no policy | Explicit `resetPolicy: 'transactional' \| 'per-test' \| 'per-page' \| 'per-run'`. Default `per-page`. `transactional` recommended where supported (DB rollback, much faster). Documented with a comparison table in §3.10 |
| 6 | ClaudeMCP per-project serial + 4h prompt-for-everything is the iterative-degradation antipattern from CLAUDE.md | Per-cluster dispatch in §3.9: one `claude_run` job per cluster (or per small batch by overlapping `suspectedFiles`). Serializes naturally through ClaudeMCP's per-project queue. Per-cluster timeout 1h. Each fix gets fresh context |

## Concerns (all addressed)

| # | Concern | Resolution |
|---|---|---|
| 1 | `inputSchemaConfidence` / `surface_probe` / `surface_sample_inputs` not wired into BugHunter behavior | §3.4.1 added: pre-plan schema enrichment. Every `unknown`-confidence tool gets a `surface_probe` call in the plan phase; every tool gets `surface_sample_inputs` to seed `happy`-palette values |
| 2 | Auto-fix retest with hot-reloaded surface — `pinRevision` semantics undefined | §3.9 step 3: post-fix, refresh SurfaceMCP catalog. `toolId` removed → `verified_fixed_by_removal`. `inputSchema` changed → re-derive mutation, replay. Else replay verbatim. Distinguishes `partially_verified` if lightweight-occurrence inputs aren't cached |
| 3 | Stack trace fingerprinting will over- or under-cluster | §3.6 normalization spec: strip line numbers entirely; prefer non-`node_modules` / non-`webpack-internal` / non-`react-dom` user-code frames; `messageHash` (first 80 chars normalized: numeric ids stripped, quoted strings stripped, hex/uuid stripped) as co-key. Unit test fixture with 10 known stacks asserting expected cluster count |
| 4 | `missing_state_change` 5s window wrong for fast and slow apps | §3.5: `MutationObserver` from action-fire to (URL change OR network completion OR 30s ceiling). Network-completion is the primary boundary, not wall clock |
| 5 | `accessibility_critical` will dominate the report | Gated behind `--a11y` flag, off by default. When enabled: delta-only (violations introduced by the action vs pre-state baseline) |
| 6 | Browser MCP failure modes (slow, malformed, mid-test crash) | §3.8.1: per-test browser-MCP errors retry once with fresh context, then mark `infrastructure_failure` (not bug; written to `infrastructure.jsonl`). After 20 consecutive infra failures: abort run with explicit error |
| 7 | Login rate-limit collision during BugHunter runs | §3.4.3: all negative-test palette calls (anything other than `happy` palette in mutation tests) go via SurfaceMCP with `noAutoRelogin: true`. Auto-relogin only fires for happy-path 401s |
| 8 | `external` side-effect class respect is API-side only; UI side fires through anyway | §3.3 step 4 + §3.5: cross-reference forms/buttons to API tools via `surface_routes_for_page`. If resolved tool is `external` and `externalIntegrationsAllowed: false`, element added to skip-list. Unresolved cross-reference → skip-by-default with warning |
| 9 | `X-Surface-Origin` header set by SurfaceMCP; BugHunter doesn't set its UI-side analog | §3.3: BugHunter sets `X-BugHunter-Run: <runId>` via camofox extra-headers on every browser request. `extraHeaders` config option for project-specific markers |
| 10 | Skill+CLI+MCP three-package split is overkill; the skill in the spec was a 50-line alias | Two packages now: `cli` (engine + skill markdown) and optional `mcp` (HTTP wrapper). Skill is a single `bughunt.md` file in `packages/cli/` mounted by target projects via symlink |
| 11 | Cluster size > 50 with all occurrences keeping full artifacts blows up to 10GB+ JSONL | §3.7: full artifacts on first 3 + last 1 occurrences per cluster; rest are lightweight summaries. Total artifact budget per run capped at 4 GB; oldest degrade to summaries on overflow. `bughunter inspect` re-fetches on demand |
| 12 | Resume semantics fragile when world has changed since pause | §3.2 / §3.10 / §3.8: validity check on resume includes SurfaceMCP `revision` compare + resetCommand last-run timestamp + run-config hash. Refuses to resume if any differ unless `--force-resume` |

## Nits (all accepted)

- email "out_of_bounds" simplified to non-email-shape (dropped invalid 60-underscore example)
- Palette extended: `tel`, `url`, `password`, `color`, `range`, `slug`, `foreign_id`
- `slug` / `foreign_id` happy values come from `surface_sample_inputs`, then `domainHints` config, else skip with warning
- `network_4xx_unexpected` now keys on `expectedOutcome` from the test plan record
- `responseBodyShape` defined per content-type (JSON top-level keys / HTML pre/title text / hash)
- `firstSeenAt` / `lastSeenAt` defined as min / max of occurrence timestamps
- `bughunter open` removed; `bughunter inspect` works headless
- `gitnexus_impact` reference made conditional in auto-fix prompt
- Separate `concurrency` (browser, 4) vs `apiConcurrency` (16)
- Artifact paths rooted at `.bughunter/runs/<runId>/`
- In-flight tests after 200-cluster cap append to existing clusters; never create a 201st
- Browser MCP committed to **camofox** (already deployed); playwright is internal dep for context APIs camofox doesn't surface
- `playwright vs camofox` fork-in-the-road removed

## Open questions resolved

| # | Question | Decision |
|---|---|---|
| 1 | Exhaustive or budgeted? | Exhaustive at the level of distinct interaction patterns + budget calculator + `--budget` flag |
| 2 | SPA modal/parallel/intercepted routes in v0.1? | **Out of scope.** User must surface via fixtures or `discoveryHints` |
| 3 | Default `resetPolicy`? | **`per-page`.** `transactional` recommended where supported |
| 4 | One ClaudeMCP job per cluster vs one for all? | **Per cluster** |
| 5 | `surface_probe` in discover or plan phase? | **Plan phase** (probe sends real POSTs; discover stays read-only) |
| 6 | Retest: replay literal inputs or regenerate? | **Regenerate** if revision differs and inputSchema changed; else replay verbatim |
| 7 | Skill value vs alias? | **Markdown only**, not a package. Lives in `packages/cli/bughunt.md` |
| 8 | `node_modules` / generated suspectedFiles? | **`bugs_skipped: third_party_or_generated`** flag set in cluster output |
| 9 | Bug-log retention? | **30-day rotation** of `.bughunter/runs/<id>/`, matching ClaudeMCP. `bughunter prune` command |
| 10 | Partial-run + auto-fix retest scoping? | **Apply same filters** (route pattern, role) to retest |
| 11 | Trust `surface_routes_for_page`? | **Yes**, with fallback to BugHunter's own URL-string scan if SurfaceMCP returns nothing |
| 12 | Code-only gate authoritative source? | **BugHunter post-hoc on `git diff`** (covered in Blocker 4) |

## Praise (preserved in revision)

- **Stable `toolId` for clustering** — rename-resilient, matches SurfaceMCP design
- **`sideEffectClass: external` opt-in gating** — kept; now extended to UI side via cross-reference
- **Cluster-with-occurrences shape** — preserved; bounded full-artifact retention is the only adjustment
- **Re-test after fix as the verification gate** — kept; now revision-aware
- **`resetCommand` config field** — kept; now backed by an explicit `resetPolicy`
- **Stop-and-emit at 200 clusters** — kept; in-flight policy clarified
- **JSONL output as primary** — kept
- **Distinguishing `bugs_filed` / `bugs_attempted_fix` / `bugs_verified_fixed` / `bugs_persistent` / `bugs_skipped`** — kept; added `partially_verified` and `bugs_lost_to_revision`
- **`--strict` to disable flake-downgrade** — kept
- **Fixture-based acceptance with deliberate bug** — kept
