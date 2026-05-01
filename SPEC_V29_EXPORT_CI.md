# SPEC — v0.29 "Export, CI, and Severity Calibration"

**Status:** Draft 1 — ready for `@coder` assignment
**Author:** `@architect` (Opus, ultrathink)
**Date:** 2026-04-30
**Depends on:** v0.26 (`DETECTOR_REGISTRY` shape — extends with severity / cwe / helpUri), v0.27 (run-diff for `--diff-against`)
**Predecessors referenced:** v0.16 pen-testing, v0.7 XSS, v0.6 a11y/perf/SEO, v0.5 security/hygiene, v0.18 JWT login (template format).
**Out of scope (deferred):** rich Linear / Jira create-issue webhook integration (this spec emits JSON, does not POST), SARIF rich help content beyond `helpUri`, per-cluster severity overrides via suppressions (v0.30+), VS Code Problem-Matcher format (v0.31+).

---

## 1. Objective

Make BugHunter's run output ingestable by every standard code-scanning, CI, and issue-tracker tool a real engineering org already has. Three deliverables:

1. **Severity calibration.** Every `BugKind` gets a single, defensible severity (`critical | major | minor | info`) seeded in the `DETECTOR_REGISTRY` (v0.26). Severity is a property of the detector, not the cluster — this is the decision Brad makes once when he writes the detector, not every run. Every cluster carries its kind's severity into `bugs.jsonl` and `summary.json.bySeverity`.
2. **`bughunter export <runId> --format <fmt>`.** Six target formats: `sarif`, `github`, `gitlab`, `csv`, `linear`, `jira`. Each has its own emitter under `packages/cli/src/export/<fmt>.ts`. SARIF output is valid against the OASIS 2.1.0 schema and accepted by GitHub code-scanning's `upload-sarif` endpoint without hand-fixups.
3. **`bughunter ci [--fail-on …] [--report …] [--diff-against …]`.** A CI-friendly subcommand that runs `bughunter run` (or reuses `--runId`), emits SARIF + `summary.md`, and exits with a process code that PR gates can check. Plus `bughunter publish <runId> --target github` for the `gh code-scanning upload-sarif` round-trip. Plus four copy-pasteable CI templates (GitHub Actions, GitLab CI, CircleCI, Dockerfile) under `fixtures/ci-templates/`.

The spec also extends `RunSummary` with `bySeverity: Record<Severity, number>` (additive; old runs missing the field are tolerated by the export emitters).

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` (~line 23-93, ~702-765, ~1104-1180) | `BugKind` (65 kinds), `BugCluster`, `BugDetection`, `RunSummary`. **Add** `Severity` type and `RunSummary.bySeverity`. **Do NOT** add severity to `BugDetection` — severity is derived per cluster from kind via `DETECTOR_REGISTRY`, not stored per-detection. |
| `packages/cli/src/phases/classify.ts` (lines 12-86) | `KIND_PRIORITY` array. **Read for ordering reference** but DO NOT use for severity — severity is independent of priority (the canonical-kind tiebreaker). The classify phase stays untouched. |
| `packages/cli/src/phases/emit.ts` (lines 36-130) | `runEmit` writes `bugs.jsonl` and `summary.json`. v0.29 extends the `summary` literal with `bySeverity` and a single emit-time decoration of clusters with `severity` for `bugs.jsonl`. |
| `packages/cli/src/store/filesystem.ts` (lines 6-38) | `runPaths`. **Add** an `exportsDir` (`<runDir>/exports/`) so SARIF/CSV/etc. land under the run directory, not next to `bugs.jsonl`. |
| `packages/cli/src/cli/main.ts` | Subcommand dispatch. **Add** `export`, `ci`, `publish` cases. Mirror existing dispatch pattern (case in switch + import at top + USAGE-help line). |
| `packages/cli/src/cli/run.ts` | Entry point for `bughunter run`. `bughunter ci` reuses this verbatim — DO NOT reimplement the run pipeline; call into the same `runRun` function. |
| `packages/cli/src/cli/inspect.ts` | Pattern for "open an existing run, decode bugs.jsonl, do something to it." Mirror for `export`. |
| `packages/cli/src/cli/list.ts` | Pattern for "iterate runs." Reference only. |
| `packages/cli/src/detectors/registry.ts` | **Created in v0.26**, extended here. Shape extends from `{ kind, ... }` to `{ kind, severity, cwe?, exploitabilityModel?, helpUri? }`. If v0.26 has not landed when this is implemented, the first task is to land the registry skeleton. |
| `packages/cli/src/phases/cluster.ts` | Cluster mint site. v0.29 does NOT modify cluster minting. Severity is decorated at emit time; no schema migration to existing JSONL on disk. |
| `SPEC_V18_JWT_LOGIN_VERIFY.md` | V-spec format reference. Mirror tone, headers, edge-case enumeration, task-table shape, acceptance matrix. |
| External: SARIF 2.1.0 OS spec at `docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html` | §3.13 `run`, §3.14 `tool`, §3.18 `reportingDescriptor` (rules), §3.27 `result`, §3.29 `location`, §3.4 `level`. Cite chapter on every field mapping. |
| External: GitHub `code-scanning` upload-sarif docs | Subset accepted; gzipped SARIF, ≤10 MB, ≤5000 results per file. v0.29 hard-truncates at 5000 results with a `--truncated` warning. |

### 2.2 Patterns to follow

- **Discriminated unions for export format selection.** `--format <fmt>` parses to a `type ExportFormat = 'sarif' | 'github' | 'gitlab' | 'csv' | 'linear' | 'jira'` literal union. Switch over it with an `assertNever` exhaustiveness check. Mirrors v0.18 §3.2 pattern.
- **Zod for output validation in tests.** Each emitter has a Zod schema describing its output shape; the unit test parses the emitter's output through the schema (per-format, per-emitter). Mirrors `packages/cli/src/discovery/browser-login.test.ts`'s validation discipline.
- **Error returns over throws in business logic.** `runExport` returns `{ ok: true; path } | { ok: false; reason }`. Only the CLI shell at the very edge converts to `process.exit(1)`. Mirrors CLAUDE.md §"Error Handling" guidance.
- **No unconditional console writes inside emitters.** Emitters return strings/buffers; the CLI command does the file write. Lets unit tests assert exact bytes without mocking `fs`.
- **Path layout.** Exports land in `<runDir>/exports/<fmt>.<ext>` by default. `--out <path>` overrides. CI subcommand defaults `--report` to `<runDir>/exports/sarif.json` when not set, BUT for `bughunter ci` runs WITHOUT a runId arg, the default is `.bughunter/last-report.sarif` at project root — exactly matching the spec brief.
- **Severity-to-SARIF level mapping is two-stage.** `Severity` → `SarifLevel` lives in `packages/cli/src/export/severity.ts`. Every emitter that needs the mapping imports the same function. No duplication.

### 2.3 DO NOT

- Do **not** add a `severity` field to `BugDetection`. Severity is a property of the kind (the rule), not the detection (the result).
- Do **not** add a `severity` field to `BugCluster` in `types.ts`. Severity is derived, not stored. (We MAY decorate `BugCluster` with `severity` at emit time inside `bugs.jsonl` for downstream tools to read, but the in-memory `BugCluster` type stays severity-free; classify/cluster phases don't need to know.) **Exception** — see §3.3 below: we add an *optional* `severity?: Severity` field on `BugCluster` so emit-time decoration is type-safe; ALWAYS read it via the `severityForCluster(cluster)` helper which falls back to the registry lookup if the field is absent.
- Do **not** rewrite existing `bugs.jsonl` files when reading them for export. Old runs (pre-v0.29) lack `severity`; the export pass derives it from `cluster.kind` via the registry. Forward-compat by construction.
- Do **not** depend on the `gh` CLI being installed at run time. `bughunter publish` warns and exits 0 if `gh` is missing; this is best-effort.
- Do **not** introduce a new HTTP client for Linear / Jira. v0.29 emits JSON; users POST it themselves with `curl` (or their own pipeline). Webhook integration is v0.30+.
- Do **not** copy-paste the exit-code parsing logic across formats. `parseFailOn(spec: string)` returns a `FailOnRule` discriminated union and lives in `packages/cli/src/export/fail-on.ts`. Used only by `ci` command.
- Do **not** skip SARIF schema validation in tests. Use `@types/sarif` (DefinitelyTyped) + a JSON Schema validator (e.g. `ajv`) against the official SARIF 2.1.0 schema artifact. If `ajv` isn't already a dep, add it (justification: SARIF compliance is a hard acceptance gate; bundle impact ~150 KB; mature security-focused dep).
- Do **not** read environment variables for credentials in `bughunter publish`. `gh` already manages its own auth (`GH_TOKEN`); we shell out to it.

---

## 3. Severity calibration spec

### 3.1 The `Severity` type and registry shape

Add to `packages/cli/src/types.ts`, after the `BugKind` union (around line 94):

```ts
export type Severity = 'critical' | 'major' | 'minor' | 'info';

