# SPEC — v0.45 "Read-only / staging-safe mode"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Sibling:** `SPEC_PATH_TO_EXHAUSTIVE.md` §8.1, Phase G.

V45 introduces `bughunter run --read-only`, a global mode that disables every code path that would issue a mutating side effect against the target. The mode is the prerequisite for staging audits (and for any "read-only against real shared data" use case) and is a strict superset of the per-tool safety gates that already exist in V21 cross-user (`sideEffectClass !== 'safe'`). Where V21 gates one phase, V45 gates the whole pipeline.

The acceptance bar is binary: with `--read-only`, BugHunter MUST NOT emit a single non-GET / non-HEAD / non-OPTIONS HTTP request to the application under test, MUST NOT issue a UI click that fires a mutating tool, and MUST NOT run any subsystem whose detector requires write-then-observe semantics. If we can't prove that, we don't ship the flag.

---

## 1. Status / Author / Date

| Field | Value |
|---|---|
| Status | Draft 1 — ready for `@coder` assignment |
| Author | `@architect` (Opus, ultrathink) |
| Date | 2026-04-30 |
| Branch | `spec/v45-read-only-mode` |
| Predecessors | V21 (cross-user IDOR `sideEffectClass !== 'safe'` gate), V19 (race conditions — gated off in read-only), V16 (pen-testing — gated off), V14 (seed hooks — partially gated) |
| Siblings shipping in parallel | V42 (data-integrity write-then-verify — turned off in read-only), V20 (network-fault — gated to non-mutating endpoints only) |

---

## 2. Problem statement

BugHunter today runs against `localhost` dev environments under the assumption that any mutation is reversible (resetCommand, transactional reset, etc.). For the staging audit use case — the user has a real staging environment with real-ish data, no reset hook, and a strong "do not corrupt" requirement — that assumption breaks. Today they can't run BugHunter at all. We need a mode where BugHunter can still extract meaningful findings from passive observation (vision, SEO hygiene, a11y baseline, perf vitals, static analysis, naturally-occurring 5xx during navigation, header probes that are GET-only) while provably not touching application state.

The challenge is subtle: BugHunter's value comes from active probing, and many "active" probes are actually safe (GET-based IDOR, header inspection, CSP probing) while many "passive-looking" code paths are not (a click on a button that fires a DELETE under the hood). We need a *strict* filter at the action layer, not just at the subsystem layer, because the subsystem-level gating misses elements whose toolId resolves to a mutating handler.

The flag's purpose is also psychological: it gives the user (and us) a single confident knob — "this run will not write." Without it, we have a half-dozen subsystem flags (`--no-race-conditions`, `--no-pen-testing`, etc.) that the user has to enumerate, and that we'll forget to extend when we add the next subsystem. `--read-only` is the umbrella that gates every subsystem that's not provably read-only.

---

## 3. Boundaries

### In scope
- New global flag: `bughunter run --read-only` (and `BUGHUNTER_READ_ONLY=1` env var equivalent for CI)
- A single config field: `BugHunterConfig.readOnly?: boolean` (CLI flag overrides config; env var lowest precedence)
- A canonical predicate `isReadOnlyTool(t: ToolMeta): boolean` — `t.sideEffectClass === 'safe' && (t.method === 'GET' || t.method === 'HEAD' || t.method === 'OPTIONS')`
- A canonical predicate `isReadOnlyAction(a: Action, toolCatalog: Map<string, ToolMeta>): boolean` — combines `kind`, resolved `toolId`, and the side-effect class of every tool the action could fire
- Plan-phase action filter that drops every test case whose action is not read-only when `config.readOnly === true`
- Defense-in-depth runtime guard at the API adapter (`surface_call`) and UI executor (`runUiTest` for clicks/form-submits) that throws `MutatingActionRejectedError` when `config.readOnly === true` and the action is not read-only
- Subsystem-level gating in `run.ts` — force-disable `raceConditions`, `penTesting`, `synthetic`, `authFlow`, `authProbe`, V42 data-integrity, V20 network-fault on mutating endpoints, when `readOnly === true`
- Cross-user (V21) restricted to read-only replays only — when `config.readOnly === true`, the matrix only replays tools where `isReadOnlyTool` holds, regardless of role
- Seed-hook gating: when `readOnly === true`, only HTTP `GET` / `HEAD` / `OPTIONS` hooks and shell hooks explicitly marked `readOnlyAllowed: true` execute; others log `skipped (read-only)` and pass through
- Per-`BugKind` carve-out table documented (which kinds fire under `--read-only`, which silently skip, which warn-and-skip)
- A single emitted telemetry block in `summary.json` — `readOnly: { enabled, droppedTestCases, droppedSubsystems, blockedAtRuntime }` — so users can verify the gating happened
- Acceptance test: a "no-mutate" assertion harness that runs BugHunter against a recording proxy and fails the test if any non-GET reaches the app

