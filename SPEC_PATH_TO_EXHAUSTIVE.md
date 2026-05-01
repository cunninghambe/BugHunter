# BugHunter — Path to Exhaustive & Comprehensive

**Status:** Draft 1 — strategic spec, not an implementation contract · **Author:** Opus, audit-driven · **Date:** 2026-05-01 · **Scope:** what would make BugHunter the most comprehensive bug-hunting tool for vibe coders in the world, defensibly.

This is a forward-looking gap analysis. It complements `SPEC_COMPREHENSIVE_ROADMAP.md` (which catalogs detection bug classes v0.5→v1.0) by focusing on the **three other axes** required for the "comprehensive" claim: surface (CLI + MCP), trust (verifiability + calibration), and cross-cutting capabilities (history, regressions, IDE, CI). Detection taxonomy here only adds what the comprehensive-roadmap underweighted.

Each phase below is independently shippable. The phases form a defensible "comprehensive" claim only when all three axes land — detection alone is not enough; programmability and trust matter equally.

---

## 1. Definition

"Exhaustive and comprehensive" decomposes into five testable claims:

1. **Detection coverage** — for every bug class the average vibe-coded SPA actually exhibits in production, BugHunter has a wired-and-running detector. Not a kind in a union; a working production code path.
2. **Surface programmability** — every operation BugHunter can do is reachable from both the CLI and an MCP tool. No headless agent should have to shell out to BugHunter to inspect a finding.
3. **Trust** — every claim BugHunter makes is reproducible by `bughunter replay`, comparable across runs by `bughunter diff`, suppressible with audit trail, and calibrated against a public benchmark with published precision/recall.
4. **Cross-time** — bugs persist across runs as identities, not as one-shot findings. New / persistent / fixed / regressed are all distinguishable.
5. **Cross-context** — BugHunter runs from the CLI, from a Claude Code session, from CI, from an MCP-driven agent, from a TUI, against local dev, against staging-read-only, against ephemeral preview environments. Same bug log shape, same replay primitive, same fix loop.

Today, BugHunter scores roughly:

| Axis | Score | Headline gap |
|---|---|---|
| Detection coverage | 60% — and 22/60 BugKinds were dead or detector-less on `main` before PR #53 | Web Workers, iframes, Web Components, service workers, push, geolocation, WebRTC, file-system, mobile gestures, drag/copy/paste, animation/transition state, multi-tab, multi-viewport, browser-zoom, print, dark/forced-colors |
| Surface programmability | 35% — 11 CLI commands, 4 MCP tools, no streaming, no diff, no triage, no detector list | No `bughunt diff`, no live-tail, no detector-coverage report, no suppression API, no IDE/TUI, no SARIF |
| Trust | 25% — no calibration, no benchmark, no determinism mode, ~37% of detectors don't fire on real targets | No deterministic clock/seed, no public deliberate-bug fixture, no precision/recall numbers, no self-test ("BugHunter on BugHunter") |
| Cross-time | 15% — runs are siloed, each emits bugs.jsonl with no awareness of prior runs | No cross-run identity, no `new vs persistent vs fixed vs regressed` bucketing, no aging, no bisect |
| Cross-context | 30% — CLI works, skill works, MCP works, but staging-read-only/CI/IDE/TUI are absent | No staging-safe mode, no CI templates, no GitHub Actions output, no IDE annotations, no TUI |

The claim "most comprehensive in the world" requires moving each axis above ~80%. This spec scopes the work to get there.

---

## 2. Current state — one paragraph

BugHunter v0.21 (this branch + V19/V21/V22 PRs in flight + camofox-mcp PRs in flight) covers ~60 declared `BugKind`s across security (XSS, IDOR, CSRF, JWT, pen-testing palette, header hygiene, dependency CVEs, secrets), performance (web vitals, long tasks, n+1, memory leak, bundle), accessibility (axe baseline + delta + keyboard trap), SEO hygiene, vision-driven layout/visual anomalies, race conditions, navigation-state corruption, and time/clock injection. The pipeline is `validate → discover → plan → execute → classify → cluster → emit` with optional auto-fix orchestrated by a Claude skill that dispatches `Agent(architect, opus) → Agent(coder, sonnet)` per cluster. Detail in `SPEC.md` and `SPEC_COMPREHENSIVE_ROADMAP.md`.

---

## 3. Detection coverage gaps the existing roadmap underweights

The comprehensive roadmap catalogs the major buckets. These are the under-discussed sub-classes.

### 3.1 Browser-platform surface