/** Coarse exploitability hint surfaced into SARIF / Linear / Jira output. Optional. */
export type ExploitabilityModel = 'easy' | 'medium' | 'hard' | 'na';
```

Add to `packages/cli/src/detectors/registry.ts` (extended from v0.26):

```ts
export type DetectorMetadata = {
  kind: BugKind;
  severity: Severity;
  /** OWASP CWE ids, e.g. ['CWE-89'] for SQL injection. Optional but strongly preferred for security kinds. */
  cwe?: string[];
  /** Hint at how easy this is to weaponize. Drives SARIF properties bag. */
  exploitabilityModel?: ExploitabilityModel;
  /** URL surfaced as `reportingDescriptor.helpUri` in SARIF; falls back to BugHunter docs root. */
  helpUri?: string;
  /** v0.26 already-defined fields stay (e.g. `displayName`, `description`). */
};

export const DETECTOR_REGISTRY: Record<BugKind, DetectorMetadata>;
```

`DETECTOR_REGISTRY` is a `Record<BugKind, DetectorMetadata>` enforced as exhaustive via a TypeScript exhaustiveness check (`const _exhaustive: Record<BugKind, DetectorMetadata> = DETECTOR_REGISTRY` will fail to compile if a kind is missing). v0.29 task is to populate every entry with severity + cwe (security kinds) + helpUri.

### 3.2 Severity assignment table — all 65 BugKinds

The spec brief gives a heuristic. The full mapping below is the authoritative table. Reasoning column is short — one line per assignment — because §3.3 below states the global heuristic and individual kinds inherit it.

**Heuristic (apply in order):**

1. **Confirmed mutating exploit or auth bypass** → `critical`.
2. **High-confidence read leak / read-only IDOR / known-CVE-class injection / pen-test proof** → `major`.
3. **Hygiene defect that affects users at scale but is not directly exploitable** → `minor`.
4. **Suspicion-level signal, structural-only deviation, or DOM-text noise** → `info`.

| Kind | Severity | CWE | Reasoning |
|---|---|---|---|
| `unhandled_exception` | critical | CWE-755 | Confirmed runtime crash; users see a broken page. |
| `xss_dom` | critical | CWE-79 | JS execution proven via canary. |
| `xss_reflected` | critical | CWE-79 | Server reflects payload; weaponizable for session theft. |
| `xss_stored` | critical | CWE-79 | Persisted; affects every viewer. (Placeholder kind — never fires until v0.8.) |
| `sql_injection` | critical | CWE-89 | Pen-test proof; database compromise. |
| `command_injection` | critical | CWE-78 | Shell access on the host. |
| `path_traversal` | critical | CWE-22 | Filesystem read on the host. |
| `jwt_weak_alg` | critical | CWE-327 | Auth-token forgery proven. |
| `auth_bypass_via_unauthed_route` | critical | CWE-287 | Confirmed access without auth. |
| `auth_session_fixation` | critical | CWE-384 | Session hijack precursor. |
| `password_reset_token_reuse` | critical | CWE-640 | Account takeover precursor. |
| `idor_vertical_role_escalate` | critical | CWE-285 | Privilege escalation, mutating. |
| `network_5xx` | critical | CWE-755 | Server failed; user-facing impact. |
| `hardcoded_credentials_in_source` | critical | CWE-798 | Production secret in repo. |
| `idor_horizontal` | major | CWE-639 | Cross-tenant read; not yet privilege escalation. |
| `csrf_missing_on_mutating_route` | major | CWE-352 | Cross-site state change possible. |
| `open_redirect` | major | CWE-601 | Phishing vector via app domain. |
| `permissive_cors` | major | CWE-942 | Origin-control bypass. |
| `cookie_security_flags` | major | CWE-1004 | Cookies steal-able / fixable. |
| `missing_csp_header` | major | CWE-693 | Defense-in-depth gap; XSS amplifier. |
| `sensitive_data_in_url` | major | CWE-598 | Credentials/PII in logs. |
| `stack_trace_leak_in_response` | major | CWE-209 | Server internals exposed. |
| `vulnerable_dependency_high` | major | CWE-1395 | Known CVE, patch needed. |
| `no_rate_limit_on_login` | major | CWE-307 | Brute-force / credential stuffing path. |
| `race_double_submit` | major | CWE-362 | State-write race (e.g. duplicate orders). |
| `optimistic_update_divergence` | major | CWE-353 | Client/server state drift; user sees ghost state. |
| `network_4xx_unexpected` | major | — | Client-error on what should be valid input. |
| `react_error` | major | — | Component crash; partial UI down. |
| `hydration_mismatch` | major | — | SSR/client divergence; can manifest as XSS amplifier. |
| `surface_call_failed` | major | — | API tool unreachable; planner-validity bug. |
| `404_for_linked_route` | major | — | Broken link from app's own UI. |
| `slow_lcp` | major | — | Core Web Vital regression on a critical page. |
| `slow_inp` | major | — | Core Web Vital regression on interactivity. |
| `high_cls` | major | — | Layout shift; UX-level regression. |
| `unbounded_list_render` | major | — | Page-stalling render. |
| `n_plus_one_api_calls` | major | — | Pageload thrash; observable latency. |
| `oversized_bundle` | major | — | Initial-load bytes exceed budget. |
| `main_thread_blocked` | major | — | Long task >50ms (configurable). |
| `keyboard_trap` | major | — | A11y blocker — keyboard users cannot escape. |
| `axe_color_contrast_strong` | major | — | WCAG AA fail; readability blocker. |
| `seo_canonical_missing` | major | — | Indexing pollution / duplicate-content harm. |
| `seo_robots_blocking_crawl` | major | — | Pages disappear from search. |
| `swallowed_error_empty_catch` | major | CWE-390 | Hidden bug surface. |
| `hallucinated_route` | minor | — | Code references a route that doesn't exist; dead-link risk only. |
| `request_dedup_missing` | minor | — | Wasted requests; not user-visible by itself. |
| `request_cancellation_missing` | minor | — | Stale-result risk. |
| `excessive_re_renders` | minor | — | Perf-smell; usually pre-symptomatic. |
| `memory_leak_attributed` | minor | — | Confirmed leak but slow accumulation. |
| `image_missing_alt` | minor | — | A11y hygiene; not blocking. |
| `form_input_unlabeled` | minor | — | A11y hygiene. |
| `interactive_element_missing_accessible_name` | minor | — | A11y hygiene. |
| `focus_lost_after_action` | minor | — | A11y hygiene. |
| `seo_title_missing` | minor | — | SEO hygiene. |
| `seo_title_duplicate_across_routes` | minor | — | SEO hygiene. |
| `seo_meta_description_missing` | minor | — | SEO hygiene. |
| `seo_h1_missing_or_multiple` | minor | — | SEO hygiene. |
| `console_error` | minor | — | Generic stderr noise; usually rooted in a real bug but kind doesn't tell us which. |
| `accessibility_critical` | minor | — | Catch-all; many already covered by stronger axe-baseline kinds. |
| `dom_error_text` | info | — | Heuristic text-on-page; high false-positive rate. |
| `missing_state_change` | info | — | Heuristic post-state assertion; low confidence. |
| `visual_anomaly` | info | — | Vision-classified; severity already gated by `VisionConfig.severityThreshold`. Default kind-severity is `info` — the visual `severity` field on the detection (existing `visualSeverity`) is what surfaces in UI. |
| `memory_leak_suspected` | info | — | Suspicion only — confirmed-leak kind escalates. |

**Open questions on this table — see §13.**

### 3.3 Cluster decoration at emit time

`packages/cli/src/phases/emit.ts` `runEmit`, between `byKind` accumulation and the `summary` literal, decorates each cluster with `severity` and accumulates `bySeverity`:

```ts
import { DETECTOR_REGISTRY } from '../detectors/registry.js';
import type { Severity } from '../types.js';

const bySeverity: Record<Severity, number> = { critical: 0, major: 0, minor: 0, info: 0 };

