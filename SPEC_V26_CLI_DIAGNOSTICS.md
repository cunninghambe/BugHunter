# SPEC — v0.26 "CLI diagnostics & introspection"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Predecessor:** `SPEC_PATH_TO_EXHAUSTIVE.md` §4.1 (the strategic gap analysis) · **Sibling:** v0.18 JWT login verify (format reference). · **Phase:** B — surface programmability (CLI parity with intent).

This spec lands the five diagnostics CLI commands the path-to-exhaustive doc enumerated in §4.1. They share a single concern: **make BugHunter introspectable from the shell.** No new detection. No new auto-fix logic. No new MCP tools (deferred to v0.27 per §5). No cross-run history (v0.27), suppression (v0.28), or export (v0.29). The bar is: a developer who has just typed `bughunter --help` can answer "is my environment healthy? what would a run do? what's wired?" without reading the source.

The hardest design call here is the `DETECTOR_REGISTRY` shape — once seeded, every future BugKind addition is gated on adding a registry entry, and the dead-detector audit gap (the one PR #53 found 22 instances of) becomes a compile-time constraint. Get this wrong and we trade one audit gap for another.

---

## 1. Objective

Add five new CLI sub-commands to `packages/cli/src/cli/main.ts`:

| Command | Purpose | Output |
|---|---|---|
| `bughunter doctor` | Environment health | Structured table; exit 0/1/2 = green/yellow/red |
| `bughunter detectors` | Per-BugKind wiring report | Table or JSON; status filterable |
| `bughunter scope` | Dry-run plan stats | Test count, runtime estimate, API call estimate |
| `bughunter inputs <toolId>` | Show planner-minted inputs for one tool | JSON list |
| `bughunter config validate` / `show` | Zod-validate / dump effective config | Exit 0/1; JSON output |

Plus a single source of truth for detector wiring in `packages/cli/src/detectors/registry.ts`.

**In scope:**
- Five new CLI commands, each in its own file under `packages/cli/src/cli/`
- One new module `packages/cli/src/detectors/registry.ts` with `DETECTOR_REGISTRY` seed for every BugKind in the union (`packages/cli/src/types.ts:23-93`)
- USAGE block grouped by section in `packages/cli/src/cli/main.ts`
- Argument-parsing entries in the case-switch
- Unit tests per command (one `*.test.ts` per command file)

**Out of scope (deferred):**
- `bughunter diff` / `history` / `bisect` / `aging` — v0.27 cross-run.
- `bughunter suppress` / `triage` / `explain` — v0.28 triage.
- `bughunter export` / `publish` / `watch` / `ci` — v0.29 integration.
- `bughunter benchmark` / `self-test` / `calibrate` — v0.30 calibration.
- MCP equivalents (`bughunt_detectors`, `bughunt_project_describe`, …) — v0.31 MCP parity.
- `last-fired-at` for detectors — depends on cross-run history DB landing in v0.27. Until then, registry reports `"history-not-available"` for that field.
- Sub-namespacing (`bughunter run / status` vs `bughunter detectors list`) — flat namespace stays for v0.26; reorganization is a v0.32 cosmetic.

**Acceptance target:**
- `bughunter doctor` on a clean Aspectv3 checkout returns exit 0 and prints a green table.
- `bughunter detectors --format json` lists every BugKind from `types.ts:23-93` with no `status: "missing"` entries.
- `bughunter scope --route '/dashboard*'` prints a test count that matches an actual `--route '/dashboard*' --dry` run within ±5%.
- `bughunter inputs <existing-toolId> --palette happy` round-trips through `apiTestCases` and prints the same `input` object the planner would mint.
- `bughunter config validate` on a config with a typo'd field prints a multi-issue Zod error and exits 1.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/cli/main.ts:18-72` | USAGE block — extend with five new commands grouped under a `Diagnostics & introspection:` heading. |
| `packages/cli/src/cli/main.ts:74-96` | `parseArgs` — the existing flag parser. Reuse as-is; new commands plug into `flags`/`args` the same way. |
| `packages/cli/src/cli/main.ts:110-235` | `switch (command)` — add five new `case` blocks. Pattern: extract typed flags, call command function, break. |
| `packages/cli/src/cli/init.ts` | Simple-command pattern reference — file exports `*Command(projectDir, opts?)`, returns void/Promise<void>, uses `log` + `process.stdout.write`. Mirror for every new file. |
| `packages/cli/src/cli/list.ts` | Read-only command pattern — pure filesystem reads, no side effects. Mirror for `detectors`, `scope`, `inputs`, `config show`. |
| `packages/cli/src/cli/status.ts` | `process.exitCode = 1` on missing-resource pattern. Mirror for `doctor` + `config validate`. |
| `packages/cli/src/cli/palette.ts` | Existing diagnostic command — shows palette tables. Pattern for `detectors` table output and for the orphan-fixture detection in `config validate`. |
| `packages/cli/src/types.ts:23-93` | `BugKind` union — every entry must appear in `DETECTOR_REGISTRY`. Walk this in source order when seeding. |
| `packages/cli/src/types.ts:955-1053` | `BugHunterConfig` — `discoveryFixtures` and `bodyFixtures` are the orphan-detection targets in `config validate`. |
| `packages/cli/src/config.ts` | `ConfigSchema`, `loadConfig`, `resolvedConfig`, `effectiveForbiddenPaths`. `config validate` re-runs `safeParse`; `config show` calls `loadConfig` (raw) or `resolvedConfig` (resolved). |
| `packages/cli/src/adapters/surface-mcp.ts:211-257` | `HttpSurfaceMcpAdapter.mcpCall` — `doctor` reuses by calling `surface_describe_self` for reachability. |
| `packages/cli/src/adapters/browser-mcp.ts:149-200` | `CamofoxBrowserMcpAdapter.mcpCall` — `doctor` reuses by calling `listTabs` for reachability. |
| `packages/cli/src/adapters/vision-auth-detect.ts:50-65` | `detectVisionAuth(env)` — `doctor` calls this verbatim; output goes into the auth row. |
| `packages/cli/src/store/filesystem.ts` | `runPaths`, `listRunIds` — `doctor` uses for runs-dir health; `detectors` will use once history-DB lands in v0.27. |
| `packages/cli/src/mutation/apply.ts:54-153` | `apiTestCases` + `buildApiInput` — `inputs` command invokes these directly. |
| `packages/cli/src/phases/validate.ts:21-71` | `runValidate` — `scope` reuses for the validate phase. |
| `packages/cli/src/phases/discover.ts:30` | `runDiscover` — `scope` reuses for the discover phase. |
| `packages/cli/src/phases/plan.ts:13-50` | `runPlan` returns `PlanResult` with `testCases`, `projectedRuntimeMs`, `skipReasons`. `scope` consumes this directly. `AVG_TEST_MS = 7500` is the runtime estimate constant; reuse. |
| `packages/cli/src/cli/run.ts:45-82` | `RunOptions` — `scope` accepts the same shape (subset) so `bughunter scope --route X --role Y` matches `bughunter run --route X --role Y`. |
| `packages/cli/src/log.ts` | `log.info`, `log.warn`, `log.error` — use for telemetry; user output goes to `process.stdout.write`, not log. |

### 2.2 Detector source-file map (used to seed `DETECTOR_REGISTRY`)

The `kind: '<kind>'` literal is grep-able at exactly one canonical site for each wired BugKind. The map below is what `bughunter detectors` will report as the wiring location.

| BugKind (from `types.ts`) | Wiring file:line | Status |
|---|---|---|
| `console_error` | `packages/cli/src/classify/console.ts:24` | wired |
| `react_error` | `packages/cli/src/classify/react.ts:45` | wired |
| `hydration_mismatch` | `packages/cli/src/classify/react.ts:38` | wired |
| `network_5xx` | `packages/cli/src/classify/network.ts:17` (also :28 + cross-user.ts:183) | wired |
| `network_4xx_unexpected` | `packages/cli/src/classify/network.ts:44` | wired |
| `404_for_linked_route` | `packages/cli/src/classify/network.ts:55` | wired |
| `missing_state_change` | `packages/cli/src/classify/state-change.ts:27` | wired |
| `unhandled_exception` | `packages/cli/src/classify/console.ts:22` (returned from `classifyConsole`) | wired |
| `accessibility_critical` | `packages/cli/src/classify/accessibility.ts:36` | wired |
| `dom_error_text` | `packages/cli/src/classify/dom-error-text.ts:28` | wired |
| `surface_call_failed` | `packages/cli/src/phases/execute.ts:925` | wired |
| `visual_anomaly` | `packages/cli/src/classify/vision.ts:411` | wired |
| `missing_csp_header` | `packages/cli/src/security/header-probe.ts:86` (also :99) | wired |
| `permissive_cors` | `packages/cli/src/security/header-probe.ts:121` | wired |
| `cookie_security_flags` | `packages/cli/src/security/header-probe.ts:152` | wired |
| `csrf_missing_on_mutating_route` | (no detector site) | **deferred** — `SPEC_PATH_TO_EXHAUSTIVE.md` Phase A backlog |
| `open_redirect` | `packages/cli/src/security/header-probe.ts:261` | wired |
| `sensitive_data_in_url` | `packages/cli/src/security/header-probe.ts:231` | wired |
| `stack_trace_leak_in_response` | `packages/cli/src/security/header-probe.ts:205` | wired |
| `vulnerable_dependency_high` | `packages/cli/src/static/tools/npm-audit.ts:31` | wired |
| `hardcoded_credentials_in_source` | `packages/cli/src/static/tools/gitleaks.ts:30` (also `semgrep.ts:46`) | wired |
| `swallowed_error_empty_catch` | `packages/cli/src/static/tools/eslint-no-empty.ts:36` | wired |
| `idor_horizontal` | `packages/cli/src/phases/cross-user.ts:164` | wired |
| `idor_vertical_role_escalate` | `packages/cli/src/phases/cross-user.ts:244` | wired |
| `auth_bypass_via_unauthed_route` | `packages/cli/src/phases/cross-user.ts:328` | wired |
| `no_rate_limit_on_login` | `packages/cli/src/security/auth-probes.ts:75` | wired |
| `race_double_submit` | (no detector site) | **deferred** |
| `optimistic_update_divergence` | (no detector site) | **deferred** |
| `hallucinated_route` | (no detector site) | **deferred** — Phase A backlog |
| `sql_injection` | `packages/cli/src/security/pen-detectors.ts:96` (also :157) | wired |
| `command_injection` | `packages/cli/src/security/pen-detectors.ts:192` | wired |
| `path_traversal` | `packages/cli/src/security/pen-detectors.ts:241` | wired |
| `jwt_weak_alg` | `packages/cli/src/security/pen-detectors.ts:284` | wired |
| `xss_reflected` | `packages/cli/src/phases/execute.ts:1014` | wired |
| `xss_dom` | `packages/cli/src/phases/execute.ts:688` | wired |
| `xss_stored` | (placeholder, v0.8) | **deferred** |
| `auth_session_fixation` | `packages/cli/src/phases/auth-flow.ts:135` | wired |
| `password_reset_token_reuse` | `packages/cli/src/phases/auth-flow.ts:178` (also :198) | wired |
| `slow_lcp` | `packages/cli/src/classify/vitals.ts:26` | wired |
| `slow_inp` | `packages/cli/src/classify/vitals.ts:45` | wired |
| `high_cls` | `packages/cli/src/classify/vitals.ts:65` | wired |
| `unbounded_list_render` | `packages/cli/src/classify/unbounded-list.ts:125` | wired |
| `n_plus_one_api_calls` | `packages/cli/src/classify/request-hygiene.ts:50` | wired |
| `request_dedup_missing` | `packages/cli/src/classify/request-hygiene.ts:114` | wired |
| `request_cancellation_missing` | `packages/cli/src/classify/request-hygiene.ts:161` | wired |
| `main_thread_blocked` | `packages/cli/src/classify/long-tasks.ts:19` | wired |
| `oversized_bundle` | `packages/cli/src/phases/bundle-probe.ts:67` (also :80) | wired |
| `excessive_re_renders` | `packages/cli/src/classify/rerenders.ts:51` | wired |
| `memory_leak_suspected` | `packages/cli/src/classify/memory-leak.ts:54` | wired |
| `memory_leak_attributed` | `packages/cli/src/phases/analyze.ts:93` | wired |
| `axe_color_contrast_strong` | `packages/cli/src/classify/a11y-baseline.ts:58` | wired |
| `keyboard_trap` | `packages/cli/src/classify/a11y-baseline.ts:95` | wired |
| `focus_lost_after_action` | `packages/cli/src/classify/a11y-baseline.ts:108` | wired |
| `image_missing_alt` | `packages/cli/src/classify/a11y-baseline.ts:70` | wired |
| `form_input_unlabeled` | `packages/cli/src/classify/a11y-baseline.ts:82` | wired |
| `interactive_element_missing_accessible_name` | `packages/cli/src/phases/execute.ts:538` | wired |
| `seo_title_missing` | `packages/cli/src/classify/seo.ts:60` | wired |
| `seo_title_duplicate_across_routes` | `packages/cli/src/classify/seo.ts:131` | wired |
| `seo_meta_description_missing` | `packages/cli/src/classify/seo.ts:69` | wired |
| `seo_canonical_missing` | `packages/cli/src/classify/seo.ts:78` | wired |
| `seo_h1_missing_or_multiple` | `packages/cli/src/classify/seo.ts:87` | wired |
| `seo_robots_blocking_crawl` | `packages/cli/src/classify/seo.ts:100` (also :109) | wired |

**Wired vs deferred totals: 56 wired / 5 deferred.** Coder mechanically extends the registry; if a kind appears in `BugKind` but not in this table, the build fails at the exhaustiveness check.

### 2.3 Patterns to follow

- **One file per command.** Each new file exports a single `*Command(projectDir, opts)` function. Mirror `init.ts` for the shape.
- **No new logging.** Use `log.info` for telemetry, `process.stdout.write` for user output. `bughunter doctor`'s table is `process.stdout.write`; nothing else is structured user output.
- **Reuse `parseArgs`.** No new arg parser. Flag values come in as `string | boolean`; coerce explicitly per call site.
- **Discriminated unions for state.** `DoctorCheckResult` and `DetectorRegistryEntry` are discriminated unions, not optional fields. Pattern: same shape as `VisionAuthDetectResult` (`vision-auth-detect.ts:7-10`).
- **Exit codes.** `process.exitCode = N`, do NOT call `process.exit()` directly — that breaks the `main()` error handler in `main.ts:240-245`.
- **JSON output goes through `process.stdout.write(JSON.stringify(x, null, 2) + '\n')`.** Match `status.ts:15`.

### 2.4 DO NOT

- Do **not** create a `detectors/` directory at the package root — registry goes in `packages/cli/src/detectors/registry.ts`. Single new directory under `src/`.
- Do **not** reach into the `phases/*` modules for anything beyond their public exports (`runValidate`, `runDiscover`, `runPlan`). `scope` runs three phase calls back-to-back; do not duplicate phase logic.
- Do **not** swallow Zod errors in `config validate`. Print every issue (mirror `init.ts:99-103` pattern but extend to multi-issue).
- Do **not** add `process.exit()` calls. Use `process.exitCode`. The main wrapper handles termination.
- Do **not** introduce a runtime dependency on the cross-run history DB — it doesn't exist yet (lands v0.27). `last-fired-at` is hard-coded `"history-not-available"`.
- Do **not** add a `--verbose` / `--quiet` flag. Use existing `log` module for telemetry.
- Do **not** print credentials, API keys, or tokens. `doctor` reports vision auth as `apiKey-present: true|false` (not the value). `config show` redacts `vision.apiKey` to `"[redacted]"` even for `--resolved`.
- Do **not** invoke a real run from `scope`. The execute phase MUST not run. Stop after plan.
- Do **not** make `inputs` mint `xss_inject` palette variants — the four canonical palettes only (`null`, `happy`, `edge`, `out_of_bounds`).
- Do **not** add new BugKinds to `types.ts` as part of this PR. The registry seeds the existing union as-is.

---

## 3. The `DETECTOR_REGISTRY`

### 3.1 File: `packages/cli/src/detectors/registry.ts`

A single new module. Imports `BugKind` from `../types.js`. Exports the registry array, the entry type, and a typed lookup helper.

```ts
import type { BugKind } from '../types.js';

export type DetectorStatus = 'wired' | 'deferred' | 'dead';

export type DetectorInputSource = 'production' | 'synthetic-only' | 'unknown';

export type DetectorRegistryEntry = {
  kind: BugKind;
  status: DetectorStatus;
  /**
   * file:line where the BugDetection literal `kind: '<kind>'` is constructed.
   * For `status: 'wired'` this is the canonical detector site.
   * For `status: 'deferred' | 'dead'` this is undefined.
   */
  detectorSite?: string;
  /**
   * file:line where the runner that supplies input to the detector lives.
   * Same as detectorSite when the detector is also the runner (e.g. the
   * pen-test runner emits its own detections inline). Undefined for static
   * analysis kinds where no runtime runner is involved.
   */
  runnerSite?: string;
  /**
   * Whether the input is observed during a real navigation/test
   * (`production`) or synthesised by an explicit probe (`synthetic-only`).
   * Static analysis kinds are `production` (source files are real input).
   */
  inputSource: DetectorInputSource;
  /** Spec file the kind was promised by, e.g. 'SPEC_V05_SECURITY_HYGIENE.md'. */
  specReference: string;
  /**
   * Human-readable note. Required for non-'wired' entries to explain why.
   */
  note?: string;
};

export const DETECTOR_REGISTRY: readonly DetectorRegistryEntry[] = [
  // — § Core (always wired) —
  {
    kind: 'console_error',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/console.ts:24',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC.md',
  },
  {
    kind: 'react_error',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/react.ts:45',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC.md',
  },
  {
    kind: 'hydration_mismatch',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/react.ts:38',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC.md',
  },
  {
    kind: 'network_5xx',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/network.ts:17',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC.md',
  },
  // — § Deferred (no detector site exists yet) —
  {
    kind: 'csrf_missing_on_mutating_route',
    status: 'deferred',
    inputSource: 'unknown',
    specReference: 'SPEC_V05_SECURITY_HYGIENE.md',
    note: 'Phase A backlog (SPEC_PATH_TO_EXHAUSTIVE.md §9). Detector promised but never wired.',
  },
  {
    kind: 'hallucinated_route',
    status: 'deferred',
    inputSource: 'unknown',
    specReference: 'SPEC.md',
    note: 'Phase A backlog. Planner-vs-served route comparison not implemented.',
  },
  {
    kind: 'race_double_submit',
    status: 'deferred',
    inputSource: 'synthetic-only',
    specReference: 'SPEC.md',
    note: 'Synthetic scenario flag exists in BugHunterConfig.synthetic but no detector site emits this kind.',
  },
  {
    kind: 'optimistic_update_divergence',
    status: 'deferred',
    inputSource: 'synthetic-only',
    specReference: 'SPEC.md',
    note: 'Same as race_double_submit.',
  },
  {
    kind: 'xss_stored',
    status: 'deferred',
    inputSource: 'unknown',
    specReference: 'SPEC_V07_XSS.md',
    note: 'Placeholder; v0.8 deliverable.',
  },
  // — coder fills the remaining ~52 entries from §2.2 mechanically —
];

/**
 * Compile-time exhaustiveness: any BugKind not in DETECTOR_REGISTRY produces a
 * type error here. New BugKinds added to types.ts MUST add a registry entry.
 */
type _ExhaustivenessCheck = Exclude<BugKind, (typeof DETECTOR_REGISTRY)[number]['kind']> extends never
  ? true
  : ['DETECTOR_REGISTRY missing entries for BugKinds:', Exclude<BugKind, (typeof DETECTOR_REGISTRY)[number]['kind']>];

export function lookupDetector(kind: BugKind): DetectorRegistryEntry | undefined {
  return DETECTOR_REGISTRY.find(e => e.kind === kind);
}
```

### 3.2 Why this shape

- **Status as discriminated union.** `wired | deferred | dead` is testable by filter; future additions like `experimental` are forward-compatible.
- **`detectorSite` optional.** Some kinds (deferred) have no site. Optional rather than empty string keeps the type honest.
- **`runnerSite` separate from `detectorSite`.** §1 of `SPEC_PATH_TO_EXHAUSTIVE.md` distinguishes these — a wired detector with a synthetic-only runner is more brittle than one with a production-path runner. The CLI surfaces both.
- **`specReference` is the spec file the kind was promised by.** Used by `bughunter detectors --kind X` to point users at the original promise. Not enforced; not validated; pure documentation.
- **`_ExhaustivenessCheck`.** Compile-time gate. If a coder adds `iframe_postmessage_unguarded` to the `BugKind` union without updating the registry, `tsc` fails. This is the lock that makes the dead-detector audit gap impossible to reintroduce.

### 3.3 Future BugKinds

Every new BugKind spec (Phase E in `SPEC_PATH_TO_EXHAUSTIVE.md`) must add its entry to the registry **in the same PR** as the BugKind addition. The exhaustiveness check enforces this; coders adding kinds without registry entries hit a TS error.

---

## 4. Per-command spec

### 4.1 `bughunter doctor`

**File:** `packages/cli/src/cli/doctor.ts` (new)

**Signature:** `export async function doctorCommand(projectDir: string, opts: { format?: 'table' | 'json' }): Promise<void>`

**USAGE addition (`main.ts:18-72`):**
```
Diagnostics & introspection:
  bughunter doctor [--format table|json]
                              Reports environment health.
                              Exit 0 = green, 1 = yellow, 2 = red.
```

**Argument parsing (`main.ts` switch case):**
```ts
case 'doctor': {
  const format = flags['format'] === 'json' ? 'json' : 'table';
  await doctorCommand(projectDir, { format });
  break;
}
```

**Checks (each runs independently; one failure does not abort others):**

| ID | Check | How | Pass condition | Severity |
|---|---|---|---|---|
| D1 | Config present + valid Zod | `loadConfig(projectDir)` (catches throw) | Returns config | red on fail |
| D2 | SurfaceMCP reachable | `new HttpSurfaceMcpAdapter(config.surfaceMcpUrl).surface_describe_self()` with 5s timeout | Resolves | red on fail |
| D3 | Browser MCP reachable | When `config.browserMcpUrl` set: `new CamofoxBrowserMcpAdapter(url).listTabs()` with 5s timeout | Resolves | yellow on fail (browser MCP is optional) |
| D4 | Vision auth | `detectVisionAuth(process.env)` (verbatim) | `kind !== 'unavailable'` | yellow on `unavailable` (vision is opt-in) |
| D5 | camofox version | `execFile('camofox', ['--version'], 1000)` if browser MCP configured | Process exits 0 | yellow on fail |
| D6 | Playwright version | Read `node_modules/playwright/package.json` `version` field if exists | File readable + JSON parses | informational only (never red/yellow) |
| D7 | Disk space | `statvfs` via `fs.statfsSync(runs-dir-parent)` (Node ≥ 18.15) — bytes-free | ≥ 1 GiB free | yellow when < 1 GiB free; red when < 100 MiB |
| D8 | Runs dir health | `listRunIds(projectDir)` does not throw; `<= 100` runs (else suggests `bughunter prune`) | Both | yellow if > 100 runs; red on read failure |
| D9 | Active hooks list | Count entries in `config.seedHooks?.{beforeRun,afterLogin,perRole,beforeExecute,cleanup}` | Always passes; informational | n/a |
| D10 | Forbidden-paths config | Print `effectiveForbiddenPaths(config)`. Always passes; informational. | Always passes; informational | n/a |

**Exit code semantics:**
- All green (no yellow/red) → exit 0
- At least one yellow, no red → exit 1
- At least one red → exit 2

**Output format (table, default):**
```
BugHunter doctor — <projectName>

  D1  Config present + valid           green   /root/Aspectv3/.bughunter/config.json
  D2  SurfaceMCP reachable             green   http://127.0.0.1:3107  rev=42 stack=vite
  D3  Browser MCP reachable            green   http://127.0.0.1:9377  tabs=0
  D4  Vision auth                      green   claudeCli  /usr/local/bin/claude
  D5  camofox version                  green   1.4.2
  D6  Playwright version               info    1.47.0
  D7  Disk space                       green   238 GiB free
  D8  Runs dir health                  green   12 runs
  D9  Active hooks                     info    seedHooks: 2 (beforeRun:1, afterLogin:1)
  D10 Forbidden paths                  info    18 entries (13 default + 5 custom)

Status: GREEN.  Exit 0.
```

**Output format (JSON):**
```json
{
  "projectName": "Aspectv3",
  "status": "green",
  "exitCode": 0,
  "checks": [
    { "id": "D1", "label": "Config present + valid", "status": "green", "detail": "/root/Aspectv3/.bughunter/config.json" },
    { "id": "D2", "label": "SurfaceMCP reachable", "status": "green", "detail": "http://127.0.0.1:3107 rev=42 stack=vite" }
  ]
}
```

**Error cases:**
- Config missing → D1 red, all subsequent checks `skipped` with `detail: "config-missing"`. Exit 2.
- Network timeout (D2/D3) → red/yellow with `detail: "timeout after 5000ms"`. Subsequent checks continue.
- `process.env` lacks both API key + Claude CLI → D4 yellow, message includes "vision will be unavailable; set ANTHROPIC_API_KEY or install claude CLI".

**Slot-in location:** `main.ts:200` (after `case 'palette'`, before `case 'prune'`) — alphabetical ordering for new diagnostic group.

---

### 4.2 `bughunter detectors`

**File:** `packages/cli/src/cli/detectors-cmd.ts` (new — `detectors.ts` would conflict with the registry directory at import time when bundlers flatten paths; using `-cmd` suffix matches existing `retest-cmd.ts`)

**Signature:** `export function detectorsCommand(projectDir: string, opts: { kind?: BugKind; status?: DetectorStatus; format: 'table' | 'json' }): void`

**USAGE addition:**
```
  bughunter detectors [--kind <bugkind>] [--status wired|dead|deferred] [--format table|json]
                              Per-BugKind wiring report.
```

**Argument parsing:**
```ts
case 'detectors': {
  const kind = typeof flags['kind'] === 'string' ? flags['kind'] as BugKind : undefined;
  const statusFlag = flags['status'];
  const status = (statusFlag === 'wired' || statusFlag === 'dead' || statusFlag === 'deferred') ? statusFlag : undefined;
  const format = flags['format'] === 'json' ? 'json' : 'table';
  detectorsCommand(projectDir, { kind, status, format });
  break;
}
```

**Implementation:**
1. Filter `DETECTOR_REGISTRY` by `kind` and/or `status` if provided.
2. For each entry, build a row:
   - `kind` (left-padded to 50 cols in table mode)
   - `status` (`wired` / `deferred` / `dead`)
   - `detectorSite` or `'-'`
   - `runnerSite` or `'-'`
   - `inputSource`
   - `specReference`
   - `lastFiredAt`: hard-coded `"history-not-available"` for v0.26 (depends on v0.27 history DB)
3. Output table or JSON.

**Output format (table, default):**
```
BugKind                                              | Status   | Detector                                   | Last fired
console_error                                        | wired    | classify/console.ts:24                     | history-not-available
csrf_missing_on_mutating_route                       | deferred | -                                          | history-not-available
hallucinated_route                                   | deferred | -                                          | history-not-available

61 entries  (56 wired, 5 deferred, 0 dead)
Spec promises: SPEC.md, SPEC_V05_SECURITY_HYGIENE.md, SPEC_V06_*, SPEC_V07_XSS.md, SPEC_V16_PEN_TESTING.md
```

**Output format (JSON):**
Direct serialization of the filtered registry array, plus a `meta` summary object:
```json
{
  "meta": { "total": 61, "wired": 56, "deferred": 5, "dead": 0 },
  "entries": [ /* DetectorRegistryEntry[] */ ]
}
```

**Exit code:** always 0. The command reports state; it does not fail.

**Error cases:**
- `--kind` value not in `BugKind` union → exit 1, message: `Unknown BugKind: <value>. Run 'bughunter detectors --format json' to list all kinds.`

**Slot-in location:** `main.ts:200` (after `doctor`).

---

### 4.3 `bughunter scope`

**File:** `packages/cli/src/cli/scope.ts` (new)

**Signature:** `export async function scopeCommand(projectDir: string, opts: ScopeOptions): Promise<void>` where:
```ts
type ScopeOptions = {
  route?: string;
  role?: string;
  format: 'table' | 'json';
};
```

**USAGE addition:**
```
  bughunter scope [--route <pattern>] [--role <name>] [--format table|json]
                              Dry-run: print the test matrix 'bughunter run' would
                              generate. Runs validate + discover + plan; skips
                              execute. NEVER mutates state.
```

**Argument parsing:**
```ts
case 'scope': {
  await scopeCommand(projectDir, {
    route: typeof flags['route'] === 'string' ? flags['route'] : undefined,
    role: typeof flags['role'] === 'string' ? flags['role'] : undefined,
    format: flags['format'] === 'json' ? 'json' : 'table',
  });
  break;
}
```

**Implementation steps:**
1. `loadConfig(projectDir)` → fail with exit 1 if missing.
2. Construct `HttpSurfaceMcpAdapter`. Optionally construct `CamofoxBrowserMcpAdapter` if `config.browserMcpUrl`.
3. Generate a synthetic `runId = 'scope-' + Date.now()`. **Do not** write to disk.
4. Call `runValidate({ surfaceMcp, browserMcp, config })`. On failure: print error and exit 1.
5. Call `runDiscover(...)` with the route filter. **Do not** run vision baseline.
6. Call `runPlan(runId, discovery, config, roles, surface)`.
7. Aggregate the `PlanResult` (`testCases`, `projectedRuntimeMs`, `skipReasons`, `upgradedToolIds`).
8. Build counts:
   - `totalTests` = `testCases.length`
   - `byKind` = histogram by `testCase.action.kind` (`click`/`fill`/`navigate`/`render`/`submit`/`api_call`)
   - `byRole` = histogram by `testCase.role`
   - `byRoute` = histogram by `testCase.page` (top 20)
   - `byPalette` = histogram by `testCase.action.palette`
   - `apiCallCount` = `testCases.filter(t => t.action.via === 'api').length`
   - `projectedRuntimeMs` = the `PlanResult.projectedRuntimeMs` field (already computed by `runPlan` using `AVG_TEST_MS = 7500`)
   - `skippedRoutes` = `discovery.skipList.filter(s => s.route !== undefined)`
   - `skipReasons` = the `PlanResult.skipReasons` field

**Output (table, default):**
```
BugHunter scope — Aspectv3
Filters: route=/dashboard*  role=owner

Total tests planned:   142
By role:               owner: 142
By route (top 5):      /dashboard:48  /dashboard/trades:38  /dashboard/settings:24  …
By action kind:        api_call:96  click:24  fill:14  navigate:8
By palette:            happy:36  edge:36  null:35  out_of_bounds:35

Projected runtime:     17m 45s (142 × 7.5s avg)
Projected API calls:   96
Skipped routes:        3
  - /admin/super       reason: role-not-permitted
  - /api/health        reason: noProbe
  - /static/error      reason: lazy-load-failed

Plan upgrades:         0 unknown-confidence tools probed
```

**Output (JSON):**
```json
{
  "filters": { "route": "/dashboard*", "role": "owner" },
  "totalTests": 142,
  "byRole": { "owner": 142 },
  "byRoute": { "/dashboard": 48, "/dashboard/trades": 38 },
  "byKind": { "api_call": 96, "click": 24, "fill": 14, "navigate": 8 },
  "byPalette": { "happy": 36, "edge": 36, "null": 35, "out_of_bounds": 35 },
  "projectedRuntimeMs": 1065000,
  "projectedApiCalls": 96,
  "skippedRoutes": [{ "route": "/admin/super", "reason": "role-not-permitted" }],
  "skipReasons": [{ "reason": "role-not-permitted", "count": 1 }],
  "upgradedToolIds": []
}
```

**Exit code:** 0 on success, 1 on validate/discover/plan failure.

**Error cases:**
- SurfaceMCP unreachable → propagate the validate error, exit 1, message includes the URL and the underlying error.
- No matching routes after filter → `totalTests: 0`, exit 0, table shows `Total tests planned: 0` and a yellow advisory: "No tests match the route/role filter. Try without --route to confirm discovery is finding pages."

**Negative requirement (CRITICAL):** `runExecute`, `runClassify`, `runCluster`, `runEmit` MUST NOT be called. Verifier: an `assert(false, 'execute path reached from scope')` placed in execute.ts during a smoke test should NOT fire.

**Slot-in location:** `main.ts:200` (after `detectors`).

---

### 4.4 `bughunter inputs <toolId>`

**File:** `packages/cli/src/cli/inputs-cmd.ts` (new — `inputs.ts` collides with potential future `inputs/` directory; `-cmd` suffix matches `retest-cmd.ts`)

**Signature:** `export async function inputsCommand(projectDir: string, toolId: string, opts: { palette?: PaletteVariant; format: 'json' }): Promise<void>` — output format is JSON-only; `format` is reserved for forward compat.

**USAGE addition:**
```
  bughunter inputs <toolId> [--palette null|happy|edge|out_of_bounds]
                              For one tool, print the test inputs the planner
                              would mint. Output: JSON list of {palette, input}.
                              Useful for debugging fuzz strategies.
```

**Argument parsing:**
```ts
case 'inputs': {
  const toolId = args[0] ?? '';
  if (toolId === '') throw new Error('Usage: bughunter inputs <toolId> [--palette <variant>]');
  const palette = typeof flags['palette'] === 'string' ? flags['palette'] as PaletteVariant : undefined;
  await inputsCommand(projectDir, toolId, { palette, format: 'json' });
  break;
}
```

**Implementation:**
1. `loadConfig(projectDir)`.
2. Construct `HttpSurfaceMcpAdapter`.
3. Resolve role: `config.roles?.[0] ?? 'anonymous'`.
4. Call `surface.surface_describe_tool({ toolId })` to get the `ToolMeta`. On failure: exit 1 with `Tool not found: <toolId>`.
5. Call `surface.surface_sample_inputs({ toolId })` for the `samples` argument. If the call fails (some tools have no samples), pass `[]`.
6. Build `bodyFixture` from `config.bodyFixtures?.[toolId]?.[role] ?? config.bodyFixtures?.[toolId]?.['*']`.
7. Call `apiTestCases(runId='inputs-cli', role, tool, samples, config.domainHints, bodyFixture)`. This is the SAME function the planner uses (`packages/cli/src/mutation/apply.ts:54`).
8. Map results to `[{ palette: testCase.palette, input: testCase.action.input }]`.
9. If `--palette` is set, filter to that variant.
10. Output as `JSON.stringify(arr, null, 2)`.

**Output (always JSON):**
```json
[
  {
    "palette": "null",
    "input": { "name": null, "amount": null, "ticker": null }
  },
  {
    "palette": "happy",
    "input": { "name": "Test Trade 0001", "amount": 100, "ticker": "AAPL" }
  },
  {
    "palette": "edge",
    "input": { "name": "", "amount": 0, "ticker": "Z" }
  },
  {
    "palette": "out_of_bounds",
    "input": { "name": "...256+ chars...", "amount": -1, "ticker": "TOOLONGTICKER" }
  }
]
```

**Exit code:** 0 on success; 1 on tool not found, SurfaceMCP unreachable, or invalid `--palette` value.

**Error cases:**
- `--palette` not in `{null, happy, edge, out_of_bounds}` → exit 1, `Invalid palette: <value>. Valid: null|happy|edge|out_of_bounds.`
- Tool with `inputSchemaConfidence: 'unknown' | 'partial'` → `apiTestCases` returns ONE entry with palette `happy`. Document this in the table — output reflects exactly what the planner produces. Print a stderr `log.warn` advising user that schema is not introspected.
- `xss_inject` palette is intentionally NOT exposed via `--palette` — that's an XSS-specific code path (`xssApiTestCases`), not the canonical four. If we want it later, expose as `--palette xss` mapping internally to `xssApiTestCases` (deferred).

**Slot-in location:** `main.ts:200` (after `scope`).

---

### 4.5 `bughunter config validate` and `bughunter config show`

**File:** `packages/cli/src/cli/config-cmd.ts` (new — `config.ts` collides with `packages/cli/src/config.ts`)

**Signature:** `export function configCommand(projectDir: string, subcommand: 'validate' | 'show', opts: { resolved?: boolean }): void`

**USAGE addition:**
```
  bughunter config validate
                              Run Zod against .bughunter/config.json + palette.json.
                              Prints multi-issue report on failure. Warns on orphan
                              fixtures. Exit 0 valid, 1 invalid.
  bughunter config show [--resolved]
                              Print effective config (--resolved applies defaults)
                              or raw file. JSON output. vision.apiKey is redacted.
```

**Argument parsing:**
```ts
case 'config': {
  const sub = args[0] ?? '';
  if (sub !== 'validate' && sub !== 'show') {
    throw new Error('Usage: bughunter config validate | show [--resolved]');
  }
  configCommand(projectDir, sub, { resolved: flags['resolved'] === true });
  break;
}
```

**Implementation — `validate`:**
1. Read `.bughunter/config.json` (raw JSON).
2. `ConfigSchema.safeParse(raw)` → if fail, collect all `error.issues`, print one per line as `<path>: <message>`. Exit 1.
3. Read `.bughunter/palette.json` if present. Parse as JSON. (No Zod schema for palette today — print parse errors only.)
4. Orphan-fixture check:
   - Construct an in-memory `HttpSurfaceMcpAdapter` and call `surface_list_tools({})`.
   - For every key in `config.bodyFixtures`, check the toolId exists in the catalog. Unknown toolIds → warning (non-fatal; print and continue).
   - For every key in `config.discoveryFixtures`, check the route exists in `surface_list_pages` results. Unknown routes → warning.
   - SurfaceMCP unreachable → emit a single warning ("orphan-fixture check skipped: SurfaceMCP unreachable") and continue. Do not fail.
5. On all-pass print `Config OK.` + counts (`X bodyFixtures, Y discoveryFixtures, Z domainHints, N forbiddenPaths`). Exit 0.

**Implementation — `show`:**
1. `loadConfig(projectDir)` (raises on parse failure).
2. If `--resolved`: `resolvedConfig(config)`.
3. Redact: shallow-clone, replace `vision.apiKey` (if set) with `"[redacted]"`. Same for `extraHeaders["authorization"]` if it looks like a bearer token.
4. Output `JSON.stringify(redacted, null, 2)`.
5. Exit 0.

**Output (`validate` failure):**
```
Invalid .bughunter/config.json:
  surfaceMcpUrl: Invalid url
  perf.enabled: Required
  vision.consistencyRuns: Number must be less than or equal to 5

Found 3 issue(s). Fix and re-run.
```

**Output (`validate` success with orphan):**
```
Config OK.
  bodyFixtures: 4
  discoveryFixtures: 2
  domainHints: 8
  forbiddenPaths: 18

Warnings:
  orphan bodyFixture: 'POST /api/v1/legacy-trades' (toolId not in SurfaceMCP catalog)
  orphan discoveryFixture: '/old-page' (route not in surface_list_pages)
```

**Output (`show --resolved`):** raw JSON with defaults filled in (matches `resolvedConfig` shape) and credentials redacted.

**Exit code:** 0 valid, 1 invalid (Zod failure or palette-parse failure). Orphan warnings do NOT cause non-zero exit — they're advisories.

**Error cases:**
- Config file missing → exit 1, `No .bughunter/config.json found. Run 'bughunter init' first.`
- Palette file missing → not an error (palette is optional); skip palette check.
- Palette JSON parse fail → exit 1, `Invalid .bughunter/palette.json: <parse error>`.

**Slot-in location:** `main.ts:200` (after `inputs`).

---

## 5. Edge cases

### EC-1. `doctor` runs against a project with no `config.json`
D1 reports red. D2-D8 are still attempted with sentinel defaults: D2 uses `http://127.0.0.1:3102` (the default SurfaceMCP URL) and is allowed to fail; D3 is skipped since `browserMcpUrl` is unknown. Final exit 2.

### EC-2. `doctor` runs while SurfaceMCP is starting up
5s timeout per check is the floor. A still-booting SurfaceMCP returns `connection refused` — D2 reports red with `detail: "ECONNREFUSED at <url>"`. User retries.

### EC-3. `detectors --kind X` where X is a typo of a real kind
`Unknown BugKind: <value>` exit 1 with a hint to run `bughunter detectors --format json`. Do NOT do fuzzy matching ("did you mean...") — silent guesswork is worse than a clear error.

### EC-4. `scope` against an SPA where discover finds zero routes
`totalTests: 0` exit 0 with the advisory message. This is informational, not a failure mode — the discover phase legitimately returned zero pages (e.g. SurfaceMCP filter matched nothing).

### EC-5. `scope` with `--route /dashboard*` matching nothing
Same as EC-4. Treat zero-test plans as a successful dry-run, not an error.

### EC-6. `inputs <toolId>` where the tool has `inputSchemaConfidence: 'unknown'`
`apiTestCases` returns a single happy-palette entry. Output is one element, not four. `--palette edge` filter results in empty array — print `[]` and exit 0. log.warn explains the schema is not introspected; user can probe via `surface_probe` to upgrade.

### EC-7. `config validate` against an unparseable JSON file
JSON parse error has no `.issues` — surface the raw parse error: `Invalid .bughunter/config.json: Unexpected token } at position 234`. Exit 1.

### EC-8. `config validate` orphan check when the surface catalog is huge (1000+ tools)
Linear scan is fine for first cut. If the catalog grows further, build a `Set<string>` of toolIds first; orphan check is O(N+M), not O(N×M).

### EC-9. `config show --resolved` on a config that uses `extraHeaders.authorization`
Even with redaction, the resolved view should NEVER print bearer tokens, cookies, or API keys. Redact patterns: any header key matching `/authorization/i` or `/cookie/i`; any value matching `/^Bearer /i`.

### EC-10. `doctor --format json` piped through `jq`
The user output is the JSON; the `log.info` calls go to stderr. Verify by running `bughunter doctor --format json | jq .status` — should produce `"green"` cleanly without log noise.

### EC-11. New BugKind added to `types.ts` without a registry entry
The exhaustiveness check (`_ExhaustivenessCheck` in `registry.ts`) fails at `tsc --noEmit`. `npx tsc --noEmit` reports a clear `Type 'true' is not assignable to type ['DETECTOR_REGISTRY missing entries for BugKinds:', '<missing-kind>']`. Coder must add the entry. This is the load-bearing constraint.

### EC-12. `scope` with --route containing a glob the runtime doesn't support
The route filter is passed straight through to `runDiscover`. If discover doesn't support globs, scope inherits that limitation. Document the supported glob syntax (it's the same as `--route` in `bughunter run` — a simple prefix or `*` suffix). Out of scope to extend glob support here.