### Out of scope (deferred, not denied)
- **Real-production audits.** `--read-only` is a sufficient gate for *staging* (where the user trusts the data is recoverable), not for *production*. A separate `--target production-i-know-what-im-doing` flag is required for prod, with interactive confirmation, redaction of payloads in summary.json, and rate-limiting. Defer to V46.
- **Auto-detect "this is staging, not localhost."** Detection by hostname is unreliable (some users tunnel staging through `localhost:3000`). The flag is explicit; we don't infer it.
- **Rollback / sandboxing.** If a mutation does sneak through, we don't try to revert. We crash loud (`MutatingActionRejectedError`) and abort the run.
- **Read-only DB transactions.** Out of scope — that's an application-server concern, not a BugHunter concern.
- **Per-route read-only carve-outs** ("everything is read-only EXCEPT this safe sandbox endpoint"). Noisy; punt to user-config V46.
- **Anonymous-mode crawling under read-only.** Already covered by existing crawl logic — no new work.
- **Surface MCP changes.** SurfaceMCP doesn't need to know about `readOnly`; the BugHunter side filters tool execution. (If a SurfaceMCP user passes `readOnly: true` to a future MCP tool, we add it then; not now.)

### Non-goals (explicitly denied, not deferred)
- Does NOT make any subsystem suddenly "smarter" or "safer." A subsystem either runs unchanged or is gated off.
- Does NOT relax existing safety gates. V21's `sideEffectClass !== 'safe'` filter remains; V45 strengthens, never weakens.
- Does NOT add a "warn but proceed" mode for mutating actions. Either skipped at plan, or thrown at runtime. Binary.
- Does NOT log redacted secrets in `--read-only` summary; existing redaction rules unchanged.

---

## 4. Mutating-action filter — where it slots in

V45 defines exactly four enforcement points. Each is independently sufficient, and each catches what the previous tier might miss. The order is intentional: catch as early as possible (cheapest), but always have a runtime backstop.

### 4.1 Tier 1: subsystem gate (in `cli/run.ts`)

Before any phase runs, when `resolved.readOnly === true`, the run.ts orchestrator forces:

```ts
if (resolved.readOnly === true) {
  if (resolved.raceConditions?.enabled === true) {
    log.warn('read-only: race-conditions force-disabled');
    resolved.raceConditions = { ...resolved.raceConditions, enabled: false };
  }
  if (resolved.penTesting?.enabled === true) {
    log.warn('read-only: pen-testing force-disabled');
    resolved.penTesting = { ...resolved.penTesting, enabled: false };
  }
  if (resolved.synthetic?.enabled === true) {
    log.warn('read-only: synthetic scenarios force-disabled');
    resolved.synthetic = { ...resolved.synthetic, enabled: false };
  }
  if (resolved.authFlow?.enabled === true) {
    log.warn('read-only: auth-flow probes force-disabled (password-reset/session-fix mutate)');
    resolved.authFlow = { ...resolved.authFlow, enabled: false };
  }
  if (resolved.authProbe?.enabled === true) {
    log.warn('read-only: auth-probe (rate-limit) force-disabled');
    resolved.authProbe = { ...resolved.authProbe, enabled: false };
  }
  // V42 data-integrity write-then-verify, V20 network-fault on mutating endpoints —
  // the subsystem-level config field will land in those V-specs; gate here.
  // XSS and IDOR are NOT blanket-disabled — they get per-action filtering below.
}
```

This is the cheapest gate and the one users see most clearly in logs. The subsystem-level disable is logged with `read-only:` prefix so users can grep `summary.json.skippedReasons` and see what was off.

### 4.2 Tier 2: plan-phase test-case filter (in `phases/plan.ts`)

After `enrichToolSchemas`, but BEFORE the `for (const role of roles)` loop, build a `readOnlyToolIds: Set<string>` of every tool whose method is GET/HEAD/OPTIONS *and* whose `sideEffectClass === 'safe'`. Both conditions required — a GET endpoint that has been classified as `mutating` by SurfaceMCP (e.g. a poorly-designed `GET /api/users/delete?id=1`) is still mutating.

For each test-case-emitting branch in plan.ts, gate on `readOnly`:

| Branch | Read-only treatment |
|---|---|
| `renderTestCase` (per-page render) | Always allow — render is read-only by definition |
| `navigateTestCase` (per-link nav) | Always allow — link navigation is read-only |
| `apiTestCases` for a `ToolMeta` | Skip entirely if `!readOnlyToolIds.has(tool.toolId)`. Increment `skipReasonCounts['read_only_skipped_mutating_tool']`. |
| `formTestCases` for a `DiscoveredForm` | If form's `apiToolIds` resolves to ANY mutating tool, skip the form's submit cases. The empty-input "render the form" case is already covered by render. |
| `clickTestCase` for a button-like element | Conservative skip: if the element's resolved `apiToolIds` is non-empty and ALL tools are read-only, allow; else skip. Buttons with no resolved tool ID are skipped (we can't prove read-only). Increment `skipReasonCounts['read_only_skipped_unknown_button']`. |
| `xssFormTestCases` / `xssApiTestCases` | XSS canaries are POST/PUT bodies by definition — skip entirely under read-only. Most XSS reflection is detected via render-time probes anyway; a follow-up V46 could add a "GET-only stored-XSS read" path. |