for (const cluster of clusters) {
  const severity = DETECTOR_REGISTRY[cluster.kind]?.severity ?? 'info';
  // Decorate in-place for bugs.jsonl so downstream tools (export, retest, fix-summary) see it.
  (cluster as BugCluster & { severity: Severity }).severity = severity;
  bySeverity[severity] += 1;
}
```

Then `bySeverity` is added to the summary literal (~line 71-99). `appendJsonl` already runs after the byKind loop; we move it after the byKind+bySeverity loop so the decoration is persisted.

`BugCluster` type gains:
```ts
export type BugCluster = {
  // … existing fields …
  /** Decorated at emit time from DETECTOR_REGISTRY. Optional for backward-compat with old JSONL artifacts. */
  severity?: Severity;
};
```

The optional field guards against runs predating v0.29 — tests deserialize old `bugs.jsonl` and the export emitters fall back to `severityForCluster(cluster)` which re-derives from kind.

### 3.4 The `severityForCluster` helper

Single-source-of-truth helper in `packages/cli/src/export/severity.ts`:

```ts
import type { BugCluster, Severity } from '../types.js';
import { DETECTOR_REGISTRY } from '../detectors/registry.js';

export function severityForCluster(cluster: Pick<BugCluster, 'kind' | 'severity'>): Severity {
  if (cluster.severity !== undefined) return cluster.severity;
  return DETECTOR_REGISTRY[cluster.kind]?.severity ?? 'info';
}

export type SarifLevel = 'error' | 'warning' | 'note' | 'none';

export function severityToSarifLevel(severity: Severity): SarifLevel {
  switch (severity) {
    case 'critical': return 'error';
    case 'major': return 'error';
    case 'minor': return 'warning';
    case 'info': return 'note';
  }
}
```

SARIF §3.27.10 `result.level`: `error` for any severity that should fail a build, `warning` for advisories, `note` for informational. Mapping: `critical` and `major` both → `error` (because GitHub's default fail threshold maps `error` → required-status-check fail, which is what we want). `minor` → `warning`. `info` → `note`. Distinction between critical/major is preserved in `result.properties.severity` (BugHunter-specific bag) and in `--fail-on` parsing.

---

## 4. `bughunter export <runId> --format <fmt>` spec

### 4.1 CLI surface

```
bughunter export <runId> --format <sarif|github|gitlab|csv|linear|jira>
                         [--out <path>]
                         [--severity-min <critical|major|minor|info>]
                         [--diff-against <runId>]
                         [--truncate <n>]
                         [--no-third-party]
```

- `<runId>`: required. Resolves to `<projectDir>/.bughunter/runs/<runId>/`. Errors with exit 2 if missing.
- `--format`: required. Accepted values listed above.
- `--out`: defaults to `<runDir>/exports/<fmt>.<ext>` where `<ext>` is `json` for sarif/github/gitlab/linear/jira and `csv` for csv.
- `--severity-min`: filters out clusters strictly below this. Default `info` (no filter).
- `--diff-against <prevRunId>`: emits only NEW or REGRESSED clusters per the v0.27 diff algorithm. Without this flag, emits all clusters in the run.
- `--truncate <n>`: caps the result count at `n`. Default 5000 (GitHub SARIF limit). Excess is dropped with a stderr warning.
- `--no-third-party`: skip clusters where `thirdPartyOrGenerated === true`.

Exit codes: 0 on success, 2 on bad arguments, 3 on run-not-found, 4 on emitter failure. (`bughunter ci` reuses these but layers `--fail-on` on top — see §6.)

### 4.2 SARIF 2.1.0 emitter (`packages/cli/src/export/sarif.ts`)

Emit one SARIF run with one `tool.driver` named `BugHunter` and one `result` per BugCluster.

**Top-level shape (SARIF §3.13 `run`, §2.1.0):**

```ts
{
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
  version: '2.1.0',
  runs: [
    {
      tool: { driver: ToolDriver },          // §3.14 / §3.18
      invocations: [Invocation],              // §3.20
      results: Result[],                      // §3.27
      automationDetails: AutomationDetails,   // §3.17
    }
  ]
}
```

**`tool.driver` (SARIF §3.18 `toolComponent`):**

```ts
{
  name: 'BugHunter',
  version: <package.json version>,
  informationUri: 'https://github.com/cunninghambe/BugHunter',
  rules: ReportingDescriptor[],             // one per BugKind referenced by results
}
```

**`rules[]` (SARIF §3.49 `reportingDescriptor`):** one entry per UNIQUE `BugKind` present in the run's clusters. Not every kind in the registry — only those that fired. Each rule:

```ts
{
  id: <BugKind>,                             // e.g. 'sql_injection'
  name: <DetectorMetadata.displayName>,      // PascalCase, e.g. 'SqlInjection'
  shortDescription: { text: <kind> },
  fullDescription: { text: <DetectorMetadata.description> },
  defaultConfiguration: { level: severityToSarifLevel(severity) },
  helpUri: <DetectorMetadata.helpUri>,
  properties: {
    'security-severity': severityToSarifSecurity(severity),  // see below
    cwe: <DetectorMetadata.cwe>,                              // string[]
    'bughunter.severity': severity,                           // raw label
    'bughunter.exploitabilityModel': <DetectorMetadata.exploitabilityModel>,
  }
}
```

`severityToSarifSecurity` (GitHub uses this for code-scanning scoring; SARIF §3.49.13 properties bag):

```ts
function severityToSarifSecurity(s: Severity): string {
  switch (s) {
    case 'critical': return '9.5';
    case 'major':    return '7.5';
    case 'minor':    return '4.0';
    case 'info':     return '1.0';
  }
}
```

**`results[]` (SARIF §3.27):** one entry per cluster (post-filter, post-truncate).

```ts
{
  ruleId: <cluster.kind>,
  ruleIndex: <index of rule in rules[] above>,
  level: severityToSarifLevel(severity),
  message: { text: <cluster.rootCause> },
  locations: [Location],                      // §3.28 — see below
  partialFingerprints: { 'bughunter.clusterSignature/v1': cluster.signatureKey ?? cluster.id },
  properties: {
    'bughunter.clusterId': cluster.id,
    'bughunter.runId': cluster.runId,
    'bughunter.clusterSize': cluster.clusterSize,
    'bughunter.firstSeenAt': cluster.firstSeenAt,
    'bughunter.lastSeenAt': cluster.lastSeenAt,
    'bughunter.verdict': cluster.verdict,
    'bughunter.replayCommand': cluster.occurrences[0]?.fullArtifacts ? cluster.occurrences[0].replayCommand : undefined,
  }
}
```

**`locations[]` (SARIF §3.28 + §3.29):**

```ts
{
  physicalLocation: {
    artifactLocation: {
      uri: <relative path; cluster.suspectedFiles[0] when present, else 'unknown'>,
      uriBaseId: 'SRCROOT',
    },
    // No region — we don't track line numbers per-cluster yet. (Future work: §13 OQ-3.)
  }
}
```

If `cluster.suspectedFiles` is empty, emit a synthetic `artifactLocation.uri = 'unknown'`. SARIF requires `physicalLocation.artifactLocation` to exist; null isn't valid. GitHub displays "unknown" verbatim.

**`originalUriBaseIds` on the run** (SARIF §3.13.16): set to `{ SRCROOT: { uri: 'file:///' } }` — relative paths in suspectedFiles are SRCROOT-relative.

**`invocations[0]` (SARIF §3.20):**
```ts
{
  executionSuccessful: true,
  startTimeUtc: <runState.startedAt>,
  endTimeUtc: <new Date().toISOString()>,
  workingDirectory: { uri: 'file://' + projectDir },
}
```

**`automationDetails` (SARIF §3.17):**
```ts
{ id: 'bughunter/' + runId }
```

**Edge: empty run.** Zero clusters → emit a valid SARIF with `runs[0].results = []`. SARIF allows this.

### 4.3 `github` format

Subset of SARIF 2.1.0; same shape; same severity mapping; differences:

- `--truncate` defaults to 5000 (GitHub's hard cap).
- `--out` defaults to `<runDir>/exports/github.sarif`.
- A stderr warning if `cluster.suspectedFiles[0]` resolves outside the repo (we don't validate but warn if path starts with `/`).

Implementation: `github.ts` calls `sarif.ts` then post-processes (truncate, validate path-relativity).

### 4.4 `gitlab` format (GitLab Security Report v15.0.x)

GitLab Security-Report shape (different from SARIF). Schema: GitLab's `security-report-format-sast-15.0.0.json`.

```ts
{
  version: '15.0.0',
  scan: {
    scanner: { id: 'bughunter', name: 'BugHunter', version, vendor: { name: 'BugHunter' } },
    type: 'sast',
    start_time: <runState.startedAt>,
    end_time: <now>,
    status: 'success'
  },
  vulnerabilities: Vulnerability[]
}
```

Each `Vulnerability`:
```ts
{
  id: cluster.id,
  category: 'sast',
  name: <DetectorMetadata.displayName>,
  message: cluster.rootCause,
  description: cluster.fixHints.join('\n'),
  cve: 'BugHunter-' + cluster.kind + '-' + cluster.id,
  severity: severityToGitlabSeverity(severity),  // 'Critical' | 'High' | 'Medium' | 'Low' | 'Info'
  scanner: { id: 'bughunter', name: 'BugHunter' },
  location: { file: cluster.suspectedFiles[0] ?? 'unknown', start_line: 1 },
  identifiers: [
    { type: 'bughunter_kind', name: cluster.kind, value: cluster.kind },
    ...(DETECTOR_REGISTRY[cluster.kind].cwe ?? []).map(c => ({ type: 'cwe', name: c, value: c }))
  ]
}
```

`severityToGitlabSeverity`: critical→Critical, major→High, minor→Medium, info→Info. (No `Low` mapping — GitLab's `Info` is closest to our `info`.)

### 4.5 `csv` format (`packages/cli/src/export/csv.ts`)

One row per cluster. Header line. RFC 4180 escaping (double-quoted; embedded `"` doubled).