| Class | Common vibe-coded apps that exhibit it | Detection technique |
|---|---|---|
| Service worker stale cache | PWAs, offline-first apps, anything using Workbox | After update, force SW activation via `registration.update()`; verify clients claim new version; check stale data leak |
| Web Worker / Shared Worker errors | Compute-heavy apps, video editors | Capture worker `'error'` and `'messageerror'` events through CDP; treat as `unhandled_exception` family |
| iframe interactions | Embedded checkout (Stripe, etc.), oauth popups | Cross-origin postMessage handler validation; sandbox-attribute correctness; ancestor checks |
| Shadow DOM / Web Components | Component libraries, design-system-heavy apps | DOM-walker traverses `shadowRoot`; selector resolution descends shadow trees; a11y-tree audit per shadow |
| File System Access API | File editors, IDE-likes | Permission prompt handling, write-failure error states |
| Bluetooth / USB / WebSerial / WebHID | Hardware-integration apps | Permission-denied UX; device-disconnect mid-action |
| Geolocation / clipboard / notification permissions | Maps, share/copy buttons, alerting apps | Test with permission denied; verify graceful degradation, not error toast |
| Web Push / service-worker push | Notification systems | Subscription expiry; permission-revoked mid-session |
| WebRTC | Video chat, screen-share apps | ICE candidate failures, bandwidth degradation, peer-disconnect mid-call |
| WebSocket / SSE | Real-time dashboards, chat, live cursors | Disconnect-and-reconnect, message-order assumptions, backpressure under slow consumer (currently out of scope; partial via V20 network faults but no SSE/WS specifics) |
| HTTP/2 push, HTTP/3 quic-specific | Bleeding-edge frontend hosts | Stream-cancellation handling, multiplexing edge cases |
| Custom hash routing | Older SPAs, some Vue/Nuxt setups | Hash-only navigation that breaks when state changes hash; back-button behavior |
| Trusted Types CSP enforcement | Apps that opted in to Trusted Types | DOM XSS prevention; injection that should throw |
| SubResource Integrity violations | CDN-served apps | SRI hash mismatch should block load; verify failure handling |
| COOP / COEP isolation | Apps using SharedArrayBuffer | Cross-origin iframe failures when isolation is required |

**Implementation:** new module `packages/cli/src/discovery/browser-platform-probe.ts` runs a per-page audit during the existing DOM walk. New BugKinds: `service_worker_stale`, `web_worker_error`, `iframe_postmessage_unguarded`, `shadow_dom_a11y_violation`, `permission_denied_unhandled`, `webrtc_ice_failure`, `subresource_integrity_violation`, `coop_coep_violation`. Most are passive observation; iframe and shadow DOM require traversal extension to existing walkers.

### 3.2 i18n / locale

| Class | Detection |
|---|---|
| RTL layout breakage | Run a render pass with `<html dir="rtl">`; vision-diff against LTR baseline. Layout categories: clipped text, overlapping elements, broken icons. |
| Long-string overflow | Replace each text input's `happy` value with a 200-char German compound, or a 1000-char Chinese string; capture truncation/overflow visual |
| Date/number-format ambiguity | Inject a date that's ambiguous between US and EU formats (e.g. `2026-03-04`); verify display matches user-locale |
| Hardcoded English | Static analysis: regex for hardcoded strings outside a translation function; flag in source |
| Pluralization | Inject `n=0`, `n=1`, `n=many`; verify pluralization reads correct |
| Currency format | Inject `EUR`, `JPY` (no decimals), `BHD` (3 decimals) — verify rounding, decimal-place handling |
| Timezone display | Already covered by V23 partially |

**Implementation:** new BugKind family `i18n_*`. `--locale-stress` flag runs a per-page locale-variant pass.

### 3.3 Form/input edge cases the palette underweights

| Class | Detection |
|---|---|
| Drag-and-drop | Generate a synthetic `dragstart`/`drop` event sequence; verify drop target accepts the right data types |
| Copy / paste | Programmatic clipboard write; verify paste-handler correctness with formatted source (Word, Excel, formatted HTML) |
| Autofill | Trigger browser autofill via DOM hint; verify form's React state stays in sync |
| Animation/transition state | Click during transition; verify focus state, double-render, modal-dismiss-mid-fade |
| File upload polyglots | Upload zip-slip files, polyglot files, files with embedded payloads (separate from V16 path-traversal) |
| Long-session token refresh | Leave session open ≥1h synthetically (clock-injected); verify token refresh does not interrupt user action |
| Multi-tab same-record edit | Open two tabs; mutate record in tab A, verify tab B reconciles (V19 cross_tab covers some) |
| Browser zoom | 200% zoom; verify layout doesn't break, focus order preserved |
| Print stylesheet | `@media print` correctness; verify the printed view is sane |
| Reduced motion / forced colors / dark mode | Run the existing test plan with media-query overrides; vision-diff against default |

**Implementation:** new "interaction palette" extending the input-mutation palette with action-level mutations. New BugKinds: `drag_drop_failure`, `paste_handler_failure`, `autofill_state_desync`, `animation_state_corruption`, `print_stylesheet_broken`, `reduced_motion_violation`, `forced_colors_failure`, `zoom_layout_breakage`.

### 3.4 Generative / property-based fuzz