### EC-13. `inputs` for a tool whose `surface_sample_inputs` returns `null`/`[]`
`apiTestCases` accepts `samples: unknown[]` and uses `samples[0] ?? {}`. Empty array is fine; the buildApiInput path generates inputs purely from the schema. Output reflects what the planner produces; no special-case branch needed.

### EC-14. `doctor` reports yellow on D4 (vision auth) for a project that doesn't use vision
Yellow is correct — the user opted out by not setting auth. The CLI is reporting "vision is unavailable IF you wanted it." Final status is yellow only if all other checks are green. To suppress: future `--skip-checks D4` flag (deferred).

---

## 6. Negative requirements (slop guards)

- Do **not** add a new `parseArgs` variant or a third-party CLI parser (commander, yargs). The existing parser is sufficient.
- Do **not** create JSON output formatters as a shared utility module. Each command serialises its own output.
- Do **not** invoke `bughunter run` as a subprocess from `scope`. Re-run the phase functions in-process.
- Do **not** import from `cli/run.ts` into `scope.ts` to share types — `run.ts` is the entrypoint, not a library. If `RunOptions` shape needs sharing, lift to `types.ts` first (out of scope for v0.26).
- Do **not** print bug counts, fixture stats, or run-database state from `doctor`. That's `bughunter list` / `bughunter status`. `doctor` is environment, not project.
- Do **not** emit OS-specific paths in `doctor` JSON output. Use the user's project path verbatim. Filesystem checks must work on Linux + macOS (CI runs both).
- Do **not** write to disk from `scope`. The synthetic `runId` is in-memory only; no `.bughunter/runs/scope-*` directory is created.
- Do **not** add severity labels (`critical`/`major`/`minor`) to `DetectorRegistryEntry`. That's v0.30 (per `SPEC_PATH_TO_EXHAUSTIVE.md` §6.6, which says "defer to Phase C").
- Do **not** support `--kind <kind1>,<kind2>` multi-value in `detectors --kind`. Single value only; multi-value adds parser ambiguity. Users wanting multi-kind use `--format json` and pipe through `jq`.
- Do **not** add color/ANSI escapes to table output. Plain ASCII only — diagnostic tools that scrape table output (CI) prefer plain.