Columns (in order):

```
id,kind,severity,cwe,root_cause,cluster_size,first_seen,last_seen,suspected_files,verdict,replay_command,run_id
```

- `cwe`: semicolon-joined CWE ids (e.g. `CWE-79;CWE-80`).
- `suspected_files`: semicolon-joined.
- `replay_command`: from `cluster.occurrences[0].replayCommand` if `fullArtifacts === true`, else empty.
- `root_cause`: trimmed to 500 chars; embedded newlines replaced with ` `.

Wraps in `"…"` always; safer than conditional. Tests assert the bytes round-trip through a CSV parser (`csv-parse` if already in deps; else use a tiny inline RFC-4180 parser ≤30 lines — do NOT add a new dep just for tests).

### 4.6 `linear` format (`packages/cli/src/export/linear.ts`)

Linear's `issueCreate` GraphQL mutation accepts a single issue. Emitter outputs an array of objects, each shaped to match the input variables.

```ts
type LinearIssueDraft = {
  // Linear's `IssueCreateInput`. Caller maps to the actual mutation.
  title: string;
  description: string;        // Markdown
  priority: 0 | 1 | 2 | 3 | 4; // 1=urgent, 2=high, 3=medium, 4=low, 0=no priority
  labelIds?: string[];        // empty by default; user supplies via --linear-label-map
  // BugHunter metadata bag, prefixed `bughunter_`, surfaces as Linear custom fields if mapped.
  bughunter: {
    runId: string;
    clusterId: string;
    kind: BugKind;
    severity: Severity;
    cwe: string[];
    suspectedFiles: string[];
    replayCommand: string | undefined;
  };
};
```

Title: `[BugHunter ${severity}] ${kind}: ${rootCause.slice(0, 80)}`.

Description: Markdown with sections — Summary (rootCause), Suspected files (bullets), Replay command (code block), Fix hints (bullets), Cluster metadata (table).

Priority mapping: critical→1, major→2, minor→3, info→4.

Output: `LinearIssueDraft[]` JSON-array. Caller iterates and POSTs (out of scope for v0.29).

### 4.7 `jira` format (`packages/cli/src/export/jira.ts`)

Jira `POST /rest/api/3/issue`. Emitter outputs an array, each ready for the `fields` body.

```ts
type JiraIssueDraft = {
  fields: {
    summary: string;                    // same title shape as linear
    description: AdfDocument;           // Atlassian Document Format
    issuetype: { name: 'Bug' };
    priority: { name: 'Highest' | 'High' | 'Medium' | 'Low' };
    labels: string[];                   // ['bughunter', 'severity-critical', 'kind-sql_injection']
  };
  // Out-of-band fields for downstream pipelining.
  bughunter: { runId, clusterId, kind, severity, cwe };
};
```

`AdfDocument` is the simplified ADF shape: `{ version: 1, type: 'doc', content: [paragraph, codeBlock, …] }`. Helper `markdownToAdf(md: string)` lives in `jira.ts`. Implements only the subset we emit (paragraph, heading, bulletList, codeBlock) — we control the input. Do not add a Markdown-to-ADF library dep.

Priority: critical→Highest, major→High, minor→Medium, info→Low.

Labels always include `'bughunter'`, `'severity-' + severity`, `'kind-' + kind`. Plus user-configured labels via `--jira-label …` flags (repeatable).

---

## 5. SARIF mapping reference table

Cited per SARIF 2.1.0 OS chapter. Read the chapter when in doubt.

| BugHunter source | SARIF location | Spec ref |
|---|---|---|
| `runState.startedAt` | `runs[0].invocations[0].startTimeUtc` | §3.20.7 |
| `runEmit` end timestamp | `runs[0].invocations[0].endTimeUtc` | §3.20.8 |
| `cluster.kind` | `result.ruleId`, `rules[i].id` | §3.27.5, §3.49.4 |
| `Severity` (mapped) | `result.level`, `rules[i].defaultConfiguration.level` | §3.27.10, §3.49.21 / §3.50.6 |
| `Severity` (numeric) | `rules[i].properties['security-severity']` | §3.49.13 + GitHub conventions |
| `cluster.rootCause` | `result.message.text` | §3.27.11, §3.11 |
| `cluster.suspectedFiles[0]` | `result.locations[0].physicalLocation.artifactLocation.uri` | §3.28.3, §3.4.2 |
| `cluster.signatureKey` | `result.partialFingerprints['bughunter.clusterSignature/v1']` | §3.27.18 |
| `cluster.id` / `runId` / `clusterSize` / etc. | `result.properties` (custom bag) | §3.27.12 (properties) |
| BugHunter version | `runs[0].tool.driver.version` | §3.18.6 |
| `DETECTOR_REGISTRY[kind].cwe` | `rules[i].properties.cwe` (custom) | §3.49.13 |
| `DETECTOR_REGISTRY[kind].helpUri` | `rules[i].helpUri` | §3.49.10 |
| `runId` | `runs[0].automationDetails.id` (`'bughunter/' + runId`) | §3.17.2 |
| Source root | `runs[0].originalUriBaseIds.SRCROOT` | §3.13.16 |

**Severity → SARIF level table:** see §3.4.

**`partialFingerprints`** (open question OQ-2 in §13): we use `cluster.signatureKey ?? cluster.id`. If `signatureKey` is set, two runs of the same BugHunter version produce identical fingerprints — GitHub's auto-dismiss-on-fix flow uses these to track findings across runs. If `signatureKey` is absent (third-party clusters?), `cluster.id` is run-unique, so GitHub will treat each run's findings as new. This is fine for v0.29 — the V27 diff handles dedup at the BugHunter side; SARIF fingerprints are GitHub's belt-and-suspenders.

---

## 6. `bughunter ci` spec

### 6.1 CLI surface

```
bughunter ci [run options]                       # all flags from `bughunter run` are accepted
             [--runId <id>]                      # reuse an existing run instead of running fresh
             [--fail-on <spec>]                  # see §6.3
             [--report <path>]                   # default: .bughunter/last-report.sarif
             [--summary-md <path>]               # default: .bughunter/last-report.summary.md
             [--diff-against <runId>]            # filters to NEW/regressed clusters per v0.27
             [--upload]                          # if set, runs `bughunter publish` after success
             [--no-publish]                      # explicit suppression
```

If `--runId` not given, `bughunter ci` calls into the same `runRun(...)` function used by `bughunter run`. All `bughunter run` flags pass through (see `packages/cli/src/cli/main.ts` USAGE lines for exact list).

### 6.2 Output artifacts

After the run (or when `--runId` resolves to a completed run):

1. **SARIF report** at `--report` path. SARIF 2.1.0, identical to `bughunter export <runId> --format sarif`.
2. **`summary.md`** at `--summary-md` path. Markdown, ≤8 KB, designed for paste into a GitHub PR comment. Sections:
   - Header: `### BugHunter Run <runId>` (link to runDir if local; otherwise plain text).
   - Counts: by severity (table), by kind (top-10 table).
   - Diff-aware section (when `--diff-against` set): "New: 3, Regressed: 1, Resolved: 5" with cluster-id bullets.
   - Top 10 highest-severity findings (cluster id, kind, rootCause-snippet, suspected file).
   - Footer: "Full SARIF: `<path>`. Run `bughunter inspect <id>` for replay command."