The current palette is fixed (`null`/`happy`/`edge`/`out_of_bounds`). It catches 80% of bugs at low compute cost. The remaining 20% are caught by random generation:

- **Unicode/emoji/RTL/zero-width/control-char fuzz** — `fast-check` arbitrary for `text` inputs
- **Shape-fuzz on JSON bodies** — drop required fields, reorder, type-substitute
- **Boundary-aware schema fuzz** — for tools with `inputSchema`, generate values around enum/min/max boundaries
- **Time-fuzz combined with V23** — fuzz date inputs across DST/leap/Y2038/Y10K

**Implementation:** opt-in `--fuzz <strategy>` flag. Strategies: `none` (default, current behavior), `unicode`, `shape`, `boundary`, `all`. Fuzz tests are deterministic with seeded generation; the same seed reproduces failures. Runs sit alongside palette tests, not replace.

### 3.5 Multi-context / coordination

| Class | Detection |
|---|---|
| Two-tab interleaving (V19 has cross_tab) | Already in V19 |
| Three-or-more clients (chat-style apps) | Spawn N camofox sessions; coordinate actions; verify state convergence |
| Multi-user same-resource | V21 IDOR covers id-swap. Add: roleA edits resource X; roleB reads resource X mid-edit; verify B sees consistent snapshot |
| Stop-the-world events | Fire visibility-change, pageshow/pagehide, freeze/resume during long operation |
| Network sequence races | Action A returns before action B (B started later); verify UI orders correctly (V19 partial) |

**Implementation:** new orchestrator `packages/cli/src/phases/multi-context-runner.ts` coordinates N browser contexts. Costly; opt-in via `--multi-context <N>`.

### 3.6 Mobile / responsive

| Class | Detection |
|---|---|
| Touch targets too small | axe rule + per-mobile-viewport baseline pass |
| 100vh on iOS | Layout regression at iOS-specific viewport heights |
| Hover-only affordances on touch | Detect `:hover`-bound actions that have no touch-equivalent |
| Soft-keyboard occlusion | Mobile virtual keyboard hides input being typed |
| Orientation change | Layout reflow on `orientationchange`; state preservation |
| Pull-to-refresh / swipe gestures | Verify gesture handling exists and doesn't conflict with content scroll |

**Implementation:** `--mobile` flag runs the test plan against camofox configured for mobile UA + viewport (375x667 / 390x844 / 412x915). Existing V17 multi-viewport is the foundation. New BugKinds: `touch_target_too_small`, `hover_only_affordance`, `viewport_100vh_break`, `soft_keyboard_occlusion`.

### 3.7 Database / data-integrity

| Class | Detection |
|---|---|
| Foreign-key integrity | After mutation: query DB or API for downstream tables; verify no orphans |
| Money-math precision | Inject decimals at floating-point edge: 0.1 + 0.2; verify storage and display |
| Lost updates (concurrent writes) | V19 race conditions covers some; this is the data-layer flavor |
| Soft-delete consistency | Ensure soft-deleted records don't appear in lists, but DO appear in audit/admin views |
| Cache invalidation | After write, verify next read reflects new state (no cache staleness) |
| Idempotency keys | Replay POST with same idempotency-key; verify second response is the same, not duplicated mutation |
| Audit-log presence | Mutating actions should produce audit-log entries; verify by querying audit endpoint |

**Implementation:** requires DB-introspection or trusted audit endpoint. Out-of-band from BugHunter's app-walker model; the cleanest fit is `seedHooks.afterEach` invariant assertions returning detection. New BugKinds: `data_integrity_orphan`, `money_math_precision`, `cache_staleness`, `idempotency_key_violation`, `audit_log_missing_for_mutation`.

### 3.8 LLM / agentic-app specific

The vibe-coding cohort increasingly ships LLM-using apps. Detect:

- **Hallucinated route** — currently detector-less; planner should compare claimed routes against actually-served routes
- **Prompt-injection attack via user input** — extend pen-testing palette
- **Streaming-response truncation** — verify stream completes, doesn't cut off mid-token
- **Tool-call failure handling** — when agent's tool-call returns error, UI shows correct state
- **Agent-turn cost / latency** — flag when an agent action takes >30s or costs >$0.10
- **Agent hallucination boundary** — if the app surfaces an agent answer claimed to come from data, verify the claim against the source data (LLM-of-output check)

**Implementation:** extension of vision pass — vision-of-agent-response. New BugKinds: `agent_response_hallucinated`, `agent_action_timeout`, `prompt_injection_executed`, `streaming_response_truncated`.

### 3.9 The single-detector promise

For every BugKind in `BugKind`, `bughunter detectors --kind <kind>` should return:

- Whether it has a wired detector
- The file:line of the detector
- The file:line of the runner that produces the input
- Whether the input is captured in production paths (vs synthetic-only)
- Acceptance criterion source (which spec it was promised by)
- Last-fired-on-record (across runs)