---

## 7. Task breakdown

| # | Task | Files | Deps |
|---|---|---|---|
| 1 | Create `DETECTOR_REGISTRY` with all 61 entries (5 seeded in §3.1; coder fills the rest from §2.2) + exhaustiveness check + lookupDetector | `packages/cli/src/detectors/registry.ts` (new), `packages/cli/src/detectors/registry.test.ts` (new — assert array length, no duplicates, exhaustiveness compiles) | none |
| 2 | Implement `doctorCommand` with all 10 checks | `packages/cli/src/cli/doctor.ts` (new), `packages/cli/src/cli/doctor.test.ts` (new — mock SurfaceMCP, browser MCP, vision-auth-detect; verify status logic) | 1 |
| 3 | Implement `detectorsCommand` (table + JSON output, kind/status filters) | `packages/cli/src/cli/detectors-cmd.ts` (new), `packages/cli/src/cli/detectors-cmd.test.ts` (new) | 1 |
| 4 | Implement `scopeCommand` (validate + discover + plan, NO execute) | `packages/cli/src/cli/scope.ts` (new), `packages/cli/src/cli/scope.test.ts` (new — fixture surface mcp, assert no execute call) | 1 |
| 5 | Implement `inputsCommand` (round-trip through `apiTestCases`) | `packages/cli/src/cli/inputs-cmd.ts` (new), `packages/cli/src/cli/inputs-cmd.test.ts` (new) | 1 |
| 6 | Implement `configCommand` (validate + show, with orphan check + redaction) | `packages/cli/src/cli/config-cmd.ts` (new), `packages/cli/src/cli/config-cmd.test.ts` (new) | 1 |
| 7 | Wire all five commands into `main.ts` USAGE and case-switch | `packages/cli/src/cli/main.ts` | 2-6 |
| 8 | Manual smoke against Aspectv3: run all 5 commands, screenshot the green table | (manual) | 7 |