### 6.3 `--fail-on` parsing

A `FailOnRule` discriminated union, parsed by `parseFailOn(spec: string): FailOnRule`. Lives in `packages/cli/src/export/fail-on.ts`.

```ts
export type FailOnRule =
  | { kind: 'severity'; min: Severity }                        // 'critical' | 'major+' | 'minor+'
  | { kind: 'count'; threshold: number }                       // 'count:50'
  | { kind: 'regression'; min: Severity }                      // 'regression:critical' (requires --diff-against)
  | { kind: 'kind'; bugKind: BugKind }                         // 'kind:sql_injection'
  | { kind: 'never' };                                          // omitted flag

export function parseFailOn(spec: string | undefined): FailOnRule;
```

Accepted strings (case-insensitive):
- `critical` → `{ kind: 'severity', min: 'critical' }` (any cluster of severity ≥ critical fails)
- `major+`, `major`, `high+`, `high` → `{ kind: 'severity', min: 'major' }`
- `minor+`, `minor` → `{ kind: 'severity', min: 'minor' }`
- `info+`, `any` → `{ kind: 'severity', min: 'info' }` (any finding fails)
- `count:<n>` → `{ kind: 'count', threshold: <n> }` (fails when total clusters ≥ n)
- `regression:<sev>` → `{ kind: 'regression', min: <sev> }` (only NEW or regressed clusters at ≥ sev count toward fail; requires `--diff-against`)
- `kind:<bugKind>` → `{ kind: 'kind', bugKind }` (any cluster of this kind fails)
- absent / empty / `never` → `{ kind: 'never' }` (always exit 0 regardless of findings; default)

Bad `--fail-on` value → exit 2 with stderr `"Invalid --fail-on: <spec>"`.

### 6.4 Exit codes