This makes the dead-detector problem (audit finding) impossible to hide. Adding the report is mostly tooling around existing files.

---

## 4. CLI surface — what's missing

Current commands: `init`, `run`, `replay`, `inspect`, `list`, `status`, `palette`, `prune`, `forbidden-path-gate`, `retest`, `fix-summary`. Missing for "comprehensive":

### 4.1 Diagnostics & introspection

```
bughunter doctor
  Reports: SurfaceMCP reachable? Browser MCP reachable? Vision auth?
           camofox version? Playwright version? Disk space? Run dir health?
           Active hooks? Forbidden-paths config? Returns 0 on green.

bughunter detectors [--kind <bugkind>] [--status wired|dead|deferred] [--format table|json]
  For every BugKind: detector wired (yes/no/file:line), runner-input-source
  (production/synthetic-only), last-fired (date or "never"), spec reference.
  Closes the audit gap permanently.

bughunter scope [--route <pat>] [--role <name>]
  Dry-run: print the test matrix that 'bughunter run' would generate, without
  executing. Counts per kind, projected runtime, projected API calls.

bughunter inputs <toolId> [--palette <n>]
  For one tool, print the test inputs the planner would mint for the chosen
  palette variant. Useful for debugging fuzz strategies.

bughunter config validate
  Run Zod against .bughunter/config.json + .bughunter/palette.json. Print
  warnings for orphan fixtures (V21 already has this internally).

bughunter config show [--resolved]
  Print effective config (with defaults applied, --resolved) or raw file.
```

### 4.2 Cross-run / regression / history

```
bughunter diff <runId-old> <runId-new> [--format table|json|sarif]
  Print which clusters are: new in <new>, persistent across both, gone
  in <new>, regressed (was verified-fixed, now back). Critical for CI use.

bughunter history [--kind <bugkind>] [--limit <n>]
  Per-kind timeline: when did this bug class first appear, when was it
  fixed, has it regressed, what's the median time-to-fix.

bughunter bisect <bug-id> [--commit-range <a..b>]
  Re-run the action-log replay against each commit in the range; identify
  the commit that introduced the bug. Backed by git worktree cycling.

bughunter ingest <path-to-bugs.jsonl>
  Import a bugs.jsonl from a previous run / different host into local
  history. Enables cross-host triage.

bughunter aging [--threshold <days>]
  List clusters older than threshold; flag for triage or auto-suppress.
```

### 4.3 Triage & suppression

```
bughunter suppress <pattern> [--reason <text>] [--expires <date>]
  Add to .bughunter/suppressions.json. Pattern: clusterId | kind | endpoint
  glob | suspectedFile glob. Audit-trailed (who/when/why).

bughunter unsuppress <pattern>
  Remove suppression. Audit-trailed.

bughunter triage [--interactive]
  TUI: walk clusters, mark each as bug/fix-priority/false-positive/known.
  Writes to .bughunter/triage.jsonl which 'bughunter run' consults.

bughunter explain <bug-id>
  Pipe the cluster + suspectedFiles to Claude (subprocess), get a human-
  readable explanation. Costs ~5¢/explain. Cached per-runId.
```

### 4.4 Output / integration formats

```
bughunter export <runId> --format sarif | github | gitlab | linear | jira | csv
  SARIF for SAST tooling. github = GitHub code-scanning JSON. linear = create
  Linear issues. jira = create Jira tickets. csv = pivot-friendly.

bughunter publish <runId> --target github
  Push SARIF to repo's code-scanning surface; open issues for new clusters.

bughunter watch [--debounce <ms>] [--scope <pattern>]
  Daemon mode: re-runs scoped tests on file change. Outputs deltas only.

bughunter ci [--fail-on <severity|count>] [--report <path>]
  CI-friendly: machine-parsable output, non-zero exit on threshold breach,
  generates SARIF + summary.md for PR comment.
```

### 4.5 Calibration & self-test

```
bughunter benchmark <fixture-app>
  Run BugHunter against a known-bug fixture; report precision, recall, F1
  per BugKind. Compares against baseline (last run on same fixture).

bughunter self-test
  Runs the BugHunter test suite + lints + a smoke run against a built-in
  trivial deliberate-bug app. The "BugHunter on BugHunter" gate.

bughunter calibrate [--app <path>] [--gold <bugs.jsonl>]
  Run against an app with a hand-curated gold-standard bug list; report
  per-kind precision/recall vs gold.
```

### 4.6 Determinism & time-travel

```
bughunter run --seed <n> --frozen-clock <iso8601> --frozen-network <fixture>
  Reproducible runs: same seed + clock + network → same bug log. Critical
  for regression tracking and for shipping public benchmark numbers.

bughunter replay --frozen-clock <iso8601> ...
  Replay one occurrence with deterministic context.

bughunter minimize <occurrenceId>
  Action-log minimization: try removing each step from the action sequence;
  if the bug still reproduces with fewer steps, keep the shorter version.
  Outputs a minimum-repro action log.
```