Each task is independently testable and < 30min for sonnet-coder. Task 1 is the risk pin — get the registry shape right before any command consumes it.

---

## 8. Acceptance criteria + done-when

| Criterion | Verifier |
|---|---|
| Every BugKind in `types.ts:23-93` has a `DETECTOR_REGISTRY` entry | `_ExhaustivenessCheck` compiles; `registry.test.ts` asserts `DETECTOR_REGISTRY.length === BugKind member count` |
| `bughunter doctor` exit 0 on a healthy Aspectv3 dev env | Manual smoke; CI fixture |
| `bughunter doctor` exit 2 when `.bughunter/config.json` is missing | Unit test |
| `bughunter doctor` exit 1 when SurfaceMCP is reachable but vision auth is unavailable | Unit test (mock both) |
| `bughunter detectors` lists all 61 kinds with no `missing` status | `bughunter detectors --format json | jq '.entries | length'` returns 61 |
| `bughunter detectors --status deferred` returns exactly 5 entries (the 5 deferred kinds) | Unit test |
| `bughunter detectors --kind console_error` returns one entry with `detectorSite: 'packages/cli/src/classify/console.ts:24'` | Unit test |
| `bughunter scope --route '/'` test count matches `bughunter run --route '/' ` test count (where the run is dry — but exec is allowed for this acceptance test only, asserting parity within ±5%) | Manual smoke against Aspectv3 |
| `bughunter scope` does NOT create `.bughunter/runs/scope-*` directory | Manual smoke + unit test (assert no `mkdirSync` calls under runs/) |
| `bughunter inputs <toolId> --palette happy` matches the input the planner mints for the same tool/palette in `bughunter run` | Unit test: invoke `apiTestCases` directly, compare |
| `bughunter inputs <toolId> --palette null` returns null-palette input | Unit test |
| `bughunter config validate` on a typo'd `surfaceMcpUrl` reports the issue and exits 1 | Unit test |
| `bughunter config validate` on a config with an orphan bodyFixture prints a warning, exits 0 | Unit test (mock surface_list_tools) |
| `bughunter config show --resolved` redacts `vision.apiKey` to `"[redacted]"` | Unit test |
| All new TypeScript compiles clean | `npx tsc --noEmit` |
| All new ESLint passes | `npx eslint . --max-warnings 0` |
| All new tests pass | `npx vitest run packages/cli/src/cli packages/cli/src/detectors` |