| Code | Meaning |
|---|---|
| 0 | Run succeeded; no findings exceeded `--fail-on` threshold. |
| 1 | Run succeeded; findings exceeded `--fail-on` threshold. |
| 2 | Bad arguments / unparseable `--fail-on`. |
| 3 | Run not found (when `--runId` doesn't exist). |
| 4 | Emitter failure (rare; SARIF write IO error). |
| 5 | Run itself failed (only when not using `--runId`); the underlying `runRun` failed. |

Hard rule: **exit 0 ≠ "no findings"**. Exit 0 means "no findings above threshold." A green CI may still have many sub-threshold findings; CI is not the spec audit, the run is.

### 6.5 `summary.md` exact template

```md
## BugHunter Run `${runId}`

**Result:** ${exitCodeIcon} ${passOrFailLabel}
**Failed gate:** ${failOnDescription}
**Total clusters:** ${total}
**Runtime:** ${seconds}s

### By severity

| Severity | Count |
|---|---|
| Critical | ${bySeverity.critical} |
| Major | ${bySeverity.major} |
| Minor | ${bySeverity.minor} |
| Info | ${bySeverity.info} |

${diffSection}    // present only when --diff-against; see below

### Top findings

| Cluster | Kind | Severity | File | Description |
|---|---|---|---|---|
${top10Rows}

<details>
<summary>By kind</summary>

| Kind | Count |
|---|---|
${byKindRows}

</details>

— Full SARIF: \`${reportPath}\`
— Replay any cluster: \`bughunter replay <occurrenceId>\`
```

`diffSection` (when applicable):
```md
### Diff vs `${diffRunId}`

- **New:** ${newCount} (${newClusters.map(c => '`' + c.id + '`').join(', ')})
- **Regressed:** ${regressedCount}
- **Resolved:** ${resolvedCount}
```

### 6.6 Algorithm

```
runId  = flags.runId ?? await runRun(flagsForRun)            // exit 5 on failure
state  = readRunState(runId)                                  // exit 3 on missing
diff   = flags.diffAgainst ? computeDiff(state, prev) : null  // v0.27
clusters = state.clusters
filtered = filterBySeverityMin(clusters, flags.severityMin)
sarif    = renderSarif(filtered, state)
write(flags.report, sarif)
md       = renderSummaryMd(filtered, state, diff, failOnRule)
write(flags.summaryMd, md)
const breached = evaluateFailOn(failOnRule, filtered, diff)
if (flags.upload && !breached) await runPublish(runId, 'github')   // best-effort
process.exit(breached ? 1 : 0)
```

`evaluateFailOn(rule, clusters, diff)`:
- `severity`: count clusters with `severity >= rule.min` (where `critical>major>minor>info`); breach if ≥1.
- `count`: breach if `clusters.length >= rule.threshold`.
- `regression`: requires `diff !== null`; breach if any of `diff.added` ∪ `diff.regressed` has `severity >= rule.min`.
- `kind`: breach if any cluster has `kind === rule.bugKind`.
- `never`: always false.

---

## 7. `bughunter publish <runId>` spec

```
bughunter publish <runId> --target <github>
                          [--ref <gitRef>]    # default: env GITHUB_REF or HEAD
                          [--sha <commitSha>] # default: env GITHUB_SHA or `git rev-parse HEAD`
                          [--report <path>]   # default: <runDir>/exports/github.sarif
```

Behaviour:

1. If `--target` is anything other than `github`, exit 2.
2. Resolve `--report`. If missing, generate it in-place via the same code path as `bughunter export`. (Don't fail because the user forgot to export first.)
3. Detect `gh` CLI:
   ```bash
   gh --version
   ```
   If not present (`ENOENT` or non-zero exit), warn `"gh CLI not installed; skipping upload"` and exit 0. Best-effort.
4. Detect we're inside a git repo:
   ```bash
   git rev-parse --is-inside-work-tree
   ```
   If not, exit 0 with a warning.
5. Shell out:
   ```bash
   gh code-scanning upload-sarif \
     --file <report> \
     --ref <ref> \
     --sha <sha>
   ```
6. Stream `gh`'s stdout/stderr to our process's. Propagate `gh`'s exit code.

`gh` handles auth via `GH_TOKEN` env var; we don't touch credentials. Document this in `--help` output.

---

## 8. CI templates

All four templates live under `fixtures/ci-templates/`. Copy-pasteable; no parameterization beyond what the user changes when they adopt.

### 8.1 GitHub Actions (`.github/workflows/bughunter.yml`)

```yaml
name: BugHunter

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write     # for code-scanning upload
  pull-requests: write       # for the comment step

jobs:
  bughunter:
    name: Run BugHunter
    runs-on: ubuntu-latest
    timeout-minutes: 45

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Start app under test
        run: |
          npm run build
          npm start &
          npx wait-on http://localhost:3000 --timeout 60000

      - name: Start SurfaceMCP
        run: |
          npx surfacemcp serve > /tmp/surfacemcp.log 2>&1 &
          sleep 5
          curl -fsS http://localhost:3107/health

      - name: BugHunter init (idempotent)
        run: |
          if [ ! -f .bughunter/config.json ]; then
            npx bughunter init --no-interactive --project-name "${{ github.repository }}"
          fi

      - name: Run BugHunter (CI)
        run: |
          npx bughunter ci \
            --report .bughunter/report.sarif \
            --summary-md .bughunter/summary.md \
            --fail-on major+ \
            --max-bugs 200 \
            --budget 1800000

      - name: Upload SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: .bughunter/report.sarif

      - name: Comment summary on PR
        if: github.event_name == 'pull_request' && always()
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          path: .bughunter/summary.md

      - name: Upload artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: bughunter-run
          path: .bughunter/runs/
```

### 8.2 GitLab CI (`.gitlab-ci.yml`)

```yaml
stages:
  - test
  - report

bughunter:
  stage: test
  image: node:20
  services:
    - name: docker:dind
  before_script:
    - npm ci
    - npm run build
    - npm start &
    - npx wait-on http://localhost:3000 --timeout 60000
    - npx surfacemcp serve &
    - sleep 5
  script:
    - npx bughunter ci
        --report bughunter-report.sarif
        --summary-md bughunter-summary.md
        --fail-on major+
        --max-bugs 200
        --budget 1800000
  artifacts:
    when: always
    reports:
      sast: bughunter-gitlab.json
    paths:
      - bughunter-report.sarif
      - bughunter-summary.md
      - .bughunter/runs/
    expire_in: 30 days
  after_script:
    - npx bughunter export "$(cat .bughunter/last-run-id)" --format gitlab --out bughunter-gitlab.json || true
```

(Note: the run id is read from `.bughunter/last-run-id` — a single-line file written by `bughunter ci` after the run completes. New artifact path; document in §9.)

### 8.3 CircleCI (`.circleci/config.yml`)

```yaml
version: 2.1

jobs:
  bughunter:
    docker:
      - image: cimg/node:20.10
    steps:
      - checkout
      - run: npm ci
      - run: npm run build
      - run:
          command: npm start
          background: true
      - run: npx wait-on http://localhost:3000 --timeout 60000
      - run:
          command: npx surfacemcp serve
          background: true
      - run: sleep 5 && curl -fsS http://localhost:3107/health
      - run: |
          npx bughunter ci \
            --report bughunter-report.sarif \
            --summary-md bughunter-summary.md \
            --fail-on major+
      - store_artifacts:
          path: bughunter-report.sarif
      - store_artifacts:
          path: bughunter-summary.md
      - store_artifacts:
          path: .bughunter/runs

workflows:
  ci:
    jobs:
      - bughunter
```

### 8.4 Dockerfile (`Dockerfile`)

```dockerfile
# fixtures/ci-templates/Dockerfile
FROM node:20-bullseye AS base

# Playwright dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libdrm2 libgtk-3-0 ca-certificates \
    git curl jq && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

FROM base AS bughunter
RUN npm install -g bughunter@latest
RUN npx playwright install --with-deps chromium firefox

ENTRYPOINT ["bughunter"]
CMD ["--help"]
```

Document in template README: bind-mount the project directory at `/workspace` and pass `bughunter ci` args. Image stays under 1 GB if we drop unused locales (out of scope; just call out as future work).

---

## 9. summary.json severity additions

Today (`packages/cli/src/types.ts:1104`), `RunSummary` lacks severity counts. v0.29 adds:

```ts
export type RunSummary = {
  // … existing fields …
  /** v0.29 severity rollup. Always present in v0.29+ summary.json files. */
  bySeverity: Record<Severity, number>;
};
```

`runEmit` populates `bySeverity` (see §3.3) and writes it to `summary.json` alongside `byKind`. The summary JSON serializer DOES NOT skip zero-severity buckets — `{ critical: 0, major: 0, minor: 0, info: 0 }` is always present, even on empty runs. Downstream consumers (export emitters, `bughunter ci`, future dashboards) can assume the keys exist.

`bughunter ci` writes a one-line file `<projectDir>/.bughunter/last-run-id` containing the run id of the most recent CI run, used by §8.2 GitLab template.

---

## 10. Edge cases

### EC-1. Empty run (zero clusters)
SARIF: `runs[0].results = []`, `runs[0].tool.driver.rules = []`. Valid SARIF. CSV: header line only. GitLab: `vulnerabilities: []`. Linear/Jira: `[]`. CI exits 0 regardless of `--fail-on` (no findings = no breach).

### EC-2. Cluster has no `suspectedFiles`
SARIF/GitHub/GitLab require a location; emit `artifactLocation.uri = 'unknown'`. Tests assert `'unknown'` is rendered. Document this caveat in `--help` output for `export --format sarif`.

### EC-3. `--fail-on` parsing failure
Bad string → exit 2 with `"Invalid --fail-on: <spec>"`. Help text lists every accepted value. Tests cover: empty string, garbage, `count:abc` (non-numeric), `regression:wrong`, mixed case (`Critical` → accepted, lowercased).

### EC-4. `gh` CLI absent
Detect via `gh --version` failing. Warn-and-exit-0. Tests stub the `which gh` check.

### EC-5. SARIF >5000 results (GitHub limit)
Default `--truncate 5000`. Excess clusters are dropped, a warning printed: `"Truncated 7234 → 5000 results to fit GitHub code-scanning limit"`. The dropped clusters are NOT silently lost — `summary.md` still shows the full count, and the runDir's `bugs.jsonl` is unchanged.

### EC-6. SARIF report exceeds 10 MB
Same handling as EC-5 conceptually — for v0.29, we don't measure bytes, only cluster count. If a 5000-cluster SARIF still exceeds 10 MB (unlikely; ~2 KB per cluster), the upload step (`gh code-scanning upload-sarif`) will fail with a clear error. We do NOT pre-emptively gzip — `gh` does.

### EC-7. Run pre-dates v0.29 (no `severity` on clusters)
`severityForCluster(cluster)` falls back to registry lookup by `cluster.kind`. If kind isn't in the registry (older custom fork?), defaults to `'info'` and emits a stderr warning once per kind.

### EC-8. `--diff-against <runId>` doesn't exist
Exit 3 with `"Diff base run not found: <runId>"`. Same exit code as missing primary run.

### EC-9. Concurrent `bughunter ci` invocations against the same project
We do NOT lock. Two `bughunter run`s race; whichever finishes second overwrites `.bughunter/last-run-id`. Document. Users running parallel CI jobs should avoid this — but we explicitly do NOT introduce a flock layer.

### EC-10. CSV cell containing newline
RFC 4180 requires the cell be wrapped in `"…"`. Wrapping is unconditional (§4.5). Embedded `"` is doubled. Tests round-trip.

### EC-11. Linear/Jira description >32 KB
Linear's API caps descriptions at 64 KB; Jira at "very large". v0.29 caps at 32 KB to be safe; truncates with `\n…(truncated; see SARIF for full detail)`.

### EC-12. Path with backslashes (Windows-y `suspectedFiles`)
SARIF requires forward-slash URIs (§3.4.2). Emitter normalizes `\\` → `/` for the `artifactLocation.uri`. CSV preserves verbatim.

### EC-13. `cluster.signatureKey` is `undefined` for old runs
Use `cluster.id` as fallback for `partialFingerprints` (§5). GitHub treats each run's findings as new — acceptable degraded behaviour.

### EC-14. SARIF emitter fails ajv validation in tests
Hard fail; the test must produce exact-shape output. ajv error message is asserted on. No "best-effort" — SARIF compliance is an acceptance gate (§11.).

### EC-15. `bughunter ci` invoked with `--runId` referring to an INCOMPLETE run
A run that didn't reach the `emit` phase has no `bugs.jsonl`. Detect via `runState.phase !== 'done' && runState.phase !== 'emit'`. Exit 3 with `"Run not complete: phase=<phase>"`. Don't try to export from a half-finished run.

### EC-16. `--out` path's parent directory doesn't exist
Auto-create with `fs.mkdirSync(path.dirname(out), { recursive: true })`. Mirrors `ensureRunDirs`.

### EC-17. `--severity-min` filters everything out
Empty results. Exit 0. SARIF still valid (zero results). Document.

---

## 11. Acceptance criteria

| # | Criterion | Verifier |
|---|---|---|
| A1 | `DETECTOR_REGISTRY` has an entry for every `BugKind` (no missing keys; tsc enforces). | `npx tsc --noEmit` |
| A2 | Every `DetectorMetadata` has `severity` set to a valid `Severity`. | Unit test iterating `DETECTOR_REGISTRY`. |
| A3 | `severityToSarifLevel` maps all four severities; exhaustive switch passes tsc. | `npx tsc --noEmit` |
| A4 | SARIF emitter output validates against the official SARIF 2.1.0 schema (`sarif-schema-2.1.0.json` from OASIS). | ajv-based unit test. |
| A5 | `bughunter export <runId> --format github` output uploads cleanly to a fixture GitHub repo via `gh code-scanning upload-sarif --dry-run`. | Manual smoke (§12 runbook). |
| A6 | `bughunter export <runId> --format csv` round-trips through a CSV parser. | Unit test. |
| A7 | `bughunter export <runId> --format linear` produces N drafts where N = cluster count post-filter. | Unit test. |
| A8 | `bughunter export <runId> --format jira` produces ADF that parses as the documented subset (paragraph/heading/bulletList/codeBlock only). | Unit test. |
| A9 | `bughunter ci --fail-on critical` exits 1 when run has ≥1 critical cluster, 0 otherwise. | Unit test with synthetic run state. |
| A10 | `bughunter ci --fail-on count:50` exits 1 at 50, 0 at 49. | Unit test. |
| A11 | `bughunter ci --fail-on regression:critical --diff-against <id>` exits 1 only when the v0.27 diff has a NEW or regressed critical cluster. | Unit test. |
| A12 | `bughunter ci --fail-on regression:critical` (without `--diff-against`) exits 2 — bad arg combination. | Unit test. |
| A13 | `summary.md` < 8 KB on a 200-cluster run. | Unit test. |
| A14 | `bughunter publish` exits 0 with warning when `gh` is absent. | Unit test mocking `which gh`. |
| A15 | `summary.json.bySeverity` is present on every v0.29+ run. | Integration smoke. |
| A16 | All four CI templates (`.github/workflows/bughunter.yml`, `.gitlab-ci.yml`, `.circleci/config.yml`, `Dockerfile`) lint clean (`actionlint`, `gitlab-ci-lint`, `circleci config validate`, `hadolint`). | CI of CI templates (run once; not part of every push). |
| A17 | `bughunter export` against an empty run produces valid SARIF / CSV / GitLab JSON. | Unit test (EC-1). |
| A18 | `bughunter export` against a pre-v0.29 run (no `severity` field on clusters) succeeds with registry-derived severity. | Unit test (EC-7). |
| A19 | `bughunter ci` writes `.bughunter/last-run-id` after a successful run. | Integration smoke. |

Hard gate: A4 + A5 + A9 + A10 + A11 + A15 + A16. Anything else is paper-cut tier.

---

## 12. Manual smoke runbook

```bash
# Pre-req: a TraiderJo (or any v0.5+) BugHunter run already complete.
RUN=$(ls -t /root/TraiderJo/.bughunter/runs/ | head -1)
cd /root/TraiderJo

# 1. Severity rollup populated
jq '.bySeverity' .bughunter/runs/$RUN/summary.json
# Expect: { "critical": <int>, "major": <int>, "minor": <int>, "info": <int> }

# 2. SARIF export valid
npx bughunter export $RUN --format sarif --out /tmp/out.sarif
node -e "
  const ajv = new (require('ajv').default)({ strict: false });
  const schema = require('./node_modules/sarif-schema-2.1.0/schema.json');
  const data = require('/tmp/out.sarif');
  const valid = ajv.validate(schema, data);
  console.log(valid ? 'VALID' : ajv.errors);
"

# 3. CI flow with synthetic threshold breach
npx bughunter ci --runId $RUN --fail-on critical --report /tmp/ci.sarif --summary-md /tmp/ci.md
echo "Exit: $?"
cat /tmp/ci.md | head -40

# 4. CI flow with permissive threshold
npx bughunter ci --runId $RUN --fail-on count:99999 --report /tmp/ci.sarif
echo "Exit: $?"  # Expect 0

# 5. Diff-aware regression detection (requires two runs)
PREV=$(ls -t /root/TraiderJo/.bughunter/runs/ | sed -n '2p')
npx bughunter ci --runId $RUN --diff-against $PREV --fail-on regression:critical
echo "Exit: $?"

# 6. CSV round-trip
npx bughunter export $RUN --format csv --out /tmp/out.csv
head -2 /tmp/out.csv
wc -l /tmp/out.csv  # Expect: 1 header + N clusters

# 7. GitLab format
npx bughunter export $RUN --format gitlab --out /tmp/out-gitlab.json
jq '.scan.scanner.id, .vulnerabilities | length' /tmp/out-gitlab.json

# 8. Linear / Jira drafts
npx bughunter export $RUN --format linear --out /tmp/linear.json
jq '. | length, .[0].title, .[0].priority' /tmp/linear.json
npx bughunter export $RUN --format jira --out /tmp/jira.json
jq '. | length, .[0].fields.summary, .[0].fields.priority.name' /tmp/jira.json

# 9. publish dry-run (requires gh CLI + repo)
gh --version  # if absent, expect skip-warning
npx bughunter publish $RUN --target github --report /tmp/out.sarif
```

---

## 13. Files to touch / add

### 13.1 New files

| Path | Owner | Notes |
|---|---|---|
| `packages/cli/src/export/severity.ts` | `@coder` | `severityForCluster`, `severityToSarifLevel`, `severityToSarifSecurity`, `severityToGitlabSeverity`, etc. ≤80 lines. |
| `packages/cli/src/export/fail-on.ts` | `@coder` | `parseFailOn` + `evaluateFailOn`. Pure functions. ≤120 lines. |
| `packages/cli/src/export/sarif.ts` | `@coder` | SARIF 2.1.0 emitter. ≤300 lines. |
| `packages/cli/src/export/github.ts` | `@coder` | Wraps sarif.ts + 5000-truncate + path-relativity warn. ≤80 lines. |
| `packages/cli/src/export/gitlab.ts` | `@coder` | GitLab Security Report 15.0.0 emitter. ≤200 lines. |
| `packages/cli/src/export/csv.ts` | `@coder` | RFC 4180 CSV. ≤100 lines. |
| `packages/cli/src/export/linear.ts` | `@coder` | Linear `IssueCreateInput` drafts. ≤200 lines. |
| `packages/cli/src/export/jira.ts` | `@coder` | Jira issue drafts + Markdown→ADF helper. ≤250 lines. |
| `packages/cli/src/export/index.ts` | `@coder` | `export type ExportFormat` + dispatch table. ≤60 lines. |
| `packages/cli/src/export/severity.test.ts` | `@qa` | Severity helpers + registry exhaustiveness. |
| `packages/cli/src/export/sarif.test.ts` | `@qa` | ajv schema validation; fixture-based round-trip. |
| `packages/cli/src/export/csv.test.ts` | `@qa` | RFC 4180 round-trip. |
| `packages/cli/src/export/gitlab.test.ts` | `@qa` | Schema-shape assertion. |
| `packages/cli/src/export/linear.test.ts` | `@qa` | Draft shape + priority mapping. |
| `packages/cli/src/export/jira.test.ts` | `@qa` | ADF subset assertion. |
| `packages/cli/src/export/fail-on.test.ts` | `@qa` | Parser + evaluator unit tests. |
| `packages/cli/src/cli/export.ts` | `@coder` | `bughunter export` CLI handler. ≤120 lines. |
| `packages/cli/src/cli/ci.ts` | `@coder` | `bughunter ci` CLI handler — calls `runRun`, then renderSarif + renderSummaryMd, then `evaluateFailOn`. ≤200 lines. |
| `packages/cli/src/cli/publish.ts` | `@coder` | `bughunter publish` CLI handler. Shells to `gh`. ≤80 lines. |
| `packages/cli/src/cli/ci.test.ts` | `@qa` | End-to-end synthetic-run tests (mock filesystem). |
| `fixtures/ci-templates/.github/workflows/bughunter.yml` | `@devops` | §8.1. |
| `fixtures/ci-templates/.gitlab-ci.yml` | `@devops` | §8.2. |
| `fixtures/ci-templates/.circleci/config.yml` | `@devops` | §8.3. |
| `fixtures/ci-templates/Dockerfile` | `@devops` | §8.4. |
| `fixtures/ci-templates/README.md` | `@devops` | "Pick one and copy" instructions. ≤80 lines. |

### 13.2 Modified files

| Path | Why | Surface |
|---|---|---|
| `packages/cli/src/types.ts` | Add `Severity`, `ExploitabilityModel`. Add `bySeverity` to `RunSummary`. Add optional `severity` to `BugCluster`. | +25 lines. |
| `packages/cli/src/detectors/registry.ts` | Extend `DetectorMetadata` with severity/cwe/exploitabilityModel/helpUri. Populate every BugKind per §3.2 table. | +180 lines (table-heavy). |
| `packages/cli/src/phases/emit.ts` | Decorate clusters with severity. Accumulate `bySeverity`. Persist to `summary.json` and `bugs.jsonl`. | +25 lines. |
| `packages/cli/src/store/filesystem.ts` | Add `exportsDir` to `RunPaths`. Ensure-create in `ensureRunDirs`. | +5 lines. |
| `packages/cli/src/cli/main.ts` | Dispatch `export`, `ci`, `publish`. Update USAGE. | +30 lines. |
| `package.json` | Add `ajv` and `@types/sarif` (devDeps for tests). Bump version. | +3 lines. |

### 13.3 DO NOT modify

- `packages/cli/src/phases/classify.ts` — `KIND_PRIORITY` is unchanged.
- `packages/cli/src/phases/cluster.ts` — minting unchanged.
- `packages/cli/src/cli/run.ts` — `bughunter ci` calls `runRun`; do not fork the run pipeline.
- Existing run JSONL on disk — backward compat by construction (severity decorated forward only).

---

## 14. Task breakdown

Sized for ≤30 min human-equivalent. Each row is independently verifiable.

| # | Task | Assignee | Deps | Files | Test |
|---|---|---|---|---|---|
| 1 | Add `Severity` + `ExploitabilityModel` types; add `bySeverity` to `RunSummary`; add optional `severity` to `BugCluster`. | @coder | none | `packages/cli/src/types.ts` | `npx tsc --noEmit` |
| 2 | Extend `DetectorMetadata` shape with severity/cwe/exploitabilityModel/helpUri. | @coder | 1 | `packages/cli/src/detectors/registry.ts` | tsc |
| 3 | Populate `DETECTOR_REGISTRY` with severity for every BugKind per §3.2 table. | @coder | 2 | `packages/cli/src/detectors/registry.ts` | unit test: every BugKind key present + severity set |
| 4 | Add `severity.ts` helper module: `severityForCluster`, `severityToSarifLevel`, `severityToSarifSecurity`, `severityToGitlabSeverity`. | @coder | 3 | `packages/cli/src/export/severity.ts`, `severity.test.ts` | `npx vitest run src/export/severity.test.ts` |
| 5 | Decorate clusters at emit time; populate `summary.bySeverity`. | @coder | 1, 4 | `packages/cli/src/phases/emit.ts` | regression smoke (existing run produces `bySeverity` key) |
| 6 | Add `exportsDir` to `runPaths` and `ensureRunDirs`. | @coder | 1 | `packages/cli/src/store/filesystem.ts` | tsc + existing fs tests |
| 7 | SARIF 2.1.0 emitter (pure-function `renderSarif(clusters, state): SarifLog`). | @coder | 4 | `packages/cli/src/export/sarif.ts` | `sarif.test.ts` (ajv schema validation) |
| 8 | GitHub-flavoured wrapper (truncate-5000 + path-warn). | @coder | 7 | `packages/cli/src/export/github.ts` | unit test |
| 9 | GitLab Security Report 15.0.0 emitter. | @coder | 4 | `packages/cli/src/export/gitlab.ts`, `gitlab.test.ts` | unit test |
| 10 | CSV emitter (RFC 4180). | @coder | 4 | `packages/cli/src/export/csv.ts`, `csv.test.ts` | round-trip test |
| 11 | Linear `IssueCreateInput[]` emitter. | @coder | 4 | `packages/cli/src/export/linear.ts`, `linear.test.ts` | unit test |
| 12 | Jira issue-draft emitter + Markdown-to-ADF helper. | @coder | 4 | `packages/cli/src/export/jira.ts`, `jira.test.ts` | unit test |
| 13 | `ExportFormat` union + dispatch in `export/index.ts`. | @coder | 7-12 | `packages/cli/src/export/index.ts` | tsc + unit |
| 14 | `bughunter export` CLI handler. | @coder | 13, 6 | `packages/cli/src/cli/export.ts`, `cli/main.ts` | manual smoke |
| 15 | `parseFailOn` + `evaluateFailOn` (pure). | @coder | 4 | `packages/cli/src/export/fail-on.ts`, `fail-on.test.ts` | unit test (covers all FailOnRule variants + bad input) |
| 16 | `summary.md` renderer (pure). | @coder | 4, 15 | `packages/cli/src/export/summary-md.ts`, `summary-md.test.ts` | unit test |
| 17 | `bughunter ci` CLI handler — calls `runRun`, renderSarif, renderSummaryMd, evaluateFailOn. | @coder | 7, 14, 15, 16 | `packages/cli/src/cli/ci.ts`, `cli/main.ts`, `cli/ci.test.ts` | unit + manual smoke (§12) |
| 18 | `bughunter publish` CLI handler — shells to `gh`. | @coder | 14 | `packages/cli/src/cli/publish.ts`, `cli/main.ts`, `cli/publish.test.ts` | unit (mocked which) |
| 19 | CI templates (4 files + README). | @devops | 17, 18 | `fixtures/ci-templates/**` | actionlint + manual lint per template |
| 20 | Manual end-to-end smoke against TraiderJo run. | @qa | 1-19 | (none — runbook §12) | manual verification of A1-A19 |

---

## 15. Risks + escape hatches

- **Risk: SARIF schema drift between SARIF 2.1.0 OS and GitHub's accepted subset.** GitHub historically tolerates SARIF 2.1.0 with their additional `security-severity` property; we test against both the official schema (ajv) and the actual `gh code-scanning upload-sarif --dry-run`. Escape: if a real upload fails, capture the error and ship a follow-up patch.
- **Risk: severity assignments in §3.2 are wrong for somebody's risk model.** v0.30 will add per-cluster severity overrides via `.bughunter/suppressions.json`. v0.29's table is the BugHunter default; expect some teams to re-grade.
- **Risk: GitHub's 5000-result limit hides real findings.** Mitigation: `summary.md` always shows the full count; the truncated SARIF is a presentation artifact, not the source of truth. We do NOT truncate `bugs.jsonl`.
- **Risk: ajv adds 150 KB to the bundle.** Justified — SARIF compliance is a hard acceptance gate; unit tests need the schema validator. Lift to devDep so it's not in the published bundle.
- **Risk: `gh code-scanning upload-sarif` requires `security-events: write` permission, which org-wide policies may forbid.** Document in template comments; no code change.
- **Risk: a future BugKind is added without a registry entry.** TS exhaustiveness check (`Record<BugKind, DetectorMetadata>`) makes this a compile error. Tested in A1.

---

## 16. Negative requirements (recap)

- Do **not** define severity per-detection (only per-kind via registry).
- Do **not** mutate existing on-disk JSONL.
- Do **not** introduce a Linear/Jira HTTP client.
- Do **not** depend on `gh` CLI being installed.
- Do **not** add a Markdown library — render `summary.md` and ADF by hand.
- Do **not** silently swallow `gh` failures — propagate exit code from `gh` to BugHunter's process.
- Do **not** truncate `bugs.jsonl` ever.
- Do **not** add a runtime SARIF schema validator — ajv is dev-only.
- Do **not** change `KIND_PRIORITY`; severity and priority are orthogonal.
- Do **not** parse user-supplied SARIF files; we are emit-only in v0.29.

---

## 17. Definition of Done

- [ ] All 20 tasks in §14 complete.
- [ ] `npx tsc --noEmit` clean.
- [ ] `npx eslint . --max-warnings 0` clean.
- [ ] `npx vitest run` passes (every new test green).
- [ ] Acceptance matrix §11 hard gates (A4, A5, A9-A11, A15, A16) pass.
- [ ] §12 manual smoke runbook executes top-to-bottom on TraiderJo run.
- [ ] `npm run build` succeeds.
- [ ] Spec drift review by `@architect` confirms no new files outside §13.1, no new deps beyond `ajv` + `@types/sarif`.

---

## 18. Open questions

1. **OQ-1 — severity for `console_error` and `accessibility_critical`.** Both are catch-alls. v0.29 spec settles on `minor` for both. Brad: confirm or escalate to `major`. If `major`, expect louder PR-comment summaries on legacy projects. Recommend keeping `minor` until a calibration phase says otherwise.

2. **OQ-2 — `partialFingerprints.bugIdentity`.** SARIF allows multiple fingerprint algorithms. v0.29 emits one (`bughunter.clusterSignature/v1`). Should we also emit a `primaryLocationLineHash` (SARIF §3.27.18 standard)? Pro: GitHub uses this for cross-run dedup. Con: we don't have line numbers, so the hash is over file path + rule id which is weaker than `signatureKey`. Recommend defer to v0.30.

3. **OQ-3 — line-number attribution.** `cluster.suspectedFiles` is files-only; SARIF's `physicalLocation.region` (§3.30) wants line/column. v0.29 omits region — `helpfulness vs precision` tradeoff. v0.30 should populate region from the first occurrence's stack-trace top frame for kinds that have stacks.

4. **OQ-4 — `--upload` default.** Spec brief implies `bughunter ci` does NOT upload by default. Confirmed in §6.1. `--upload` is opt-in; CI templates explicitly call `bughunter publish` after `bughunter ci`.

5. **OQ-5 — backporting `bySeverity` to old runs.** Should `bughunter export` on a pre-v0.29 run also rewrite the run's `summary.json` to add `bySeverity`? **No.** Export is read-only on the run dir; `summary.json` is immutable post-emit. The export emits its own derived severity counts inside SARIF/CSV/etc.

6. **OQ-6 — `keyboard_trap` severity.** v0.29 says `major`. Some teams treat A11y blockers as `critical` (keyboard-only users cannot use the page at all). Decision deferred to per-team override (v0.30).

7. **OQ-7 — `vulnerable_dependency_high` severity.** v0.29 says `major`. npm-audit's `--audit-level=critical` would also fire this kind; should those be promoted to `critical`? Suggest: yes, when `cluster.staticContext.tool === 'npm-audit'` AND `cluster.evidence?.advisorySeverity === 'critical'`. Defer to v0.30 as a registry-side override hook.

8. **OQ-8 — Dockerfile bundle size.** Current ~1.2 GB with Playwright deps + Node 20. Acceptable for v0.29; further slimming (multi-arch, alpine-based) is v0.31+.