The goal is that after the plan phase, the *list of test cases* contains zero entries that would mutate. Tier 3 is then redundant for properly-built test cases — it exists only to catch the "I forgot to add a gate for the new test-case branch" failure mode.

### 4.3 Tier 3: runtime guard at the action executors

```ts
// packages/cli/src/phases/execute.ts (call site for runUiTest / runApiTest)
function assertReadOnlyAllowed(
  action: Action,
  config: BugHunterConfig,
  toolCatalog: Map<string, ToolMeta>,
): void {
  if (config.readOnly !== true) return;
  if (!isReadOnlyAction(action, toolCatalog)) {
    throw new MutatingActionRejectedError(
      `read-only mode: refusing to execute action kind=${action.kind} toolId=${action.toolId ?? 'unknown'}`
    );
  }
}
```

Called at the top of:
- `runUiTest` (`packages/cli/src/phases/execute.ts`) — for click/submit/render/navigate
- `runApiTest` / direct API calls — both via `surface.surface_call` and via the cross-user replay loop in `phases/cross-user.ts`
- The seed-hook executor (`seed/runner.ts`) — for shell + http hooks

`MutatingActionRejectedError` is a new typed exception in `types.ts` (or a small new file `errors.ts` if `types.ts` is already 1300 lines — and it is). The error is *fatal*: it aborts the run. Rationale: if Tier 2 filtered correctly, Tier 3 should never fire. If it fires, we have a bug in the gating — better to crash loud than continue and hope.

### 4.4 Tier 4: cross-user (V21) IDOR replay narrowing

In `phases/cross-user.ts`, when `config.readOnly === true`, the cross-role replay loop adds a guard: after `decodeDiscoveredIdKey(compositeKey)` and the existing `toolCatalog.has(toolId)` check, also require `isReadOnlyTool(toolCatalog.get(toolId))`. This narrows IDOR to *horizontal read leaks* (which is still highly valuable — most IDOR findings are read-side anyway) and excludes write-side cross-role attacks. Document this in the user-facing release notes as "V45 IDOR is read-only; full IDOR matrix requires non-read-only mode."

The anonymous catalog sweep in V21 already has `if (toolInfo.sideEffectClass !== 'safe') continue;` — that path is unchanged but we should also tighten it under read-only to require `method === 'GET'/'HEAD'/'OPTIONS'`.

### 4.5 Tier 5: seed-hook gating

In `seed/runner.ts`, when `config.readOnly === true`:
- HTTP hooks: only run if `method` is one of `GET`/`HEAD`/`OPTIONS`. Otherwise emit a `SeedHookExecution` with `ok: false, reason: 'read_only_skipped'`.
- Shell hooks: skip unless `hook.readOnlyAllowed === true` (a new optional field on `SeedHookShell`). Rationale: a shell hook that runs `psql -c 'SELECT ...'` is fine, but `psql -c 'TRUNCATE'` is not — and we can't introspect a shell command. Forcing the user to opt in per-hook is the only safe default.

The new `readOnlyAllowed?: boolean` on `SeedHookShell` is the only schema change to existing config types.

---

## 5. Per-BugKind table — what fires under `--read-only`

The complete list of `BugKind`s from `types.ts` plus carve-outs. **Fire** = detector still runs and can emit. **Skip** = detector explicitly disabled in read-only. **Conditional** = detector runs but its observation surface is reduced (documented case-by-case).

### 5.1 Always-fire kinds (passive observation)