---

## 9. Files to touch / add

### Created (new files)
- `packages/cli/src/detectors/registry.ts`
- `packages/cli/src/detectors/registry.test.ts`
- `packages/cli/src/cli/doctor.ts`
- `packages/cli/src/cli/doctor.test.ts`
- `packages/cli/src/cli/detectors-cmd.ts`
- `packages/cli/src/cli/detectors-cmd.test.ts`
- `packages/cli/src/cli/scope.ts`
- `packages/cli/src/cli/scope.test.ts`
- `packages/cli/src/cli/inputs-cmd.ts`
- `packages/cli/src/cli/inputs-cmd.test.ts`
- `packages/cli/src/cli/config-cmd.ts`
- `packages/cli/src/cli/config-cmd.test.ts`

Total: 12 new files (6 implementation + 6 test).

### Modified
- `packages/cli/src/cli/main.ts` — USAGE block (~30 lines added), 5 new case-switch arms (~50 lines added), 5 import statements

### NOT modified (negative — confirms isolation)
- `packages/cli/src/types.ts` — no new types added
- `packages/cli/src/config.ts` — no schema changes
- `packages/cli/src/phases/*.ts` — no phase changes
- `packages/cli/src/mutation/apply.ts` — `apiTestCases` consumed as-is

---

## 10. Risks + escape hatches