### 4.7 Reorganization

The current 11 commands grow to ~30. Group them under sub-namespaces:

```
bughunter run / status / list / replay / inspect            # core
bughunter init / config / detectors / scope / inputs        # introspection
bughunter doctor / self-test / benchmark / calibrate        # diagnostics
bughunter diff / history / bisect / ingest / aging          # cross-run
bughunter suppress / unsuppress / triage / explain          # triage
bughunter export / publish / watch / ci                     # integration
bughunter forbidden-path-gate / retest / fix-summary        # auto-fix helpers
bughunter prune / palette / minimize                        # housekeeping
```

Help output groups by section (P0 fix #6 already started this).

---

## 5. MCP surface — what's missing

Current `bughunter-mcp` HTTP server exposes 4 tools: `bughunt_run`, `bughunt_status`, `bughunt_latest_bugs`, `bughunt_replay`. For programmability parity with the CLI:

### 5.1 Read-side tools

```ts
bughunt_clusters({
  runId?: string,
  kind?: BugKind | BugKind[],
  role?: string,
  routePattern?: string,
  verdict?: ClusterVerdict,
  minClusterSize?: number,
  limit?: number,
  cursor?: string,
}): { clusters: Array<{ id, kind, clusterSize, rootCause, suspectedFiles, verdict }>, nextCursor?: string }

bughunt_cluster_detail({ runId, clusterId }): BugCluster
  // Full cluster including all occurrences (lightweight + full-artifact).

bughunt_occurrence({ runId, occurrenceId }): OccurrenceFull | OccurrenceSummary
  // Full or summary form depending on retention.

bughunt_artifact({ runId, occurrenceId, kind: 'screenshot'|'dom'|'console'|'network'|'action-log' })
  // Returns base64 (screenshot) or text. Subject to retention budget.

bughunt_runs_list({ project, limit?, since? }): Array<RunSummary>
  // Cross-run list.

bughunt_run_summary({ runId }): RunSummary
  // The summary.json for one run.

bughunt_detectors({ status?: 'wired'|'dead'|'deferred', kind?: BugKind })
  // Coverage transparency. Mirrors `bughunter detectors`.

bughunt_diff({ runIdOld, runIdNew, format?: 'json'|'sarif' })
  // Cross-run regression detection.

bughunt_history({ kind?: BugKind, limit?: number })
  // Per-kind appearance / fix / regression timeline.

bughunt_explain({ runId, clusterId })
  // Claude-summarized explanation. Cached.
```

### 5.2 Write-side tools

```ts
bughunt_suppress({ pattern, reason, expires? }): { ok: boolean, suppressed: number }
bughunt_unsuppress({ pattern }): { ok: boolean, removed: number }
bughunt_triage({ runId, clusterId, mark: 'bug'|'fix-priority'|'false-positive'|'known', note? })
bughunt_minimize({ runId, occurrenceId }): { minimizedActionLogPath: string, originalSteps: number, minimizedSteps: number }
bughunt_replay_minimized({ runId, occurrenceId }): TestResult
bughunt_baseline_save({ runId, kind: 'visual'|'perf' })
  // Lock the current baseline; future runs compare to this.
bughunt_baseline_compare({ runId })
  // Compare current run to locked baseline.
```

### 5.3 Streaming / live-tail

MCP supports resource subscriptions. Add:

```ts
bughunt_tail({ runId, kindFilter?: BugKind[] })
  // Streamable resource: emits each new cluster as it's detected during a
  // running execute phase. Lets a Claude session "watch" a long run.

bughunt_progress({ runId })
  // Streamable resource: emits phase changes (validate→discover→plan→...)
  // and per-phase progress (testsPlanned/testsRan/clustersFound).
```

### 5.4 Auto-fix coordination

Currently the fix loop is skill-driven from a Claude Code session. Expose hooks for non-Claude agents (Hermes, custom):

```ts
bughunt_fix_dispatch({ runId, clusterId, agent: 'architect'|'coder', model: string, prompt: string })
  // Generic dispatch. Caller manages the agent; BugHunter manages the branch
  // and the gate.

bughunt_fix_status({ runId })
  // Per-cluster verdict snapshot. Mirrors `bughunter fix-summary`.

bughunt_fix_gate({ runId, clusterId, branch })
  // forbidden-path-gate + reset. Mirrors CLI helper.

bughunt_fix_retest({ runId, clusterId, branch })
  // Mirrors CLI helper.
```

### 5.5 Project context

```ts
bughunt_project_describe({ projectDir })
  // SurfaceMCP reachable? framework? config valid? test-fixture present?
  // Mirrors `bughunter doctor` for a project.

bughunt_config_get({ projectDir, resolved?: boolean })
bughunt_config_set({ projectDir, key, value })
  // Programmatic config edits, with Zod validation.
```

The MCP server stays HTTP-streamable for Claude Code consumption and stdio-ready for headless agents. Auth model: per-client API key (current pattern).

---

## 6. Trust & verifiability — the hardest axis

The "comprehensive" claim collapses if BugHunter's outputs are unreliable. Required:

### 6.1 Deterministic mode

```
bughunter run --seed 1234 --frozen-clock 2026-05-01T12:00:00Z --frozen-network fixtures/network-fixture.json
```

Same inputs, same outputs. Implementation:
- Seed propagates into the input-mutation palette generators (currently random for fuzz; deterministic for fixed palette)
- Frozen-clock injects via the V23 polyfill mechanism (init-script)
- Frozen-network records a HAR on first run; replays from HAR on subsequent runs

Test acceptance: `bughunter run --seed 1234 ...` twice produces byte-identical bugs.jsonl.

### 6.2 BugHunter-on-BugHunter self-test

Build a fixture app `fixtures/bughunter-self-deliberate-bugs/` containing:

- Every BugKind that has a detector — at least one deliberate bug producing it
- Every BugKind without a wired detector — a fixture deliberately exhibiting it; the test asserts BugHunter does NOT flag it (proves the gap is real and visible)

`bughunter self-test` runs BugHunter against this fixture and asserts:
- Each "wired" kind: ≥1 cluster found, signature matches expected
- Each "unwired" kind: 0 clusters found (no false positives)
- Total run time within budget (regression-detect performance creep)

### 6.3 Public calibration benchmark

A separate repo `cunninghambe/BugHunter-bench`:
- 5 deliberately-buggy real-shaped apps (vibe-coded look and feel)
- Hand-curated gold-standard bug list per app
- `bughunter calibrate --app <bench-app> --gold <gold>` runs and emits precision/recall/F1 per kind
- README publishes the latest numbers; CI updates them on every BugHunter PR

This is the hardest item but the most trust-building. Without published numbers, "comprehensive" is asserted, not demonstrated.

### 6.4 Coverage report

Every run emits `coverage.json`:
- Which BugKinds had at least one cluster minted (their detectors are reachable on this app)
- Which had zero clusters (could be: no bug present, or detector dead)
- For zero-cluster kinds: did the input exist? (e.g. `excessive_re_renders` runs; if there were no React render events captured, the kind is "input absent" not "detector working")

`bughunter coverage <runId>` formats the report. Allows users to ask "why didn't BugHunter flag X" and get an actionable answer.

### 6.5 Suppression audit trail

Every suppression entry:
- Who added it (git author, stored at suppress-time)
- When (ISO timestamp)
- Why (free-text reason)
- Optional expiry
- Linked to a bug-id from a specific run

`bughunter suppress audit` shows the trail. Suppression-without-reason is rejected by the CLI.

### 6.6 Severity calibration

Currently the priority hierarchy in `KIND_PRIORITY` orders kinds for cluster-collision resolution. It's NOT a severity axis. Add:

```ts
type Severity = 'critical' | 'major' | 'minor' | 'info';
type DetectorMetadata = {
  kind: BugKind;
  severity: Severity;
  defaultThreshold?: number;
  exploitabilityModel?: 'easy'|'medium'|'hard'|'na';
  cwe?: string[];
};
```

Per-kind severity declaration enables: `--fail-on critical`, `--fail-on major+`, SARIF severity mapping, GitHub code-scanning severity, Linear/Jira priority mapping. The current "everything is a cluster" model can't drive CI gates.

---

## 7. Cross-run / cross-time

### 7.1 Bug identity across runs

Today: a cluster gets a fresh `id` every run. The same root-cause bug found in run A and run B has unrelated IDs.

Needed: `bugIdentity` derived from `(projectName, clusterSignature)`. Stable across runs. Enables:
- `bughunter diff <old> <new>` shows real new-vs-persistent-vs-fixed-vs-regressed
- `bughunter history --kind X` shows when the same logical bug appeared, was fixed, regressed
- Linear/Jira sync uses `bugIdentity` as external ID; same logical bug doesn't create N tickets

### 7.2 Run database

`.bughunter/history.db` (SQLite) accumulates:
- Every run's summary
- Every cluster's bugIdentity + first-seen / last-seen / verdict-history
- Suppression history
- Triage history

Pruned by `bughunter prune --keep <n>` (default 30 runs).

### 7.3 Cross-project coordination

For users running BugHunter across multiple repos (multi-product shops):

```
bughunter projects list
bughunter projects scan <root-dir>     # find all bughunter-config'd projects
bughunter run-all --since 7d           # batch-run all projects
bughunter dashboard                    # cross-project bug counts
```

A `~/.bughunter/projects.json` registry of known projects.

---

## 8. Cross-context

### 8.1 Staging-safe / production read-only mode

Today: `local apps only`. To extend:

```
bughunter run --read-only
  Disables all mutating actions: no POST/PATCH/PUT/DELETE on API; no
  click/submit on UI elements that map to mutating tools; no V21
  probeMutating; no network-fault on mutating endpoints; no V19 race tests.
  Emits passive-detection BugKinds only:
  - SEO hygiene
  - A11y baseline
  - Bundle / perf vitals
  - Static analysis kinds
  - 5xx/4xx that occur naturally during navigation
  - Visual anomalies on render-only routes
```

This unlocks real-staging audits. Out-of-scope: "real-prod audits" — too risky regardless of read-only flag; require user-explicit-opt-in via separate `--target production-i-know-what-im-doing` flag with confirmation.

### 8.2 CI templates

`fixtures/ci-templates/` ships:
- `.github/workflows/bughunter.yml` — GitHub Actions, runs on PR, reports SARIF, comments on PR
- `.gitlab-ci.yml` snippet — same for GitLab
- `circle.yml` — same for CircleCI
- A `Dockerfile` for containerized BugHunter runs

Each template uses `bughunter ci --fail-on critical --report report.md`.

### 8.3 IDE / editor

- VSCode extension: shows BugHunter findings as squiggles inline; `Cmd+Click` to view occurrence; `Cmd+.` to trigger `/bughunt fix` on the cluster
- JetBrains plugin: same shape
- Neovim: LSP-style diagnostics
- All three are thin clients reading bugs.jsonl + action logs from `.bughunter/runs/<latest>/`

### 8.4 TUI for triage

`bughunter triage --interactive` opens a Bubble Tea / Ink TUI:
- List clusters left, detail right
- `j/k` navigate, `m` mark verdict, `s` suppress, `e` explain (Claude), `r` run /bughunt fix, `q` quit
- Triage state persisted to `.bughunter/triage.jsonl`

### 8.5 Slack / Discord / email notifications

`.bughunter/config.json`:
```json
{
  "notify": {
    "critical": ["slack:#engineering", "email:eng-leads@..."],
    "regressed": ["slack:#engineering"],
    "fixVerified": ["slack:#wins"]
  }
}
```

Triggered on every run completion.

### 8.6 Web UI viewer

A standalone read-only static viewer for `.bughunter/runs/<id>/`:
- Loads bugs.jsonl + action logs in-browser
- Lists clusters, drill-downs, screenshots, action timelines
- No backend; runs against local files via the File System Access API
- Distributed as a static asset; users open `bughunter view` and a browser tab opens

---

## 9. Phasing — how to get there

Each phase is independently shippable; the "comprehensive" claim is defensible after Phase D.

### Phase A — close the dead/half-wired gaps (2-3 weeks)

The audit work in PR #53 is the first half. Remaining:
- Wire the 5 deferred perf detectors (request_cancellation_missing, unbounded_list_render, dom_error_text, hydration_mismatch, accessibility_critical full path)
- Implement detectors for csrf_missing_on_mutating_route and hallucinated_route, or remove from the union
- V20 + V23 implementation (depends on camofox-mcp PRs landing)
- V19/V21/V22 PR cleanup checklists

**Delivers:** every advertised BugKind has a wired detector.

### Phase B — surface (CLI + MCP) parity with intent (3-4 weeks)

- Sub-section 4.1 (diagnostics: `doctor`, `detectors`, `scope`, `inputs`, `config`)
- Sub-section 4.2 minimum (`diff`, `history`)
- Sub-section 4.3 minimum (`suppress`, `triage`)
- Sub-section 4.4 minimum (`export --format sarif`, `ci`)
- Sub-section 5.1 (read-side MCP tools)
- Sub-section 5.2 minimum (suppress, triage)

**Delivers:** every CLI op has an MCP equivalent. Every machine consumer can drive BugHunter.

### Phase C — trust (2-3 weeks)

- Deterministic mode (seed + frozen-clock + frozen-network)
- BugHunter-on-BugHunter self-test fixture
- Coverage report (`coverage.json` per run)
- Severity calibration (`Severity` field on every detector, SARIF mapping)
- Suppression audit trail

**Delivers:** every claim is reproducible; coverage is machine-readable; severity drives CI.

### Phase D — cross-time (2 weeks)

- bugIdentity stable across runs
- SQLite history DB
- `diff`, `history`, `bisect`, `aging` commands
- New / persistent / fixed / regressed bucketing in `summary.json`

**Delivers:** BugHunter understands time. CI gates on regressions, not raw counts.

### Phase E — detection coverage expansion (4-6 weeks, parallelizable)

Not blocking the comprehensive claim — Phases A-D establish credibility; E expands it. Per §3:
- 3.1 Browser-platform surface (service workers, Web Components, etc.)
- 3.2 i18n / locale stress
- 3.3 Form/input edge cases (drag, paste, autofill, animation, zoom, print)
- 3.4 Generative fuzz
- 3.5 Multi-context coordination
- 3.6 Mobile / responsive
- 3.7 Database / data-integrity
- 3.8 LLM / agentic-app specific

Each is an independent V-spec following the existing pattern.

### Phase F — calibration (2-3 weeks)

- `cunninghambe/BugHunter-bench` repo with 5 fixture apps + gold-standard bug lists
- `bughunter calibrate` workflow
- Published precision/recall numbers in BugHunter README

**Delivers:** the comprehensive claim is empirically defensible.

### Phase G — context expansion (3-4 weeks)

- Read-only / staging mode
- CI templates (GitHub Actions, GitLab, CircleCI, Dockerfile)
- IDE extensions (VSCode first; others later)
- TUI for triage
- Web UI viewer
- Notification integration (Slack, email)

**Delivers:** vibe coders adopt BugHunter from any of {CLI, IDE, CI, Slack, Web UI}.

### Total

Roughly 4-6 calendar months of focused work to reach the "comprehensive" claim defensibly. Phases A-D are the must-haves (~10-12 weeks). E-G expand surface but are not gates.

---

## 10. Anti-goals (what comprehensive does NOT mean)

- **Replace Burp Suite for security** — Burp owns pen-testing depth. BugHunter's security coverage is exhaustive at the *advertised* surface (XSS, IDOR, auth, headers, deps, JWT) but doesn't probe at Burp's depth. We complement, not replace.
- **Replace Lighthouse for perf audits** — Lighthouse owns one-shot perf audits with audit-tier accuracy. BugHunter's perf coverage detects regressions across an exhaustive walk; different shape.
- **Replace human QA** — humans catch business-logic bugs ("this number should be the user's lifetime revenue, not their monthly"). BugHunter catches mechanical bugs at scale.
- **Production-mutate** — production-read-only is in scope. Production-write is not, regardless of opt-in level. Use staging-with-rollback for that.
- **Replace e2e tests** — Cypress / Playwright e2e tests verify specific user journeys with hand-written assertions. BugHunter walks the surface broadly with bounded heuristics. Different shape.
- **Cover every bug class on Earth** — comprehensive within the vibe-coded-SPA cohort. Not within "every web app ever built." Long-tail business logic and novel attack chains belong elsewhere.

The honest claim by Phase F: **the most comprehensive autonomous bug-hunter for vibe-coded local-and-staging apps, with reproducible findings, programmable surface, published precision/recall, and an integrated auto-fix loop**. That's narrow but real. It's also probably true after Phase F, where it isn't yet.

---

## 11. Open questions

1. **Should bugIdentity (§7.1) include the suspectedFiles set?** A bug whose suspected file moves during refactor would get a new identity. Argues for signature-only. But signature is fingerprint-of-symptom; refactor that doesn't change behavior shouldn't reset the bug's history. Defer to Phase D implementation.

2. **Severity calibration (§6.6) — author's call or framework convention?** OWASP CWE mapping is authoritative for security; perf has no canonical severity tiering. Defer to Phase C; document per-kind reasoning.

3. **Self-test fixture (§6.2) — one mega-app or one fixture per BugKind?** One mega-app is more realistic but harder to maintain; one-per-kind is more diagnostic but less representative. Lean per-kind for credibility, mega-app for smoke.

4. **Calibration corpus (§6.3) — 5 apps enough?** Industry SAST benchmarks use 50-200 apps. 5 is a starting point; commit to growing to 20+ over Phase F.

5. **MCP streaming (§5.3) — MCP spec stable enough?** MCP resource subscription is in the latest spec but adoption is uneven. May need a polling fallback for tool clients that don't support resource subscriptions.

6. **Read-only mode (§8.1) — how aggressive?** A purist reading bans even GET retries (could cascade), even login attempts (could trip rate limit). A pragmatic reading allows everything except mutating endpoints and the V21/V19/V20 destructive palettes. Lean pragmatic; document the carve-outs.

7. **IDE extensions (§8.3) — which first?** VSCode has dominant share; JetBrains has the dev-shop minority that pays. Lean VSCode first; JetBrains as a community-contribution slot.

8. **Notification integration (§8.5) — opt-in webhook only, or first-party Slack/email?** First-party adds maintenance burden; webhook is universal. Lean webhook-first; first-party as a v1.x enhancement when the user base demands it.

---

## 12. Definition of comprehensive

After Phase F:

- Every BugKind in the union has a wired detector that fires on a real production input source (verified by `bughunter detectors`)
- Every CLI operation is reachable from MCP and vice versa (verified by parity tests)
- Every run is reproducible with `--seed` (verified by self-test)
- Every cluster has a stable bugIdentity, a severity, and a precision/recall number from the calibration corpus
- The README publishes per-kind precision/recall vs the BugHunter-bench corpus, last-updated automatically
- Vibe coders can adopt from CLI, VSCode, GitHub Actions, Linear, or Slack — same finding lands in all of them

That's the bar. "Most comprehensive in the world" earns the claim there. Until then, the honest framing is: "the most spec-disciplined exhaustive walker for vibe-coded local-dev apps, with an integrated Claude auto-fix loop." Narrow but real.