| BugKind | Why it stays |
|---|---|
| `console_error` | Captured during render/navigate, both of which run in read-only |
| `react_error` | Same — error boundaries fire on render |
| `hydration_mismatch` | Render-time signal; no mutation involved |
| `network_5xx` | 5xx that happens during navigation/render — not from a probe |
| `network_4xx_unexpected` | Same — natural observation of GET responses |
| `404_for_linked_route` | GET-only crawl + link-following |
| `accessibility_critical` | axe runs on rendered DOM |
| `dom_error_text` | Text-on-page detection during render |
| `visual_anomaly` | Vision baseline runs on screenshots — no mutation |
| `axe_color_contrast_strong` | Static DOM inspection |
| `keyboard_trap` | Keyboard navigation only — no API calls beyond the natural ones the page makes |
| `focus_lost_after_action` | Same — focus-after-Tab is a render-time signal |
| `image_missing_alt` | Static DOM inspection |
| `form_input_unlabeled` | Static DOM inspection |
| `interactive_element_missing_accessible_name` | Static DOM inspection |
| `seo_title_missing` | HTML head inspection |
| `seo_title_duplicate_across_routes` | HTML head inspection across crawled routes |
| `seo_meta_description_missing` | Same |
| `seo_canonical_missing` | Same |
| `seo_h1_missing_or_multiple` | Same |
| `seo_robots_blocking_crawl` | Same |
| `slow_lcp` | Web vitals from rendered pages |
| `slow_inp` | INP from natural render |
| `high_cls` | CLS during render |
| `oversized_bundle` | Bundle probe is filesystem-side, no app interaction |
| `missing_csp_header` | GET request to origin to read response headers — read-only |
| `permissive_cors` | Same — header inspection |
| `cookie_security_flags` | Header inspection on naturally-occurring login (which itself happens via the existing browser-login flow whose POST to `/login` is the *one* sanctioned exception — see §5.4) |
| `vulnerable_dependency_high` | npm audit on local source — no app interaction |
| `hardcoded_credentials_in_source` | Static analysis of local source |
| `swallowed_error_empty_catch` | Static analysis of local source |
| `stack_trace_leak_in_response` | Detected on any GET response that leaks a stack trace |
| `sensitive_data_in_url` | URL inspection during crawl |
| `hallucinated_route` | Static + GET-probe (404 confirms hallucination — read-only) |
| `excessive_re_renders` | Render-time observation |
| `main_thread_blocked` | Long-task observation during render |

### 5.2 Always-skip kinds (require mutation)

| BugKind | Why it's skipped + skipReason |
|---|---|
| `csrf_missing_on_mutating_route` | By definition requires a mutating route. Skip with `read_only_csrf_no_mutating_routes_to_test`. |
| `open_redirect` | Some open-redirect probes are GET; but the V07 detector uses POST in some flows. Skip whole detector under read-only. |
| `idor_horizontal` | Conditional — see §5.3 |
| `idor_vertical_role_escalate` | Same — see §5.3 |
| `auth_bypass_via_unauthed_route` | Conditional — see §5.3. Read-only for read-side bypass. |
| `no_rate_limit_on_login` | Required POSTing 50 logins. Skip with `read_only_auth_probe_disabled`. |
| `race_condition_double_submit` | V19 entirely off |
| `race_condition_click_navigate` | V19 entirely off |
| `race_condition_optimistic_revert` | V19 entirely off |
| `race_condition_interleaved_mutations` | V19 entirely off |
| `race_condition_cross_tab` | V19 entirely off |
| `sql_injection` | V16 pen-testing off |
| `command_injection` | V16 off |
| `path_traversal` | V16 off |
| `jwt_weak_alg` | Some JWT probes are POST (forging tokens against POST endpoints); some are GET. Skip whole detector for safety; revisit in V46. |
| `xss_reflected` | Requires planting payloads in form fields → POST. Skip. |
| `xss_dom` | DOM XSS via URL params COULD be GET-only but the V07 implementation also uses POST bodies. Skip in V45; V46 may add a GET-only path. |
| `xss_stored` | Storage requires POST. Skip. |
| `auth_session_fixation` | Requires login + re-login → POST. Skip. |
| `password_reset_token_reuse` | Requires multiple POSTs to consume-reset endpoint. Skip. |
| `request_dedup_missing` | Detected during synthetic action sequences (mutating). Skip. |
| `request_cancellation_missing` | Same — synthetic mutating sequence required. Skip. |
| `n_plus_one_api_calls` | Conditional — see §5.3 |
| `unbounded_list_render` | Render-time signal, but the trigger to render a large list often requires creating data. Skip if the detector requires synthetic data; otherwise fire. Conditional. |
| `memory_leak_suspected` | Conditional — see §5.3 |
| `memory_leak_attributed` | Conditional — see §5.3 |
| `unhandled_exception` | Fires naturally during render — keep. (Listed in 5.1.) |
| `surface_call_failed` | Disabled — surface_call only fires for read-only tools, so a failure here is meaningful but rarer. Keep firing for the read-only subset. |
| `missing_state_change` | Mutating-action signal (we click and expect state to change). Skip — the trigger requires a mutation. |

### 5.3 Conditional / narrowed kinds