- **Risk: registry entries drift from real detector sites as code refactors.** Mitigation: the `_ExhaustivenessCheck` enforces presence; a separate v0.27 `bughunter self-test` will re-check that every `wired` entry actually has a `kind: '<name>'` literal at the declared file:line via grep. Out of scope for v0.26 but flagged.
- **Risk: `scope` ordering — `runValidate` does login attempts; for a project where login is broken, `scope` fails when `bughunter run` would also fail.** That's correct (scope mirrors run's first phases) but might surprise users who expect scope to be cheap. Mitigation: doc the "scope runs validate" caveat in the help text; consider a `--skip-validate` flag in v0.27 if pain emerges.
- **Risk: `doctor` D7 (disk space) — `fs.statfsSync` is Node ≥ 18.15.** Project pins Node 20+, fine. If we go lower, fall back to a heuristic via `du`.
- **Risk: `inputs` exposes the bodyFixture merge for a happy palette but not for non-happy palettes.** That's correct per `apply.ts:149`. Document the mismatch in the inputs output: each entry's `input` reflects the actual planner output for that palette.
- **Escape hatch:** if any single command's spec is too ambitious for one task, ship the registry + doctor + detectors as v0.26.0; ship scope/inputs/config as v0.26.1. The five commands are independently shippable. Coder MAY split if the PR grows past ~1000 LOC.

---

## 11. Definition of Done

- All 8 tasks in §7 complete
- All acceptance criteria in §8 pass
- Manual smoke against Aspectv3 records:
  - `bughunter doctor` green table (screenshot in PR)
  - `bughunter detectors --format json | jq '.meta'` returns `{ "total": 61, "wired": 56, "deferred": 5, "dead": 0 }`
  - `bughunter scope --route '/dashboard*'` returns a non-zero test count and exits 0
  - `bughunter inputs <known-toolId>` returns a 4-element JSON array
  - `bughunter config validate` returns `Config OK.` and exits 0
- PR description references `SPEC_V26_CLI_DIAGNOSTICS.md` and `SPEC_PATH_TO_EXHAUSTIVE.md §4.1`
- `npm run build` succeeds; `dist/cli/main.js` includes all five commands

---

## 12. Open questions

1. **Should `DETECTOR_REGISTRY` live in `types.ts` instead of its own module?** Argues for: keeps the union and the registry adjacent. Argues against: types.ts is already 1200 lines; adding 60+ entries pushes it past 1500. Lean toward separate module (`detectors/registry.ts`) for size; revisit if cross-module imports get noisy.

2. **Should `bughunter detectors --kind X` exit non-zero when X has `status: 'deferred'`?** Pro: a CI step using "is this kind wired?" gets a clean exit code. Con: detectors is a *report* command — exit codes shouldn't encode finding state. Lean against; users who want this behavior pipe through `jq` and check status.