| BugKind | Read-only behavior |
|---|---|
| `idor_horizontal` | Fires for read-only tool replays only (V21 narrowing in §4.4). Read-side IDOR is preserved. |
| `idor_vertical_role_escalate` | Same — read-only replay matrix |
| `auth_bypass_via_unauthed_route` | Anonymous catalog sweep continues against read-only tools. A `GET /api/admin/users` returning 200 to anonymous is still a finding. |
| `n_plus_one_api_calls` | Fires during natural navigation (read-side N+1 like list pages with per-row GETs is the most common pattern anyway). Skip cases that require triggering a mutation to surface the N+1. |
| `unbounded_list_render` | Fires only on render of an existing route with existing data. Don't synthesize 1000 rows via POST. |
| `memory_leak_suspected` / `_attributed` | Fires during natural navigation across N pages. Action-based heap-diff scenarios that mutate are skipped. |
| `visual_anomaly` | Unchanged — vision baseline is render-only |

### 5.4 The browser-login exception

The browser-login flow (`discovery/browser-login.ts`) issues a POST to `/login` (or whatever the auth endpoint is). This is the *only* sanctioned mutation in `--read-only` mode. Rationale: without login, almost every detector is useless on a real app. The mutation is per-role, idempotent (creates a session, doesn't write business data), and goes through the normal auth flow the user is already trusted to perform.

This exception is documented prominently in `--help` text and in the `--read-only` warning banner. If a user genuinely wants zero mutations including login, they can pass `--no-browser-login` (existing flag) and accept that anonymous-only discovery is the only path.

### 5.5 Vision and perf — both fire, both useful

Vision baseline is the highest-value detector under `--read-only` because it requires zero mutation and surfaces the largest number of distinct findings (layout, content, state, error categories). Documented in `--help` as the recommended pairing: `bughunter run --read-only --vision`.

Perf vitals likewise — natural render LCP/INP/CLS surfaces real user-facing perf issues. Document the pairing.

---

## 6. CLI surface

### 6.1 New flag

```
bughunter run --read-only
```

In `--help`:
```
  --read-only                 Disable all mutating actions. No POST/PATCH/PUT/DELETE
                              against the target. Disables: race-conditions, pen-testing,
                              synthetic, auth-flow, auth-probe, XSS canaries, V42
                              data-integrity, V20 network-fault on mutating endpoints.
                              Narrows: cross-user IDOR to read-only replays.
                              Always-fire: SEO, a11y, perf vitals, vision, static analysis,
                              naturally-occurring 5xx/4xx, render-only visual anomalies.
                              Browser-login POST is the one sanctioned exception
                              (use --no-browser-login to suppress).
                              Recommended for staging audits. Not sufficient for
                              production audits — see --target production-i-know-what-im-doing
                              (V46, deferred).
```

### 6.2 Env var equivalent

```
BUGHUNTER_READ_ONLY=1
```

For CI templates. CLI flag takes precedence over env var; env var takes precedence over config-file `readOnly: true`.

### 6.3 Banner

When `readOnly === true`, print at run start:

```
[read-only mode]
  Disabled subsystems: raceConditions, penTesting, synthetic, authFlow, authProbe, V20 mutating-endpoint faults, V42 data-integrity
  Narrowed subsystems: crossUser (IDOR read-only only), xss (skipped), seedHooks (GET/OPTIONS/HEAD only)
  Browser-login POST is the only sanctioned mutation. Use --no-browser-login to suppress.
  Always-fire passive detectors: SEO, a11y, vision, perf vitals, static analysis, naturally-observed 5xx/4xx
```

Banner is printed once at startup and recorded in `summary.json.readOnly.banner` for reproducibility.

### 6.4 Flag interactions

| Combined flag | Behavior |
|---|---|
| `--read-only --race-conditions` | `--race-conditions` is silently overridden; warn at startup |
| `--read-only --enable-pen-testing` | Same — warn and override |
| `--read-only --no-browser-login` | Both honored — anonymous-only discovery, zero mutations |
| `--read-only --include-external` | Both honored — but `--include-external` is moot under `--read-only` because external-mutating tools are gated regardless |
| `--read-only` + `config.json` has `raceConditions.enabled = true` | CLI wins — disabled |
| `--read-only --reset` | Mutually exclusive — CLI errors at startup with "incompatible flags" |

---

## 7. Acceptance criteria

### 7.1 Functional
- A1. `bughunter run --read-only` against a staging-equivalent fixture (see §10) produces `summary.json` with `readOnly.enabled: true`.
- A2. `summary.json.readOnly.droppedTestCases` is > 0 (some tests were filtered) and matches the count of plan-skipped reasons starting with `read_only_`.
- A3. A recording proxy attached to the target sees ZERO non-GET/HEAD/OPTIONS requests originating from BugHunter, EXCEPT the browser-login POST (one per role).
- A4. The harness in §10.5 asserts `0` mutating requests; CI fails the test if any are observed.
- A5. SEO, a11y baseline (with `--a11y`), and perf-vitals (with `--enable-perf`) detections still fire normally — verified by detection counts >= existing baseline against the same fixture without `--read-only`.
- A6. `MutatingActionRejectedError` is thrown if a hand-crafted mutating `Action` reaches `runUiTest` or `runApiTest` while `readOnly === true` (this is the Tier 3 backstop test).

### 7.2 Non-regression
- A7. Without `--read-only`, behavior is byte-identical to pre-V45 main. Every existing test passes unchanged.
- A8. The V21 cross-user `sideEffectClass !== 'safe'` filter remains in place even without `--read-only`.

### 7.3 Schema integrity
- A9. `BugHunterConfig.readOnly?: boolean` is the only new field on `BugHunterConfig`.
- A10. `SeedHookShell.readOnlyAllowed?: boolean` is the only new field on existing seed-hook types.
- A11. `MutatingActionRejectedError` is exported as a named class.
- A12. `RunSummary.readOnly?: { enabled: boolean; droppedTestCases: number; droppedSubsystems: string[]; blockedAtRuntime: number; banner: string }` is the only new field on `RunSummary`.

### 7.4 Telemetry
- A13. `summary.json.skippedReasons` includes per-reason counts for `read_only_skipped_mutating_tool`, `read_only_skipped_mutating_form`, `read_only_skipped_unknown_button`, `read_only_skipped_xss_disabled`, `read_only_skipped_seed_hook`.
- A14. `summary.json.readOnly.blockedAtRuntime === 0` on the canonical fixture (Tier 2 catches everything; Tier 3 is the alarm bell).

---

## 8. Files

### 8.1 Read before writing code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | Add `readOnly` to `BugHunterConfig`, `RunSummary.readOnly` block, `MutatingActionRejectedError` (or `errors.ts` if size is a concern). Add `readOnlyAllowed` to `SeedHookShell`. |
| `packages/cli/src/cli/run.ts` | Add Tier 1 subsystem gating after `resolvedConfig` resolution. Add banner emission. |
| `packages/cli/src/cli/main.ts` | Add `--read-only` flag parsing; thread to `RunOptions.readOnly`. Add `BUGHUNTER_READ_ONLY` env-var resolution with the right precedence. |
| `packages/cli/src/phases/plan.ts` | Add Tier 2 filter: build `readOnlyToolIds`, gate every test-case-emitting branch. |
| `packages/cli/src/phases/execute.ts` | Add Tier 3 `assertReadOnlyAllowed` at the top of `runUiTest` and `runApiTest`. |
| `packages/cli/src/phases/cross-user.ts` | Tighten Tier 4: in cross-role replay loop, skip `!isReadOnlyTool(tool)` when `config.readOnly === true`. Anonymous sweep already gates `sideEffectClass !== 'safe'`; keep + add method check. |
| `packages/cli/src/seed/runner.ts` | Tier 5 seed-hook gating; skip non-GET HTTP hooks; skip shell hooks without `readOnlyAllowed: true`. |
| `packages/cli/src/util/read-only.ts` | NEW — single home for `isReadOnlyTool(t)`, `isReadOnlyAction(a, catalog)`, and `MutatingActionRejectedError`. ~80 lines. |
| `packages/cli/src/util/read-only.test.ts` | NEW — pure unit tests for the predicates. |
| `packages/cli/src/phases/plan.test.ts` | Extend — add a `readOnly: true` case asserting all mutating test cases are filtered. |
| `packages/cli/src/phases/cross-user.test.ts` | Extend — add a `readOnly: true` case asserting only safe GET tools are replayed. |
| `packages/cli/src/cli/run-read-only.test.ts` | NEW — integration test wiring a recording-proxy harness; asserts 0 non-GET hits the target except browser-login. |

### 8.2 Files to NOT touch

- SurfaceMCP source. No SurfaceMCP changes — read-only is a BugHunter-side filter.
- `packages/cli/src/discovery/browser-login.ts`. The login POST is the sanctioned exception; do not gate it.
- Any V-spec markdown other than this one. No edits to V21/V19/V16 specs as part of V45.
- Detector emission code (analyze.ts/classify.ts). The filter is at the action layer; detectors are unchanged.

### 8.3 Files to maybe-touch (defensive, only if tests fail)

- `packages/cli/src/phases/click-runner.ts` / `form-submit-runner.ts` — should already only be invoked from filtered test cases. If a test reveals these can be entered with a mutating action, add an `assertReadOnlyAllowed` at the top.
- `packages/cli/src/phases/race-runner.ts` / `auth-flow.ts` / pen-testing module — should already be unreachable when their subsystem is disabled. If reachable, add an `assert` not a re-filter (the subsystem-level disable in Tier 1 should be sufficient).

---

## 9. Definition of Done

- DoD-1. `--read-only` flag accepted by CLI; `BUGHUNTER_READ_ONLY=1` env var equivalent works; precedence is CLI > env > config.
- DoD-2. All five tiers of gating are implemented and unit-tested.
- DoD-3. The integration test (§10) passes: zero mutating requests reach the target except the sanctioned browser-login POST.
- DoD-4. `summary.json.readOnly` block is emitted with correct counts.
- DoD-5. `npx tsc --noEmit` is clean. `npx eslint . --max-warnings 0` is clean. `npx vitest run` is green.
- DoD-6. Banner emitted at startup; matches §6.3 exactly.
- DoD-7. `--help` text updated with the new flag.
- DoD-8. Per-`BugKind` carve-out documented in code as a runtime-checkable map (so we can add a future `bughunter detectors --read-only` command that prints which kinds fire).
- DoD-9. README adds a "Staging audit" subsection pointing to `--read-only`.
- DoD-10. The non-regression check (A7) passes — pre-V45 main behavior is byte-identical without the flag.

---

## 10. Test plan

### 10.1 Unit tests — `util/read-only.test.ts`

- `isReadOnlyTool(GET, safe) === true`
- `isReadOnlyTool(GET, mutating) === false` (a GET classified mutating by SurfaceMCP — rare but real)
- `isReadOnlyTool(POST, safe) === false`
- `isReadOnlyTool(HEAD, safe) === true`
- `isReadOnlyTool(OPTIONS, safe) === true`
- `isReadOnlyAction({kind: 'render'}, ...) === true`
- `isReadOnlyAction({kind: 'navigate'}, ...) === true`
- `isReadOnlyAction({kind: 'click', toolId: undefined}, ...) === false` (conservative — unknown click is mutating)
- `isReadOnlyAction({kind: 'click', toolId: <safeGetTool>}, ...) === true`
- `isReadOnlyAction({kind: 'submit', toolId: <postTool>}, ...) === false`
- `isReadOnlyAction({kind: 'api_call', toolId: <safeGetTool>}, ...) === true`
- `MutatingActionRejectedError` extends `Error` with a `.code = 'MUTATING_ACTION_REJECTED'` field

### 10.2 Plan-phase tests — `phases/plan.test.ts` extension

- Given a discovery output with 1 GET tool + 1 POST tool, `runPlan` with `readOnly: true` produces test cases only for the GET tool. `skipReasonCounts['read_only_skipped_mutating_tool'] === 1`.
- Given a form whose `apiToolIds` resolves to a POST tool, `formTestCases` is fully skipped under `readOnly: true`.
- Given a button element with no resolved `apiToolIds`, the click test case is skipped under `readOnly: true` (`read_only_skipped_unknown_button`).
- Without `readOnly`, behavior is unchanged (snapshot match against existing test).

### 10.3 Cross-user tests — `phases/cross-user.test.ts` extension

- With `readOnly: true` and discoveredIds containing both GET and POST tools, the replay matrix only fires for GET tools.
- Anonymous catalog sweep continues to filter `sideEffectClass !== 'safe'`; with `readOnly: true`, additionally requires GET/HEAD/OPTIONS method.

### 10.4 Runtime backstop test — new `phases/execute.test.ts` block

- Hand-craft a `TestCase` with `action.kind: 'submit'` and a mutating `toolId`. Force-feed it to `runUiTest` with `config.readOnly: true`. Assert `MutatingActionRejectedError` is thrown.
- Same for `runApiTest`.

### 10.5 Integration harness — `cli/run-read-only.test.ts`

A "recording proxy" harness:
1. Spin up a tiny echo server that records every incoming request to an in-memory log.
2. Configure SurfaceMCP (in test fixture) with a tool catalog containing GETs and POSTs against the echo server.
3. Run `bughunter run --read-only` against the fixture.
4. Assert: every request in the recorded log is `GET` / `HEAD` / `OPTIONS`, except *exactly one* `POST /login` (the browser-login).
5. Repeat without `--read-only`; assert mutating requests appear (sanity check the harness).

This is the binary acceptance test for V45.

### 10.6 Per-BugKind smoke

Run V45 against `Aspectv3` (which has known SEO + a11y + vision findings) with `--read-only --a11y --seo --vision`. Verify:
- `summary.json.bugs_filed > 0`
- `byKind` contains entries for `seo_*`, `a11y_*` / `image_missing_alt` / etc., `visual_anomaly`
- No entries for `xss_*`, `race_condition_*`, `sql_injection`, `command_injection`, `path_traversal`, `jwt_weak_alg`, `csrf_missing_on_mutating_route`, `password_reset_*`, `auth_session_fixation`, `no_rate_limit_on_login`
- `summary.json.skippedReasons` contains `read_only_*` entries

---

## 11. Open questions

1. **Should `--read-only` imply `--no-browser-login`?** Current spec says no (login is the sanctioned exception). Argument for yes: even login mutates session state on the server, and a paranoid user wants zero writes. Argument for no: without login, almost every detector is useless. Decision pending: ship as "login allowed by default; `--no-browser-login` available." Revisit after first staging-audit user feedback.
2. **Per-tool override allowlist** — should we accept a config field like `readOnlyAllowedToolIds: string[]` for users who know that `POST /api/heartbeat` is read-only-equivalent in their app? Defer to V46. The `readOnlyAllowed` field on shell hooks is the precedent; tool-level might follow.
3. **Should the V21 IDOR read-only narrowing be the default even without `--read-only`?** Strong argument for yes from a "least surprise" standpoint — most users probably don't expect IDOR cross-role to fire mutating requests. But it's a behavior change to V21 semantics; defer to a separate V-spec discussion.
4. **What about HEAD probes that return secrets in headers?** HEAD is read-only by HTTP semantics; we treat it as safe. If a server *does* mutate on HEAD, that's a server bug we'd want to flag (separate detector). Out of scope here.
5. **What about CONNECT/TRACE?** Both are arguably read-only but very rarely useful. We don't generate them today. Treat as forbidden under read-only — only GET/HEAD/OPTIONS are allowed.
6. **Should `MutatingActionRejectedError` be fatal or per-test?** Current spec says fatal. Argument for per-test: a single bad test case shouldn't kill a run. Argument for fatal: if Tier 2 is correct, this never fires; if it does fire, we have a gating bug and want to surface it loud. Decision: fatal in v0.45; revisit if false-positives surface.
7. **Are there detectors that WOULD work under read-only but require a small refactor?** Yes — `xss_dom` via URL-param-only (`?q=<script>`) is GET-only, but the V07 implementation also threads through POST bodies. A V46 follow-up could carve out a `xss_dom_get_only` mode. Don't block V45 on it.
8. **Should we redact the recording-proxy assertion for production targets?** Out of scope — V46 production-mode spec will define logging redaction. V45 staging-audit assumes the user controls the staging environment and can read full logs.
9. **Does `--read-only` interact with `--reset`?** `--reset` runs a user-provided `resetCommand` which probably mutates the database. Decision: `--read-only` and `--reset` are mutually exclusive. Pass both → CLI errors out at startup with "incompatible flags."
10. **Is there a "soft read-only" mode that warns instead of filters?** No. Binary is correct here. Soft modes invite false-confidence. The whole point of the flag is "I can ship this against staging without thinking about it."

---

## 12. Risks + escape hatches

- **Risk:** A new test-case branch lands in `plan.ts` (e.g. for V47 future detector) without read-only gating. Tier 2 misses it; Tier 3 catches it at runtime; run aborts. Loud failure → fast fix. The runtime backstop is the safety net.
- **Risk:** `sideEffectClass` from SurfaceMCP is wrong (a tool labeled `safe` actually mutates). V45 inherits SurfaceMCP's classification; if it's wrong, V45 is wrong. Mitigation: SurfaceMCP classification is conservative by default (defaults to `mutating` when unknown). Document this dependency.
- **Risk:** A user's app has a `GET /api/users/delete` (anti-pattern but exists). SurfaceMCP should classify as `mutating`. If it doesn't, V45 lets it through. This is a SurfaceMCP bug, not a V45 bug — surface in spec for awareness.
- **Risk:** The browser-login flow uses a non-POST mutation (e.g. PATCH for password update during login). Edge case — covered by the existing browser-login allowlist (only the auth endpoint is allowed). If the auth flow involves multiple mutations, document and consider tightening.
- **Escape hatch:** `--no-browser-login` for users who genuinely want zero mutations including login.
- **Escape hatch:** If the runtime backstop is too aggressive, users can disable it via `BUGHUNTER_READ_ONLY_NO_RUNTIME_GUARD=1` (not a CLI flag — env-only, undocumented; for our own debugging). Removed before GA.

---

## 13. Killer-demo runbook (staging audit on a target)

```bash
# Against a staging environment with read data the user does NOT want to mutate.
# Assumes SurfaceMCP is already configured for the target (port 3107 etc.).

# 1. Run BugHunter in read-only mode, all passive detectors enabled.
cd ~/my-staging-project && \
  bughunter run \
    --read-only \
    --a11y --a11y-strict \
    --seo \
    --enable-perf --enable-bundle-probe \
    --max-bugs 200 \
    --budget 2400000

# 2. Verify the recording-proxy harness saw zero mutations (CI guard).
# (In production this is wired into CI; locally inspect summary.json.)
RUN=$(ls -t .bughunter/runs/ | head -1)
jq '.readOnly' .bughunter/runs/$RUN/summary.json
# Expect: { "enabled": true, "droppedTestCases": 47, "blockedAtRuntime": 0, ... }

# 3. Inspect per-kind:
jq '.byKind' .bughunter/runs/$RUN/summary.json
# Expect: SEO/a11y/perf/visual_anomaly/idor_horizontal entries; no xss/race/sql.
```

Expected outcome: rich findings on a staging environment with cryptographic certainty that BugHunter touched nothing it shouldn't have.

---

*End of SPEC_V45_READ_ONLY_MODE.md.*