3. **Should `bughunter scope` accept the same flag set as `bughunter run` (perf/a11y/seo/etc.)?** v0.26 only exposes `--route` + `--role`. Argues for full parity: the dry-run should reflect ALL flags that affect plan size. Counter: many flags don't change plan size (they change execute/classify behavior). Lean: minimal flags now; expand if users hit "scope said 100 tests but run executed 250 because of --enable-perf".

4. **Should `bughunter config show --resolved` include `forbiddenPaths` defaults from `effectiveForbiddenPaths`?** Yes — `--resolved` means "what bughunter will actually use." Without defaults the user sees an empty array and is surprised when `forbidden-path-gate` blocks `node_modules/`. Confirmed: include in resolved output.

5. **Should `bughunter inputs` also support form-derived inputs (not just API tools)?** Out of scope for v0.26 — `formTestCases` minting is more entangled with discovery. Defer to v0.27 with a `bughunter inputs <route> --form <selector>` shape.

6. **Should `_ExhaustivenessCheck` be runtime-validated as well as compile-time?** Pro: types-only checks miss when registry is loaded as JSON in some future config-driven world. Con: runtime check duplicates the type. Lean: types-only for v0.26; if a future PR moves the registry to a JSON config, add runtime check then.

7. **Should `doctor` parallelize the 10 checks?** All checks are independent. `Promise.all` cuts wall-clock from ~6s to ~2s on a slow VPN. Pro: faster. Con: error messages get interleaved if multiple time out. Lean: `Promise.allSettled` to keep errors per-check and parallelize for speed.

8. **`bughunter detectors` — should the table sort alphabetically or by status (wired first, then deferred, then dead)?** Bias: status grouping is more useful for triage. Lean: sort by `status, kind` (wired-then-deferred, alphabetic within group). Easy to reverse if user feedback differs.
